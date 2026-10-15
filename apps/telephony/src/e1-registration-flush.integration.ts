import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { E1RegistrationFlusher, type E1RegistrationFlushInput } from './e1-registration-flush.js';

test('flush ภายใต้ RLS ต้อง revoked+released, ปกป้อง lease ใหม่ และไม่เปลี่ยน ACTIVE interaction', async (context) => {
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
  const tenantId = randomUUID();
  const userId = randomUUID();
  const leaseId = randomUUID();
  const sipDomain = `${tenantId}.e1-flush.test`;
  await owner.tenant.create({
    data: { id: tenantId, name: 'E1 flush test', slug: `e1-flush-${tenantId}`, sipDomain },
  });
  context.after(async () => {
    await owner.dlVoiceAuditEvent.deleteMany({ where: { tenantId } });
    await owner.agentSipCredential.deleteMany({ where: { tenantId } });
    await owner.agentWorkSessionLease.deleteMany({ where: { tenantId } });
    await owner.interaction.deleteMany({ where: { tenantId } });
    await owner.user.deleteMany({ where: { tenantId } });
    await owner.tenant.delete({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  await owner.user.create({
    data: {
      id: userId,
      tenantId,
      role: 'AGENT',
      extension: '1101',
      email: `agent-${userId}@e1-flush.test`,
      displayName: 'E1 flush agent',
      passwordHash: 'test',
    },
  });
  await owner.agentWorkSessionLease.create({
    data: {
      id: leaseId,
      tenantId,
      userId,
      surface: 'dphone',
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await owner.agentSipCredential.create({
    data: {
      workSessionLeaseId: leaseId,
      tenantId,
      userId,
      extension: '1101',
      sipDomain,
      telephonyNodeId: 'e1-uat-sandbox',
      a1Hash: '0'.repeat(32),
      issuedAt: new Date(),
    },
  });
  const interaction = await owner.interaction.create({
    data: {
      tenantId,
      channel: 'VOICE',
      direction: 'INBOUND',
      state: 'ACTIVE',
      agentId: userId,
      externalId: randomUUID(),
    },
  });
  const input: E1RegistrationFlushInput = {
    tenantId,
    command: {
      type: 'sip.registration.flush',
      vendor: 'freeswitch',
      telephonyNodeId: 'e1-uat-sandbox',
      sipDomain,
      extension: '1101',
      workSessionLeaseId: leaseId,
    },
  };
  let commands = 0;
  const flusher = new E1RegistrationFlusher(application, {
    handle: async (command) => {
      assert.equal(command.type, 'sip.registration.flush');
      commands += 1;
    },
  });
  assert.equal(await flusher.flush(input), false);
  assert.equal(commands, 0);
  await owner.agentSipCredential.update({
    where: { workSessionLeaseId: leaseId },
    data: { revokedAt: new Date() },
  });
  assert.equal(await flusher.flush(input), false);
  await owner.agentWorkSessionLease.update({
    where: { id: leaseId },
    data: { releasedAt: new Date(), releaseReason: 'released' },
  });
  assert.equal(await flusher.flush({ ...input, tenantId: randomUUID() }), false);
  assert.equal(
    await flusher.flush({ ...input, command: { ...input.command, extension: '1102' } }),
    false,
  );
  assert.equal(await flusher.flush(input), true);
  assert.equal(
    await new E1RegistrationFlusher(application, {
      handle: async () => {
        commands += 1;
      },
    }).flush(input),
    true,
  );
  assert.equal(commands, 1);
  assert.equal(
    (await owner.interaction.findUniqueOrThrow({ where: { id: interaction.id } })).state,
    'ACTIVE',
  );
  assert.equal(
    await owner.dlVoiceAuditEvent.count({
      where: { tenantId, code: 'E1_SANDBOX_REGISTRATION_FLUSHED' },
    }),
    1,
  );
  const newLeaseId = randomUUID();
  await owner.agentWorkSessionLease.create({
    data: {
      id: newLeaseId,
      tenantId,
      userId,
      surface: 'workspace',
      acquiredAt: new Date(),
      heartbeatAt: new Date(),
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  await owner.agentSipCredential.create({
    data: {
      workSessionLeaseId: newLeaseId,
      tenantId,
      userId,
      extension: '1101',
      sipDomain,
      telephonyNodeId: 'e1-uat-sandbox',
      a1Hash: '1'.repeat(32),
      issuedAt: new Date(),
    },
  });
  assert.equal(await flusher.flush(input), false);
  assert.equal(commands, 1);
});
