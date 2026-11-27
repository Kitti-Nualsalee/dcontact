import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { PrismaClient } from '@d-contact/db';
import { E1EslCommandClient } from './e1-esl-command-client.js';
import {
  ManagedVoiceTelephony,
  routeManagedCall,
  TenantSipDomainDirectory,
} from './managed-voice-telephony.js';

const nodeId = 'fs-it-979';
const applicationUrl =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function managedTenant(owner: PrismaClient, label: string, agents = 1) {
  const tenantId = randomUUID(),
    teamId = randomUUID(),
    queueId = randomUUID(),
    skillId = randomUUID(),
    destinationId = randomUUID();
  const sipDomain = `${label}-${tenantId.slice(0, 8)}.it979.test`;
  await owner.tenant.create({
    data: { id: tenantId, name: `#979 ${label}`, slug: `it979-${tenantId}`, sipDomain },
  });
  await owner.team.create({ data: { id: teamId, tenantId, name: 'Routing' } });
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
  await owner.skill.create({
    data: {
      id: skillId,
      tenantId,
      teamId,
      code: 'ROUTING',
      name: 'Routing',
      voiceConfigVersion: 1,
    },
  });
  await owner.queueSkill.create({ data: { tenantId, queueId, skillId, minLevel: 1 } });
  await owner.$executeRaw`INSERT INTO voice_managed_queue_policies(tenant_id,queue_id) VALUES(${tenantId}::uuid,${queueId}::uuid)`;
  await owner.voiceDestination.create({
    data: { id: destinationId, tenantId, queueId, destination: '2000' },
  });
  await owner.$executeRaw`INSERT INTO tenant_voice_provisioning_policies(tenant_id,revision,source_kind,accounts_limit,agents_limit,voice_queues_limit,skills_limit,approved_by_operator_subject,approved_at,approval_ref,reason,destination_pool)
    VALUES(${tenantId}::uuid,1,'UAT_EXPLICIT',10,10,10,10,'test',clock_timestamp(),'test','test',${JSON.stringify([{ destinationId, telephonyNodeId: nodeId }])}::jsonb)`;
  for (let index = 0; index < agents; index++) {
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
        extension: `110${index}`,
      },
    });
    await owner.agentSkill.create({ data: { tenantId, userId: agentId, skillId, level: 1 } });
    await owner.agentStateLog.create({ data: { tenantId, userId: agentId, state: 'AVAILABLE' } });
  }
  return { tenantId, sipDomain };
}

/** A TCP fake FreeSWITCH ESL that answers like a real switch well enough for the adapter to make an offer */
function fakeSwitch(password: string) {
  const channels = new Map<string, Record<string, string>>();
  const globals = new Map<string, string>();
  const originates: string[] = [];
  const kills: string[] = [];
  const refuseKill = new Set<string>();
  const server = net.createServer((socket) => {
    socket.write('Content-Type: auth/request\n\n');
    let authenticated = false;
    let buffer = '';
    const reply = (body: string) =>
      socket.write(
        `Content-Type: api/response\nContent-Length: ${Buffer.byteLength(body)}\n\n${body}`,
      );
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes('\n\n')) {
        const separator = buffer.indexOf('\n\n');
        const request = buffer.slice(0, separator).trim();
        buffer = buffer.slice(separator + 2);
        if (!authenticated) {
          authenticated = request === `auth ${password}`;
          socket.write(
            `Content-Type: command/reply\nReply-Text: ${authenticated ? '+OK accepted' : '-ERR invalid'}\n\n`,
          );
          continue;
        }
        const [kind, action, channel, name, ...rest] = request.split(' ');
        if (kind === 'bgapi' && action === 'originate') {
          originates.push(request);
          const variables = Object.fromEntries(
            [...request.matchAll(/([a-z_]+)=([^,}]+)/g)].map((match) => [match[1], match[2]]),
          );
          channels.set(variables.origination_uuid, variables);
          socket.write(
            `Content-Type: command/reply\nReply-Text: +OK Job-UUID: ${randomUUID()}\n\n`,
          );
          continue;
        }
        if (action === 'status')
          reply('UP 0 years, 0 days, 1 hour\nFreeSWITCH (Version 1.10) is ready');
        else if (action === 'uuid_kill') {
          kills.push(`${channel} ${name}`);
          if (refuseKill.has(channel)) reply('-ERR kill refused');
          else reply(channels.delete(channel) ? '+OK' : '-ERR No such channel!');
        } else if (action === 'uuid_exists') reply(String(channels.has(channel)));
        else if (action === 'uuid_getvar') reply(channels.get(channel)?.[name] ?? '_undef_');
        else if (action === 'uuid_setvar') {
          const target = channels.get(channel);
          if (target) target[name] = rest.join(' ');
          reply(target ? '+OK' : '-ERR No such channel!');
        } else if (action === 'global_getvar') reply(globals.get(channel) ?? '');
        else if (action === 'global_setvar') {
          const index = channel.indexOf('=');
          globals.set(channel.slice(0, index), channel.slice(index + 1));
          reply('+OK');
        } else reply('-ERR unexpected request');
      }
    });
  });
  return { server, channels, originates, kills, refuseKill };
}

