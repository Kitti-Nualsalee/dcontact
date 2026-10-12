import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { AgentWorkspaceController, AGENT_WORKSPACE_DATABASE } from './agent-workspace-api.js';
import {
  AGENT_SIP_CREDENTIALS,
  DatabaseAgentSipCredentialService,
} from './agent-sip-credentials.js';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { WorkSessionLeases } from './work-session.js';
import { EmbedOriginService } from './embed-origins.js';

async function fixture(context: TestContext) {
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
  const actor = { tenantId: randomUUID(), userId: randomUUID() };
  const foreign = { tenantId: randomUUID(), userId: randomUUID() };
  const tenantIds = [actor.tenantId, foreign.tenantId];
  await owner.tenant.createMany({
    data: tenantIds.map((tenantId) => ({
      id: tenantId,
      name: `Availability ${tenantId}`,
      slug: `availability-${tenantId}`,
      sipDomain: `${tenantId}.availability.test`,
    })),
  });
  await owner.user.createMany({
    data: [actor, foreign].map(({ tenantId, userId }) => ({
      id: userId,
      tenantId,
      email: `${userId}@example.invalid`,
      displayName: 'คู่ทดสอบ availability',
      passwordHash: '!TEST_ONLY',
      role: 'AGENT',
      extension: '1101',
    })),
  });
  const leases = new WorkSessionLeases(application);
  const sip = new DatabaseAgentSipCredentialService(
    application,
    [
      {
        telephonyNodeId: 'availability-test',
        wssUrl: 'wss://example.invalid',
        directoryPassword: 'test-only',
      },
    ],
    [],
  );
  const lease = await leases.acquire(actor, { surface: 'workspace', hostOrigin: null }, 'test');
  await sip.issue({ ...actor, workSessionLeaseId: lease.leaseId });
  const claims = ({ tenantId, userId }: typeof actor, role = 'agent') => ({
    tenant_id: tenantId,
    tenant_slug: `availability-${tenantId}`,
    organization: { [`availability-${tenantId}`]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role] },
  });
  @Module({
    controllers: [AgentWorkspaceController],
    providers: [
      { provide: AGENT_WORKSPACE_DATABASE, useValue: application },
      { provide: AGENT_SIP_CREDENTIALS, useValue: sip },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: {
          verifyAccessToken: async (token: string) => {
            if (token === 'actor') return claims(actor);
            if (token === 'admin') return claims(actor, 'admin');
            if (token === 'foreign') return claims(foreign);
            throw new Error('invalid token');
          },
        },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write() {} } },
      OidcGlobalGuard,
    ],
  })
  class AvailabilityModule {}
  const app = await NestFactory.create(AvailabilityModule, { logger: false });
  app.useGlobalGuards(app.get(OidcGlobalGuard));
  await app.listen(0, '127.0.0.1');
  const baseUrl = await app.getUrl();
  context.after(async () => {
    await app.close();
    await owner.interactionEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.interaction.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.queue.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.agentSipCredential.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.agentWorkSessionEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.agentWorkSessionLease.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.agentStateLog.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.tenantEmbedOriginAuditEvent.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.tenantEmbedOrigin.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.tenantUiFlag.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.tenantPlanBinding.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.user.deleteMany({ where: { tenantId: { in: tenantIds } } });
    await owner.tenant.deleteMany({ where: { id: { in: tenantIds } } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  const available = (
    leaseId: string | undefined = lease.leaseId,
    token = 'actor',
    body: unknown = { state: 'AVAILABLE' },
  ) =>
    fetch(`${baseUrl}/api/v1/workspace/agent/availability`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        connection: 'close',
        'content-type': 'application/json',
        ...(leaseId ? { 'x-work-session-lease-id': leaseId } : {}),
      },
      body: JSON.stringify(body),
    });
  const snapshot = async (token = 'actor') => {
    const response = await fetch(`${baseUrl}/api/v1/workspace/agent/snapshot`, {
      headers: { authorization: `Bearer ${token}`, connection: 'close' },
    });
    assert.equal(response.status, 200);
    return (await response.json()) as {
      agent: { state: string };
      interaction: { state: string } | null;
    };
  };
  return { owner, application, actor, foreign, leases, sip, lease, available, snapshot };
}

test('agent เปิดรับสายด้วย lease ของตนและ snapshot ยืนยัน AVAILABLE จาก server', async (context) => {
  const state = await fixture(context);
  const response = await state.available(state.lease.leaseId, 'actor', {
    state: 'AVAILABLE',
    tenantId: state.foreign.tenantId,
    userId: state.foreign.userId,
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { state: 'AVAILABLE' });
  assert.equal((await state.snapshot()).agent.state, 'AVAILABLE');
  assert.equal((await state.snapshot('foreign')).agent.state, 'OFFLINE');
});

test('ไม่มี/ผิด lease หรือ request state อื่น ห้ามเปิดรับสาย', async (context) => {
  const state = await fixture(context);
  assert.equal((await state.available('')).status, 400);
  assert.equal((await state.available('invalid')).status, 400);
  assert.equal((await state.available(randomUUID())).status, 403);
  assert.equal((await state.available(state.lease.leaseId, 'foreign')).status, 403);
  assert.equal(
    (await state.available(state.lease.leaseId, 'actor', { state: 'OFFLINE' })).status,
    400,
  );
  assert.equal((await state.snapshot()).agent.state, 'OFFLINE');
});

test('role ที่ไม่ใช่ agent และ token ไม่ถูกต้อง ห้ามเปิดรับสาย', async (context) => {
  const state = await fixture(context);
  assert.equal((await state.available(state.lease.leaseId, 'admin')).status, 403);
  assert.equal((await state.available(state.lease.leaseId, 'invalid-token')).status, 401);
  assert.equal((await state.snapshot()).agent.state, 'OFFLINE');
});

test('expired/released/taken-over lease ไม่เปิด AVAILABLE', async (context) => {
  const state = await fixture(context);
  await state.owner.agentWorkSessionLease.update({
    where: { id: state.lease.leaseId },
    data: {
      acquiredAt: new Date(Date.now() - 120_000),
      heartbeatAt: new Date(Date.now() - 90_000),
      expiresAt: new Date(Date.now() - 60_000),
    },
  });
  assert.equal((await state.available()).status, 403);
  await state.leases.release(state.actor, state.lease.leaseId, 'test-release');
  assert.equal((await state.available()).status, 403);
  const replacement = await state.leases.acquire(
    state.actor,
    { surface: 'workspace', hostOrigin: null },
    'test-acquire',
  );
  await state.sip.issue({ ...state.actor, workSessionLeaseId: replacement.leaseId });
  await state.leases.takeover(
    state.actor,
    { surface: 'dphone', hostOrigin: null, expectedLeaseId: replacement.leaseId },
    'test-takeover',
  );
  assert.equal((await state.available(replacement.leaseId)).status, 403);
  assert.equal((await state.snapshot()).agent.state, 'OFFLINE');
});

test('credential ที่ revoke หรือยังไม่ออก ห้ามเปิดรับสาย', async (context) => {
  const state = await fixture(context);
  await state.owner.agentSipCredential.update({
    where: { workSessionLeaseId: state.lease.leaseId },
    data: { revokedAt: new Date() },
  });
  const revoked = await state.available();
  assert.equal(revoked.status, 409);
  assert.deepEqual(await revoked.json(), { code: 'AGENT_SIP_NOT_READY' });
  await state.owner.agentSipCredential.delete({
    where: { workSessionLeaseId: state.lease.leaseId },
  });
  assert.equal((await state.available()).status, 409);
  assert.equal((await state.snapshot()).agent.state, 'OFFLINE');
});

for (const busyState of ['ASSIGNED', 'ACTIVE', 'WRAPUP'] as const) {
  test(`VOICE ${busyState} ห้ามเปลี่ยน agent กลับ AVAILABLE`, async (context) => {
    const state = await fixture(context);
    const queue = await state.owner.queue.create({
      data: { tenantId: state.actor.tenantId, name: 'ทดสอบ busy', channels: ['VOICE'] },
    });
    await state.owner.interaction.create({
      data: {
        tenantId: state.actor.tenantId,
        agentId: state.actor.userId,
        queueId: queue.id,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: busyState,
      },
    });
    const response = await state.available();
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { code: 'WORK_SESSION_BUSY' });
    assert.equal((await state.snapshot()).interaction?.state, busyState);
    assert.equal((await state.snapshot()).agent.state, 'OFFLINE');
  });
}

test('คำสั่งซ้ำและ race กับ release ไม่ปลุก agent หลังเสีย lease', async (context) => {
  const state = await fixture(context);
  assert.equal((await state.available()).status, 200);
  assert.equal((await state.available()).status, 200);
  const audit = await withTenantDatabaseTransaction(
    state.application,
    state.actor.tenantId,
    (transaction) =>
      transaction.agentStateLog.findMany({
        where: { tenantId: state.actor.tenantId, userId: state.actor.userId, state: 'AVAILABLE' },
        select: { actorUserId: true },
      }),
  );
  assert.deepEqual(audit, [{ actorUserId: state.actor.userId }]);
  let leaseId = state.lease.leaseId;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const [response] = await Promise.all([
      state.available(leaseId),
      state.leases.release(state.actor, leaseId, 'test-race'),
    ]);
    assert.ok([200, 403].includes(response.status));
    assert.equal((await state.snapshot()).agent.state, 'OFFLINE');
    assert.equal((await state.available(leaseId)).status, 403);
    if (attempt < 4) {
      const lease = await state.leases.acquire(
        state.actor,
        { surface: 'workspace', hostOrigin: null },
        'test-acquire',
      );
      leaseId = lease.leaseId;
      await state.sip.issue({ ...state.actor, workSessionLeaseId: leaseId });
    }
  }
});

