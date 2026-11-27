/**
 * #1061 a callback call against real FreeSWITCH and SIPp (started by scripts/callback-acceptance.mjs):
 * the Agent leg rings first, then FreeSWITCH bridges the customer's internal number. Runtime with the real
 * ESL adapter, PostgreSQL with the NOBYPASSRLS application role; no mocks of SIP.
 */
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { appendFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { startManagedCallback } from '../src/managed-callback.js';
import { ManagedVoiceRuntime } from '../src/managed-voice-runtime.js';
import type {
  ManagedVoiceDirectCommand,
  ManagedVoiceEvent,
} from '../src/managed-voice-contracts.js';

const evidence = process.env.CALLBACK_EVIDENCE!;
const nodeId = 'managed-local';
const wait = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const source = (name: string) => new URL(`../../telephony/src/${name}.ts`, import.meta.url).href;
const { E1EslCommandClient } = await import(source('e1-esl-command-client'));
const { FreeSwitchManagedVoiceAdapter } = await import(source('managed-voice-adapter'));
const { normalizeManagedVoiceEvent } = await import(source('managed-voice-events'));
const eslPort = Number(process.env.CALLBACK_ESL_PORT);
const esl = new E1EslCommandClient({
  host: '127.0.0.1',
  port: eslPort,
  password: 'managed-local-only',
});
const adapter = new FreeSwitchManagedVoiceAdapter(esl, nodeId, 'managed.test');
const audit = (value: unknown) =>
  appendFileSync(resolve(evidence, 'runtime.jsonl'), `${JSON.stringify(value)}\n`);

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: { db: { url: process.env.APPLICATION_DATABASE_URL! } },
});
const dispatcher = new PrismaClient({
  datasources: { db: { url: process.env.APPLICATION_DATABASE_URL! } },
});
const [role] = await application.$queryRaw<{ role: string; bypass: boolean }[]>`
  SELECT current_user AS role, rolbypassrls AS bypass FROM pg_roles WHERE rolname = current_user`;
assert.equal(role.role, 'dcontact_app');
assert.equal(role.bypass, false);

// ── fixture: one tenant, a managed voice queue, three Agents, one customer with two numbers ──
const tenantId = randomUUID();
await owner.tenant.create({
  data: { id: tenantId, name: 'Callback', slug: `callback-${tenantId}`, sipDomain: 'managed.test' },
});
const team = await owner.team.create({ data: { tenantId, name: 'Care' } });
const queue = await owner.queue.create({
  data: {
    tenantId,
    teamId: team.id,
    name: 'Managed',
    channels: ['VOICE'],
    voiceConfigVersion: 1,
    voiceWrapupPolicy: 'VOICE_NOTE_V1',
  },
});
await owner.$executeRaw`INSERT INTO voice_managed_queue_policies(tenant_id,queue_id) VALUES(${tenantId}::uuid,${queue.id}::uuid)`;
const destination = await owner.voiceDestination.create({
  data: { tenantId, queueId: queue.id, destination: '2000' },
});
await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,destination_pool)
  VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',10,10,10,10,'acceptance',clock_timestamp(),'acceptance','acceptance',${JSON.stringify([{ destinationId: destination.id, telephonyNodeId: nodeId }])}::jsonb)`;
const agents: Record<string, string> = {};
for (const extension of ['1001', '1002', '1003']) {
  const user = await owner.user.create({
    data: {
      tenantId,
      teamId: team.id,
      role: 'AGENT',
      displayName: `Agent ${extension}`,
      email: `${extension}-${tenantId}@test.invalid`,
      passwordHash: 'unused',
      extension,
    },
  });
  await owner.agentStateLog.create({ data: { tenantId, userId: user.id, state: 'AVAILABLE' } });
  agents[extension] = user.id;
}
const contact = await owner.contact.create({
  data: { tenantId, displayName: 'Acceptance customer' },
});

// ── runtime with the real adapter and the real event socket ──
const runtime = new ManagedVoiceRuntime(
  application,
  {
    readback: (command: ManagedVoiceDirectCommand) => adapter.readback(command),
    async execute(command: ManagedVoiceDirectCommand) {
      audit({ at: new Date(), command });
      const result = await adapter.execute(command);
      audit({
        at: new Date(),
        commandResult: { commandId: command.commandId, type: command.type, ...result },
      });
      return result;
    },
  },
  dispatcher,
);
assert.equal(await adapter.ready(), true);
let work = Promise.resolve();
const enqueue = (action: () => Promise<unknown>) => {
  work = work
    .then(async () => {
      await action();
    })
    .catch((error: Error) => {
      audit({ fatal: String(error), stack: error.stack });
      console.error(error);
      process.exit(1);
    });
};
const socket = net.createConnection({ host: '127.0.0.1', port: eslPort });
let buffer = Buffer.alloc(0);
let stage = 0;
socket.on('data', (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf('\n\n');
    if (end < 0) return;
    const header = buffer.subarray(0, end).toString();
    const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? 0);
    if (buffer.length < end + 2 + length) return;
    const body = buffer.subarray(end + 2, end + 2 + length).toString();
    buffer = buffer.subarray(end + 2 + length);
    if (stage === 0) {
      socket.write('auth managed-local-only\n\n');
      stage = 1;
      continue;
    }
    if (stage === 1) {
      assert.match(header, /\+OK accepted/);
      socket.write(
        'event json CHANNEL_ANSWER CHANNEL_BRIDGE CHANNEL_HANGUP_COMPLETE BACKGROUND_JOB\n\n',
      );
      stage = 2;
      continue;
    }
    if (!body || !/text\/event-json/.test(header)) continue;
    const event = JSON.parse(body);
    if (event['Event-Name'] === 'BACKGROUND_JOB') {
      enqueue(() => adapter.backgroundJob(event['Job-UUID']));
      continue;
    }
    if (event.variable_dcontact_tenant_id !== tenantId) continue;
    enqueue(async () => {
      const normalized: ManagedVoiceEvent | undefined = normalizeManagedVoiceEvent(
        event,
        tenantId,
        nodeId,
      );
      audit({
        at: new Date(),
        raw: { name: event['Event-Name'], leg: event['Unique-ID'], cause: event['Hangup-Cause'] },
        event: normalized,
      });
      if (normalized) await runtime.handle(normalized);
    });
  }
});
let busy = false;
const pump = setInterval(() => {
  if (busy) return;
  busy = true;
  void (async () => {
    await runtime.heartbeat(tenantId, nodeId);
    await runtime.tick(tenantId, nodeId);
    await runtime.flushCommands(tenantId, nodeId);
  })()
    .catch((error: Error) => audit({ pumpRetry: String(error) }))
    .finally(() => {
      busy = false;
    });
}, 200);
await runtime.heartbeat(tenantId, nodeId);
await wait(500);