async function until(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('#979 main.ts managed: heartbeat and offer per tenant use the SIP domain of that tenant', async (context) => {
  const owner = new PrismaClient();
  const database = new PrismaClient({ datasources: { db: { url: applicationUrl } } });
  const dispatchDatabase = new PrismaClient({ datasources: { db: { url: applicationUrl } } });
  const fake = fakeSwitch('fixture-979');
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = fake.server.address() as net.AddressInfo;
  const alpha = await managedTenant(owner, 'alpha', 2);
  const beta = await managedTenant(owner, 'beta');
  const errors: unknown[] = [];
  const managed = new ManagedVoiceTelephony({
    nodeId,
    database,
    dispatchDatabase,
    esl: new E1EslCommandClient({ host: '127.0.0.1', port: address.port, password: 'fixture-979' }),
    directory: new TenantSipDomainDirectory(database),
    log: (_message, error) => errors.push(error),
  });
  context.after(async () => {
    await managed.stop();
    fake.server.close();
    await Promise.all([
      owner.$disconnect(),
      database.$disconnect(),
      dispatchDatabase.$disconnect(),
    ]);
  });

  const readiness = async (tenantId: string) =>
    (
      await owner.$queryRaw<
        { wired: boolean }[]
      >`SELECT (direct_wired AND expires_at > clock_timestamp()) AS wired
        FROM voice_managed_runtime_readiness WHERE tenant_id=${tenantId}::uuid AND telephony_node_id=${nodeId}`
    )[0]?.wired === true;

  // ESL subscription not confirmed yet: must not announce readiness
  managed.start();
  await delay(2_500);
  assert.equal(await readiness(alpha.tenantId), false);
  managed.setSubscribed(true);
  await until(
    async () => (await readiness(alpha.tenantId)) && (await readiness(beta.tenantId)),
    'readiness heartbeat of both tenants',
  );

  const callers = { alpha: randomUUID(), beta: randomUUID(), crossed: randomUUID() };
  fake.channels.set(callers.alpha, { domain_name: alpha.sipDomain });
  fake.channels.set(callers.beta, { domain_name: beta.sipDomain });
  // A call from the domain of beta but sent as tenant alpha must not be bound or originated
  fake.channels.set(callers.crossed, { domain_name: beta.sipDomain });
  const created = (callUuid: string) => ({
    'Event-Name': 'CHANNEL_CREATE',
    'Unique-ID': callUuid,
    'Caller-Destination-Number': '2000',
    'Caller-Caller-ID-Number': '0811111111',
  });
  const routing = managed.routing;
  assert.equal(await routeManagedCall(created(callers.alpha), alpha.tenantId, routing), 'managed');
  assert.equal(await routeManagedCall(created(callers.beta), beta.tenantId, routing), 'managed');
  assert.equal(
    await routeManagedCall(created(callers.crossed), alpha.tenantId, routing),
    'managed',
  );
  // A number not bound to a managed queue goes back to legacy
  assert.equal(
    await routeManagedCall(
      { ...created(randomUUID()), 'Caller-Destination-Number': '2001' },
      alpha.tenantId,
      routing,
    ),
    'legacy',
  );

  await until(() => fake.originates.length >= 2, 'offer originate for both tenants');
  await delay(2_000);
  const forTenant = (tenantId: string) =>
    fake.originates.filter((value) => value.includes(`dcontact_tenant_id=${tenantId}`));
  const [alphaOffer] = forTenant(alpha.tenantId);
  const [betaOffer] = forTenant(beta.tenantId);
  assert.match(alphaOffer, new RegExp(`dcontact_call_uuid=${callers.alpha}`));
  assert.match(alphaOffer, new RegExp(`domain_name=${alpha.sipDomain.replaceAll('.', '\\.')}[,}]`));
  assert.match(
    alphaOffer,
    new RegExp(`\\}user/110[01]@${alpha.sipDomain.replaceAll('.', '\\.')} &park\\(\\)$`),
  );
  assert.match(betaOffer, new RegExp(`dcontact_call_uuid=${callers.beta}`));
  assert.ok(betaOffer.endsWith(`user/1100@${beta.sipDomain} &park()`));
  assert.equal(
    fake.originates.some((value) => value.includes(callers.crossed)),
    false,
  );
  assert.equal(fake.originates.length, 2);
  assert.equal(fake.channels.get(callers.alpha)?.dcontact_tenant_id, alpha.tenantId);
  assert.equal(fake.channels.get(callers.beta)?.dcontact_tenant_id, beta.tenantId);
  assert.equal(fake.channels.get(callers.crossed)?.dcontact_tenant_id, undefined);
  const [crossedCommand] = await owner.$queryRaw<{ status: string; lastError: string | null }[]>`
    SELECT status,last_error AS "lastError" FROM voice_managed_commands
    WHERE tenant_id=${alpha.tenantId}::uuid AND call_uuid=${callers.crossed} AND command_type='offer.create'`;
  assert.deepEqual(crossedCommand, { status: 'PENDING', lastError: 'DIRECT_PORT_UNCONFIRMED' });

  // After closing, readiness is withdrawn at once without waiting for the TTL
  await managed.stop();
  assert.equal(await readiness(alpha.tenantId), false);
  assert.equal(await readiness(beta.tenantId), false);
});

test('a managed destination whose call.created fails twice is hung up instead of parked on legacy', async (context) => {
  const owner = new PrismaClient();
  const database = new PrismaClient({ datasources: { db: { url: applicationUrl } } });
  const fake = fakeSwitch('fixture-979');
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = fake.server.address() as net.AddressInfo;
  const alpha = await managedTenant(owner, 'alpha');
  const beta = await managedTenant(owner, 'beta');
  const managed = new ManagedVoiceTelephony({
    nodeId,
    database,
    dispatchDatabase: database,
    esl: new E1EslCommandClient({ host: '127.0.0.1', port: address.port, password: 'fixture-979' }),
    directory: new TenantSipDomainDirectory(database),
    log: () => undefined,
  });
  context.after(async () => {
    fake.server.close();
    await Promise.all([owner.$disconnect(), database.$disconnect()]);
  });
  // The runtime itself fails (e.g. a bug or a lock timeout), the destination lookup still works
  const routing = {
    ...managed.routing,
    handle: async () => {
      throw new Error('runtime failed');
    },
  };
  const created = (callUuid: string, destination: string) => ({
    'Event-Name': 'CHANNEL_CREATE',
    'Unique-ID': callUuid,
    'Caller-Destination-Number': destination,
    'Caller-Caller-ID-Number': '0811111111',
  });
  const managedCaller = randomUUID();
  fake.channels.set(managedCaller, { domain_name: alpha.sipDomain });
  assert.equal(
    await routeManagedCall(created(managedCaller, '2000'), alpha.tenantId, routing),
    'ignored',
  );
  assert.deepEqual(fake.kills, [`${managedCaller} NORMAL_TEMPORARY_FAILURE`]);
  // The PARK that follows is not turned into another call.created for the killed channel
  assert.equal(managed.isKnownCall(managedCaller), true);
  assert.equal(
    await routeManagedCall(
      { 'Event-Name': 'CHANNEL_HANGUP_COMPLETE', 'Unique-ID': managedCaller },
      alpha.tenantId,
      routing,
    ),
    'ignored',
  );
  assert.equal(managed.isKnownCall(managedCaller), false);

  // The caller already hung up (-ERR, channel gone): nothing left to park, do not send it to legacy
  assert.equal(
    await routeManagedCall(created(randomUUID(), '2000'), alpha.tenantId, routing),
    'ignored',
  );
  // The kill is refused while the channel still exists: keep the legacy fallback rather than claim it was hung up
  const stubborn = randomUUID();
  fake.channels.set(stubborn, { domain_name: alpha.sipDomain });
  fake.refuseKill.add(stubborn);
  assert.equal(
    await routeManagedCall(created(stubborn, '2000'), alpha.tenantId, routing),
    'legacy',
  );
  assert.equal(managed.isKnownCall(stubborn), false);

  // A number that is not bound to a managed queue of this tenant stays on legacy and is not hung up
  const legacyCaller = randomUUID();
  assert.equal(
    await routeManagedCall(created(legacyCaller, '2001'), alpha.tenantId, routing),
    'legacy',
  );
  // The lookup is scoped to the tenant of the event (where clause under the tenant transaction); beta has no 3000
  await owner.voiceDestination.updateMany({
    where: { tenantId: alpha.tenantId, destination: '2000' },
    data: { destination: '3000' },
  });
  assert.equal(
    await routeManagedCall(created(randomUUID(), '3000'), beta.tenantId, routing),
    'legacy',
  );
  // No kill for the legacy number or the other tenant
  assert.equal(fake.kills.length, 3);
});

test('a managed destination the runtime does not take (inactive) is hung up instead of parked on legacy', async (context) => {
  const owner = new PrismaClient();
  const database = new PrismaClient({ datasources: { db: { url: applicationUrl } } });
  const fake = fakeSwitch('fixture-979');
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  const address = fake.server.address() as net.AddressInfo;
  const alpha = await managedTenant(owner, 'alpha');
  const managed = new ManagedVoiceTelephony({
    nodeId,
    database,
    dispatchDatabase: database,
    esl: new E1EslCommandClient({ host: '127.0.0.1', port: address.port, password: 'fixture-979' }),
    directory: new TenantSipDomainDirectory(database),
    log: () => undefined,
  });
  context.after(async () => {
    fake.server.close();
    await Promise.all([owner.$disconnect(), database.$disconnect()]);
  });
  // The real runtime returns no call for an inactive destination; legacy would still reject it as managed
  await owner.voiceDestination.updateMany({
    where: { tenantId: alpha.tenantId, destination: '2000' },
    data: { isActive: false },
  });
  const caller = randomUUID();
  fake.channels.set(caller, { domain_name: alpha.sipDomain });
  const routing = managed.routing;
  assert.equal(
    await routeManagedCall(
      {
        'Event-Name': 'CHANNEL_CREATE',
        'Unique-ID': caller,
        'Caller-Destination-Number': '2000',
        'Caller-Caller-ID-Number': '0811111111',
      },
      alpha.tenantId,
      routing,
    ),
    'ignored',
  );
  assert.deepEqual(fake.kills, [`${caller} NORMAL_TEMPORARY_FAILURE`]);
  const [interactions] = await owner.$queryRaw<{ count: bigint }[]>`
    SELECT count(*) AS count FROM interactions WHERE tenant_id=${alpha.tenantId}::uuid`;
  assert.equal(Number(interactions.count), 0);
  assert.equal(managed.isKnownCall(caller), true);
});