test('takeover ที่ commit ระหว่าง request รอ lock ทำให้ lease เก่าถูกปฏิเสธ', async (context) => {
  const state = await fixture(context);
  let unlock!: () => void;
  let locked!: () => void;
  const gate = new Promise<void>((resolve) => {
    unlock = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    locked = resolve;
  });
  const blocker = state.owner.$transaction(async (transaction) => {
    await transaction.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id = ${state.actor.userId}::uuid FOR NO KEY UPDATE`,
    );
    locked();
    await gate;
  });
  await ready;
  const pending = state.available();
  try {
    await state.leases.takeover(
      state.actor,
      { surface: 'dphone', hostOrigin: null, expectedLeaseId: state.lease.leaseId },
      'test-race-takeover',
    );
  } finally {
    unlock();
    await blocker;
  }
  assert.equal((await pending).status, 403);
  assert.equal((await state.snapshot()).agent.state, 'OFFLINE');
});

test('embedded origin/flag ถูกปิด ห้ามเปิดรับสายแม้ lease และ SIP ยังไม่หมด', async (context) => {
  const state = await fixture(context);
  await state.leases.release(state.actor, state.lease.leaseId, 'test-release');
  await state.owner.tenantUiFlag.create({
    data: {
      tenantId: state.actor.tenantId,
      flagKey: 'dphone.embed.enabled',
      enabled: true,
      reason: 'ทดสอบ',
      updatedByActor: 'test',
    },
  });
  const origins = new EmbedOriginService(state.application);
  const origin = await origins.create(
    state.actor,
    { origin: 'https://crm.example.test', label: 'ทดสอบ' },
    'test-origin',
  );
  const embeddedLeases = new WorkSessionLeases(state.application, { embedOrigins: origins });
  const lease = await embeddedLeases.acquire(
    state.actor,
    { surface: 'embedded', hostOrigin: origin.origin },
    'test-acquire',
  );
  await state.sip.issue({ ...state.actor, workSessionLeaseId: lease.leaseId });
  assert.equal((await state.available(lease.leaseId)).status, 200);
  await state.owner.tenantPlanBinding.create({
    data: {
      tenantId: state.actor.tenantId,
      planCode: 'growth',
      planVersion: 1,
      snapshotDigest: '0'.repeat(64),
      entitlements: { module_api_cti: false },
      provisioningRequestId: randomUUID(),
    },
  });
  assert.equal((await state.available(lease.leaseId)).status, 403);
  await state.owner.tenantPlanBinding.update({
    where: { tenantId: state.actor.tenantId },
    data: { entitlements: { module_api_cti: true } },
  });
  await state.owner.tenantUiFlag.update({
    where: {
      tenantId_flagKey: { tenantId: state.actor.tenantId, flagKey: 'dphone.embed.enabled' },
    },
    data: { enabled: false },
  });
  assert.equal((await state.available(lease.leaseId)).status, 403);
  await state.owner.tenantUiFlag.update({
    where: {
      tenantId_flagKey: { tenantId: state.actor.tenantId, flagKey: 'dphone.embed.enabled' },
    },
    data: { enabled: true },
  });
  await origins.remove(
    state.actor,
    origin.id,
    { expectedRevision: origin.revision },
    'test-remove',
  );
  assert.equal((await state.available(lease.leaseId)).status, 403);
});

test('release ที่เริ่ม transaction ก่อน AVAILABLE แต่ commit ทีหลัง ต้องเห็น OFFLINE ล่าสุด', async (context) => {
  const state = await fixture(context);
  let resume!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const delayedDatabase = new Proxy(state.application, {
    get(target, property) {
      if (property === '$transaction')
        return (work: (transaction: Prisma.TransactionClient) => Promise<unknown>) =>
          target.$transaction(async (transaction) => {
            await transaction.$queryRaw(Prisma.sql`SELECT now()`);
            started();
            await gate;
            return work(transaction);
          });
      return Reflect.get(target, property);
    },
  });
  const release = new WorkSessionLeases(delayedDatabase).release(
    state.actor,
    state.lease.leaseId,
    'test-commit-order',
  );
  await ready;
  try {
    assert.equal((await state.available()).status, 200);
  } finally {
    resume();
  }
  await release;
  assert.equal((await state.snapshot()).agent.state, 'OFFLINE');
});