async function until<T>(read: () => Promise<T>, accept: (value: T) => boolean, timeout: number) {
  const end = Date.now() + timeout;
  let last: T | undefined;
  while (Date.now() < end) {
    last = await read();
    if (accept(last)) return last;
    await wait(200);
  }
  throw new Error(`waiting exceeded ${timeout}ms; last ${JSON.stringify(last)}`);
}
const call = (interactionId: string) =>
  owner.$queryRaw<
    { state: string; answered: boolean; reason: string | null; attribution: number }[]
  >`
    SELECT i.state::text AS state, (i.answered_at IS NOT NULL) AS answered, c.terminal_reason AS reason,
      (SELECT count(*)::int FROM voice_interaction_handling_attributions a WHERE a.tenant_id=i.tenant_id AND a.interaction_id=i.id) AS attribution
      FROM interactions i JOIN voice_managed_calls c ON c.tenant_id=i.tenant_id AND c.interaction_id=i.id
     WHERE i.id=${interactionId}::uuid`.then((rows) => rows[0]!);
const start = (agent: string, number: string) =>
  withTenantDatabaseTransaction(application, tenantId, (transaction) =>
    startManagedCallback(transaction, {
      tenantId,
      queueId: queue.id,
      agentId: agents[agent]!,
      contactId: contact.id,
      destination: number,
      callbackId: randomUUID(),
    }),
  );
async function legsGone(started: { interactionId: string; callUuid: string }) {
  const [command] = await owner.$queryRaw<{ payload: ManagedVoiceDirectCommand }[]>`
    SELECT payload FROM voice_managed_commands WHERE tenant_id=${tenantId}::uuid AND interaction_id=${started.interactionId}::uuid AND command_type='callback.originate'`;
  return until(
    () => adapter.readback(command!.payload),
    (legs) => !legs.callerExists && !legs.blegExists,
    15000,
  );
}
const cases: { name: string; detail: unknown }[] = [];

// 1. the Agent answers, the customer answers and hangs up after 3 seconds
{
  const started = await start('1001', '1201');
  const active = await until(
    () => call(started.interactionId),
    (row) => row.state === 'ACTIVE',
    25000,
  );
  assert.equal(active.attribution, 1);
  const ended = await until(
    () => call(started.interactionId),
    (row) => row.state === 'WRAPUP',
    25000,
  );
  assert.equal(ended.answered, true);
  assert.equal(ended.reason, 'CALLER_HANGUP');
  const legs = await legsGone(started);
  const [{ policy }] = await owner.$queryRaw<
    { policy: string }[]
  >`SELECT voice_wrapup_policy::text AS policy FROM interactions WHERE id=${started.interactionId}::uuid`;
  assert.equal(policy, 'VOICE_NOTE_V1');
  cases.push({
    name: 'agent-answers-customer-answers-and-hangs-up',
    detail: { ended, legs, policy },
  });
}

// 2. the Agent answers but the customer is busy: the attempt ends in wrap-up for the Agent to record it
{
  const started = await start('1003', '1202');
  await until(
    () => call(started.interactionId),
    (row) => row.answered,
    25000,
  );
  const ended = await until(
    () => call(started.interactionId),
    (row) => row.state === 'WRAPUP',
    25000,
  );
  const legs = await legsGone(started);
  cases.push({ name: 'agent-answers-customer-busy-wrapup', detail: { ended, legs } });
}

// 3. the Agent does not answer D-Phone within 20 seconds: the call is abandoned, never offered to another Agent
{
  const started = await start('1002', '1201');
  const ended = await until(
    () => call(started.interactionId),
    (row) => row.state === 'ABANDONED',
    35000,
  );
  assert.equal(ended.answered, false);
  assert.equal(ended.reason, 'CALLBACK_NOT_ANSWERED');
  const legs = await legsGone(started);
  const [{ offers }] = await owner.$queryRaw<
    { offers: number }[]
  >`SELECT count(*)::int AS offers FROM voice_managed_offers WHERE tenant_id=${tenantId}::uuid AND interaction_id=${started.interactionId}::uuid`;
  assert.equal(offers, 1);
  cases.push({ name: 'agent-no-answer-abandoned-not-reoffered', detail: { ended, legs, offers } });
}

writeFileSync(resolve(evidence, 'result.json'), JSON.stringify({ status: 'PASS', cases }, null, 2));
clearInterval(pump);
socket.destroy();
await Promise.all([owner.$disconnect(), application.$disconnect(), dispatcher.$disconnect()]);
process.exit(0);
