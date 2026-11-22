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

/** FreeSWITCH ESL จำลองแบบ TCP ที่ตอบเหมือน switch จริงพอให้ adapter ทำ offer ได้ */
function fakeSwitch(password: string) {
  const channels = new Map<string, Record<string, string>>();
  const globals = new Map<string, string>();
  const originates: string[] = [];
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
        else if (action === 'uuid_exists') reply(String(channels.has(channel)));
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
  return { server, channels, originates };
}

async function until(check: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(200);
  }
  assert.fail(`timed out waiting for ${label}`);
}

test('#979 main.ts managed: heartbeat และ offer ต่อ tenant ใช้ SIP domain ของ tenant นั้น', async (context) => {
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

  // ยังไม่ยืนยัน ESL subscription: ห้ามประกาศ readiness
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
  // สายที่มาจาก domain ของ beta แต่ถูกส่งเป็น tenant alpha ต้องไม่ถูกผูกหรือ originate
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
  // เบอร์ที่ไม่ได้ผูกคิว managed กลับไป legacy
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

  // ปิดแล้วถอน readiness ทันทีโดยไม่รอ TTL
  await managed.stop();
  assert.equal(await readiness(alpha.tenantId), false);
  assert.equal(await readiness(beta.tenantId), false);
});
