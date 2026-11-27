import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { ManagedCallbackError, startManagedCallback } from './managed-callback.js';
import { ManagedVoiceRuntime } from './managed-voice-runtime.js';
import type {
  ManagedVoiceDirectCommand,
  ManagedVoiceDirectPort,
} from './managed-voice-contracts.js';

/** #1061 a callback call on the managed runtime: Agent leg first, bridged to the customer's internal number. */

const url =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';
const owner = new PrismaClient();
const application = new PrismaClient({ datasources: { db: { url } } });
const dispatcher = new PrismaClient({ datasources: { db: { url } } });
after(async () => {
  await Promise.all([owner.$disconnect(), application.$disconnect(), dispatcher.$disconnect()]);
});

const NODE = 'fs-callback';

async function fixture(options: { ready?: boolean } = {}) {
  const tenantId = randomUUID();
  const teamId = randomUUID();
  const queueId = randomUUID();
  const destinationId = randomUUID();
  await owner.tenant.create({
    data: { id: tenantId, name: 'Callback', slug: `cb-${tenantId}`, sipDomain: `${tenantId}.test` },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Care' } });
  await owner.queue.create({
    data: {
      id: queueId,
      tenantId,
      teamId,
      name: 'Managed',
      channels: ['VOICE'],
      voiceConfigVersion: 1,
      voiceWrapupPolicy: 'VOICE_NOTE_V1',
    },
  });
  await owner.$executeRaw`INSERT INTO voice_managed_queue_policies(tenant_id,queue_id) VALUES(${tenantId}::uuid,${queueId}::uuid)`;
  await owner.voiceDestination.create({
    data: { id: destinationId, tenantId, queueId, destination: '2000' },
  });
  await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,destination_pool)
    VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',10,10,10,10,'test',clock_timestamp(),'test','test',${JSON.stringify([{ destinationId, telephonyNodeId: NODE }])}::jsonb)`;
  const agentId = randomUUID();
  await owner.user.create({
    data: {
      id: agentId,
      tenantId,
      teamId,
      role: 'AGENT',
      displayName: 'Agent',
      email: `${agentId}@test.invalid`,
      passwordHash: 'unused',
      extension: '1100',
    },
  });
  await owner.agentStateLog.create({ data: { tenantId, userId: agentId, state: 'AVAILABLE' } });
  const contact = await owner.contact.create({ data: { tenantId, displayName: 'Khun Anan' } });
  const commands: ManagedVoiceDirectCommand[] = [];
  const legs = { callerExists: false, blegExists: true };
  const port: ManagedVoiceDirectPort = {
    readback: async () => legs,
    execute: async (command) => {
      commands.push(command);
      return { confirmed: true };
    },
  };
  const runtime = new ManagedVoiceRuntime(application, port, dispatcher);
  if (options.ready !== false) await runtime.heartbeat(tenantId, NODE);
  const start = () =>
    withTenantDatabaseTransaction(application, tenantId, (transaction) =>
      startManagedCallback(transaction, {
        tenantId,
        queueId,
        agentId,
        contactId: contact.id,
        destination: '1201',
        callbackId: randomUUID(),
      }),
    );
  const interaction = (id: string) => owner.interaction.findUniqueOrThrow({ where: { id } });
  const state = async () =>
    (
      await owner.agentStateLog.findFirst({
        where: { tenantId, userId: agentId },
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      })
    )?.state;
  return {
    tenantId,
    teamId,
    queueId,
    agentId,
    contact,
    commands,
    legs,
    runtime,
    start,
    interaction,
    state,
  };
}

test('dialing rings the Agent first; once the Agent answers the call is ACTIVE without a separate bridge, and ends in wrap-up', async () => {
  const f = await fixture();
  const call = await f.start();
  const created = await f.interaction(call.interactionId);
  assert.equal(created.direction, 'OUTBOUND');
  assert.equal(created.state, 'ASSIGNED');
  assert.equal(created.agentId, f.agentId);
  assert.equal(created.contactId, f.contact.id);
  // the queue records results with VOICE_NOTE_V1, so the callback does as well
  assert.equal(created.voiceWrapupPolicy, 'VOICE_NOTE_V1');
  assert.equal(await f.state(), 'RESERVED');

  await f.runtime.flushCommands(f.tenantId, NODE);
  assert.equal(f.commands.length, 1);
  const originate = f.commands[0]!;
  assert.equal(originate.type, 'callback.originate');
  assert.equal(originate.destination, '1201');
  assert.equal(originate.agentExtension, '1100');
  assert.equal(originate.callUuid, call.callUuid);

  // the Agent answers D-Phone (the offer leg)
  await f.runtime.handle({
    tenantId: f.tenantId,
    telephonyNodeId: NODE,
    callUuid: call.callUuid,
    type: 'call.answered',
    offerId: originate.offerId!,
    agentId: f.agentId,
    blegUuid: originate.blegUuid,
  });
  assert.equal((await f.interaction(call.interactionId)).state, 'ACTIVE');
  assert.equal(await f.state(), 'BUSY');
  const attribution = await owner.voiceInteractionHandlingAttribution.findFirst({
    where: { tenantId: f.tenantId, interactionId: call.interactionId },
  });
  assert.equal(attribution?.teamId, f.teamId);
  // the customer leg is created by FreeSWITCH's bridge: the runtime finds the existing call and adds nothing
  await f.runtime.handle({
    tenantId: f.tenantId,
    telephonyNodeId: NODE,
    callUuid: call.callUuid,
    type: 'call.created',
    destination: '1201',
  });
  // while the customer's phone rings the customer leg may not exist yet: only a missing Agent leg ends the call
  await f.runtime.flushCommands(f.tenantId, NODE);
  assert.deepEqual(
    f.commands.map((command) => command.type),
    ['callback.originate'],
  );
  assert.equal((await f.interaction(call.interactionId)).state, 'ACTIVE');

  // the customer hangs up
  await f.runtime.handle({
    tenantId: f.tenantId,
    telephonyNodeId: NODE,
    callUuid: call.callUuid,
    type: 'call.hangup',
    hangupInitiator: 'caller',
  });
  assert.equal((await f.interaction(call.interactionId)).state, 'WRAPUP');
  assert.equal(await f.state(), 'ACW');
  await f.runtime.flushCommands(f.tenantId, NODE);
  assert.deepEqual(
    f.commands.map((command) => command.type),
    ['callback.originate', 'call.hangup'],
  );
});

test('an Agent who does not answer D-Phone in time ends the attempt; it is never offered to someone else', async () => {
  const f = await fixture();
  const call = await f.start();
  await f.runtime.flushCommands(f.tenantId, NODE);
  await owner.$executeRaw`UPDATE voice_managed_offers SET assigned_at=assigned_at-interval '21 seconds',expires_at=expires_at-interval '21 seconds' WHERE tenant_id=${f.tenantId}::uuid AND interaction_id=${call.interactionId}::uuid`;
  await f.runtime.tick(f.tenantId, NODE);
  const ended = await f.interaction(call.interactionId);
  assert.equal(ended.state, 'ABANDONED');
  assert.equal(ended.agentId, f.agentId);
  const [row] = await owner.$queryRaw<
    { terminal_reason: string }[]
  >`SELECT terminal_reason FROM voice_managed_calls WHERE tenant_id=${f.tenantId}::uuid AND interaction_id=${call.interactionId}::uuid`;
  assert.equal(row!.terminal_reason, 'CALLBACK_NOT_ANSWERED');
  await f.runtime.flushCommands(f.tenantId, NODE);
  assert.ok(f.commands.some((command) => command.type === 'offer.cancel'));
  // the cancel released the Agent, who can dial again
  assert.equal(await f.state(), 'AVAILABLE');
  await f.start();
});

test('the Agent declining D-Phone ends the attempt at once', async () => {
  const f = await fixture();
  const call = await f.start();
  await f.runtime.flushCommands(f.tenantId, NODE);
  const originate = f.commands[0]!;
  await f.runtime.handle({
    tenantId: f.tenantId,
    telephonyNodeId: NODE,
    callUuid: call.callUuid,
    type: 'call.hangup',
    offerId: originate.offerId!,
    agentId: f.agentId,
    blegUuid: originate.blegUuid,
  });
  assert.equal((await f.interaction(call.interactionId)).state, 'ABANDONED');
});

test('dialing needs a Ready Agent with no other work and a managed runtime that is up', async () => {
  const f = await fixture();
  await f.start();
  // the Agent now holds the first attempt
  await assert.rejects(
    f.start(),
    (error: unknown) =>
      error instanceof ManagedCallbackError && error.code === 'AGENT_NOT_AVAILABLE',
  );
  const down = await fixture({ ready: false });
  await assert.rejects(
    down.start(),
    (error: unknown) => error instanceof ManagedCallbackError && error.code === 'VOICE_NOT_READY',
  );
  const away = await fixture();
  await owner.agentStateLog.create({
    data: { tenantId: away.tenantId, userId: away.agentId, state: 'BREAK' },
  });
  await assert.rejects(
    away.start(),
    (error: unknown) =>
      error instanceof ManagedCallbackError && error.code === 'AGENT_NOT_AVAILABLE',
  );
  assert.equal(await owner.interaction.count({ where: { tenantId: away.tenantId } }), 0);
});
