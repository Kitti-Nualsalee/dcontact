import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import { configuredAgentSipCredentialService } from './agent-sip-credentials.js';
import { WorkSessionLeases } from './work-session.js';

const owner = new PrismaClient();
const application = new PrismaClient({
  datasources: {
    db: {
      url:
        process.env.APPLICATION_DATABASE_URL ??
        'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
    },
  },
});

test('credential หมุนได้ระหว่างสายโดยไม่ flush; takeover เพิกถอนชุดเก่าและ directory เห็นเฉพาะ lease ใหม่', async (t) => {
  const tenantId = randomUUID();
  const agentId = randomUUID();
  const queueId = randomUUID();
  const sipDomain = `${tenantId}.sip.test`;
  const flushed: Array<{
    tenantId: string;
    extension: string;
    sipDomain: string;
    telephonyNodeId: string;
    workSessionLeaseId: string;
  }> = [];

  await owner.tenant.create({
    data: { id: tenantId, name: `SIP ${tenantId}`, slug: `sip-${tenantId}`, sipDomain },
  });
  await owner.user.create({
    data: {
      id: agentId,
      tenantId,
      email: `agent-${agentId}@sip.test`,
      passwordHash: 'test',
      displayName: 'Agent SIP',
      role: 'AGENT',
      extension: '7100',
    },
  });
  await owner.queue.create({
    data: { id: queueId, tenantId, name: 'SIP test queue', channels: ['VOICE'] },
  });
  t.after(async () => {
    await owner.agentSipCredential.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionEvent.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionLease.deleteMany({ where: { tenantId } });
    await owner.interactionEvent.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.agentStateLog.deleteMany({ where: { tenantId } });
    await owner.queue.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const leases = new WorkSessionLeases(application, {
    sipRegistrations: { flush: (registration) => flushed.push(registration) },
  });
  const credentials = configuredAgentSipCredentialService(application, {
    SIP_BROWSER_NODES_JSON: JSON.stringify([
      {
        telephonyNodeId: 'fs-local',
        wssUrl: 'ws://localhost:5066',
        directoryPassword: 'directory-test-secret',
      },
    ]),
  });
  const actor = { tenantId, userId: agentId };
  const firstLease = await leases.acquire(
    actor,
    { surface: 'workspace', hostOrigin: null },
    'sip-credential-first',
  );
  const firstCredential = await credentials.issue({
    ...actor,
    workSessionLeaseId: firstLease.leaseId,
  });
  const firstDirectory = await credentials.directory({
    telephonyNodeId: 'fs-local',
    extension: '7100',
    sipDomain,
  });
  assert.equal(
    firstDirectory?.a1Hash,
    a1('7100', sipDomain, firstCredential.authorizationPassword),
  );

  const interactionId = randomUUID();
  await owner.$executeRaw(Prisma.sql`INSERT INTO interactions
    (id, tenant_id, channel, direction, state, queue_id, agent_id, external_id)
    VALUES (${interactionId}::uuid, ${tenantId}::uuid, 'VOICE', 'INBOUND', 'ACTIVE',
      ${queueId}::uuid, ${agentId}::uuid, ${`sip-${interactionId}`})`);
  const renewed = await credentials.issue({ ...actor, workSessionLeaseId: firstLease.leaseId });
  const renewedDirectory = await credentials.directory({
    telephonyNodeId: 'fs-local',
    extension: '7100',
    sipDomain,
  });
  assert.notEqual(renewed.authorizationPassword, firstCredential.authorizationPassword);
  assert.equal(renewedDirectory?.a1Hash, a1('7100', sipDomain, renewed.authorizationPassword));
  assert.equal(flushed.length, 0);
  assert.equal(
    (
      await owner.interaction.findUniqueOrThrow({
        where: { id: interactionId },
        select: { state: true },
      })
    ).state,
    'ACTIVE',
  );

  await owner.interaction.update({
    where: { id: interactionId },
    data: { state: 'COMPLETED' },
    select: { id: true },
  });
  const secondLease = await leases.takeover(
    actor,
    { surface: 'dphone', hostOrigin: null, expectedLeaseId: firstLease.leaseId },
    'sip-credential-takeover',
  );
  assert.deepEqual(flushed, [
    {
      tenantId,
      extension: '7100',
      sipDomain,
      telephonyNodeId: 'fs-local',
      workSessionLeaseId: firstLease.leaseId,
    },
  ]);
  assert.equal(
    await credentials.directory({ telephonyNodeId: 'fs-local', extension: '7100', sipDomain }),
    null,
  );

  const currentCredential = await credentials.issue({
    ...actor,
    workSessionLeaseId: secondLease.leaseId,
  });
  const currentDirectory = await credentials.directory({
    telephonyNodeId: 'fs-local',
    extension: '7100',
    sipDomain,
  });
  assert.equal(currentCredential.leaseId, secondLease.leaseId);
  assert.equal(
    currentDirectory?.a1Hash,
    a1('7100', sipDomain, currentCredential.authorizationPassword),
  );
  assert.notEqual(currentDirectory?.a1Hash, a1('7100', sipDomain, renewed.authorizationPassword));
  assert.equal(await owner.agentSipCredential.count({ where: { tenantId, revokedAt: null } }), 1);
});

function a1(username: string, realm: string, password: string): string {
  return createHash('md5').update(`${username}:${realm}:${password}`).digest('hex');
}
