/**
 * E1.9 (#483) บน Postgres จริงด้วย role ของแอป (`dcontact_app`, RLS):
 * lease ซ้อน 409, takeover ตอนว่าง/มีงาน, หลุดตอนว่างปล่อยใน 60 วินาที, หลุดระหว่างมีงานยังอยู่,
 * WS ที่ไม่มี lease หรือใช้ lease เก่าถูกปฏิเสธ และ tenant A มองไม่เห็น lease ของ tenant B
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import test, { type TestContext } from 'node:test';
import { Module } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { Prisma, PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  WorkspaceSessionGateway,
  WorkspaceSessionRegistry,
  WorkspaceSessionWebSocketAdapter,
  type VerifiedOidcClaims,
  type WorkspaceSessionSocket,
} from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';
import { WORK_SESSION_LEASES, WorkSessionController } from './work-session-api.js';
import { WORK_SESSION_FLAG, WorkSessionLeases, type LeaseSignal } from './work-session.js';

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

function claims(token: string): VerifiedOidcClaims {
  const [tenantId, userId, role = 'agent'] = token.split('|');
  const tenantSlug = `tenant-${tenantId}`;
  return {
    tenant_id: tenantId,
    tenant_slug: tenantSlug,
    organization: { [tenantSlug]: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: `session-${userId}`,
    exp: 2_000_000_000,
    realm_access: { roles: [role] },
  };
}

interface Fixture {
  tenantA: string;
  tenantB: string;
  agentA: string;
  agentB: string;
  queueA: string;
  leases: WorkSessionLeases;
  signals: Array<{ tenantId: string; userId: string; signal: LeaseSignal }>;
  advance(ms: number): void;
  call(
    method: string,
    path: string,
    token: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<{ status: number; body: any }>;
  interaction(state: 'ASSIGNED' | 'ACTIVE' | 'WRAPUP'): Promise<string>;
}

async function setup(t: TestContext, options: { enforced?: boolean } = {}): Promise<Fixture> {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const agentA = randomUUID();
  const agentB = randomUUID();
  const queueA = randomUUID();
  await owner.tenant.createMany({
    data: [tenantA, tenantB].map((id) => ({
      id,
      name: `Lease ${id}`,
      slug: `lease-${id}`,
      sipDomain: `${id}.lease.test`,
    })),
  });
  await owner.user.createMany({
    data: [
      [agentA, tenantA],
      [agentB, tenantB],
    ].map(([id, tenantId]) => ({
      id: id!,
      tenantId: tenantId!,
      email: `agent-${id}@lease.test`,
      passwordHash: 'test',
      displayName: 'Agent',
      role: 'AGENT' as const,
    })),
  });
  await owner.queue.create({
    data: { id: queueA, tenantId: tenantA, name: 'คิวทดสอบ', channels: ['VOICE'] },
  });
  if (options.enforced) {
    await owner.tenantUiFlag.create({
      data: {
        tenantId: tenantA,
        flagKey: WORK_SESSION_FLAG,
        enabled: true,
        reason: 'E1.9 integration',
        updatedByActor: 'test',
      },
    });
  }
  let clock = Date.parse('2026-09-25T10:00:00.000Z');
  const signals: Fixture['signals'] = [];
  const leases = new WorkSessionLeases(application, {
    now: () => new Date(clock),
    signals: { signal: (tenantId, userId, signal) => signals.push({ tenantId, userId, signal }) },
    flagCacheMs: 0,
  });

  @Module({
    controllers: [WorkSessionController],
    providers: [
      { provide: WORK_SESSION_LEASES, useValue: leases },
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: { verifyAccessToken: async (token: string) => claims(token) },
      },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}
  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = `http://127.0.0.1:${(app.getHttpServer().address() as AddressInfo).port}`;

  t.after(async () => {
    await app.close();
    const tenants = [tenantA, tenantB];
    await owner.agentWorkSessionEvent.deleteMany({ where: { tenantId: { in: tenants } } });
    await owner.agentWorkSessionLease.deleteMany({ where: { tenantId: { in: tenants } } });
    await owner.tenantUiFlag.deleteMany({ where: { tenantId: { in: tenants } } });
    await owner.interactionEvent.deleteMany({ where: { tenantId: { in: tenants } } });
    await owner.interaction.deleteMany({ where: { tenantId: { in: tenants } } });
    await owner.agentStateLog.deleteMany({ where: { tenantId: { in: tenants } } });
    await owner.queue.deleteMany({ where: { tenantId: { in: tenants } } });
    await owner.user.deleteMany({ where: { tenantId: { in: tenants } } });
    await owner.tenant.deleteMany({ where: { id: { in: tenants } } });
  });

  return {
    tenantA,
    tenantB,
    agentA,
    agentB,
    queueA,
    leases,
    signals,
    advance: (ms) => {
      clock += ms;
    },
    call: async (method, path, token, body, headers = {}) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          'x-correlation-id': 'corr-lease',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const text = await response.text();
      return { status: response.status, body: text ? JSON.parse(text) : undefined };
    },
    interaction: async (state) => {
      const id = randomUUID();
      await owner.$executeRaw(Prisma.sql`INSERT INTO interactions
        (id, tenant_id, channel, direction, state, queue_id, agent_id, external_id, offer_expires_at)
        VALUES (${id}::uuid, ${tenantA}::uuid, 'VOICE', 'INBOUND', ${state}::"InteractionStateType",
          ${queueA}::uuid, ${agentA}::uuid, ${`lease-${id}`},
          ${state === 'ASSIGNED' ? new Date(clock + 20_000) : null})`);
      return id;
    },
  };
}

const PATH = '/api/v1/me/work-session';

test('lease ซ้อน 409 + holder; takeover ตอนว่างส่ง offer ที่รอกลับเข้าคิว + audit; takeover/ปล่อยระหว่างมีงาน 409', async (t) => {
  const f = await setup(t);
  const token = `${f.tenantA}|${f.agentA}`;
  const first = await f.call('POST', PATH, token, { surface: 'workspace' });
  assert.equal(first.status, 201, JSON.stringify(first.body));
  assert.deepEqual([first.body.ttlSeconds, first.body.heartbeatSeconds], [60, 20]);

  const held = await f.call('POST', PATH, token, {
    surface: 'embedded',
    hostOrigin: 'https://crm.example.test',
  });
  assert.equal(held.status, 409);
  assert.deepEqual(held.body.holder, {
    leaseId: first.body.leaseId,
    surface: 'workspace',
    hostOrigin: null,
    acquiredAt: first.body.acquiredAt,
    busy: false,
  });
  assert.equal(held.body.code, 'WORK_SESSION_HELD');

  // input ผิด: embedded ต้องมี https exact origin, surface อื่นห้ามมี origin
  for (const body of [
    { surface: 'embedded' },
    { surface: 'embedded', hostOrigin: 'http://crm.example.test' },
    { surface: 'embedded', hostOrigin: 'https://crm.example.test/app' },
    { surface: 'workspace', hostOrigin: 'https://crm.example.test' },
    { surface: 'mobile' },
  ]) {
    const invalid = await f.call('POST', PATH, token, body);
    assert.deepEqual(
      [invalid.status, invalid.body.code],
      [400, 'VALIDATION_FAILED'],
      JSON.stringify(body),
    );
  }

  const stale = await f.call('POST', `${PATH}/takeover`, token, {
    surface: 'dphone',
    expectedLeaseId: randomUUID(),
  });
  assert.deepEqual([stale.status, stale.body.code], [409, 'WORK_SESSION_CHANGED']);

  // offer ที่รอกดรับ = ไม่ใช่งานค้าง → takeover ได้ และ offer กลับเข้าคิว
  const offer = await f.interaction('ASSIGNED');
  const moved = await f.call('POST', `${PATH}/takeover`, token, {
    surface: 'embedded',
    hostOrigin: 'https://crm.example.test',
    expectedLeaseId: first.body.leaseId,
  });
  assert.equal(moved.status, 201, JSON.stringify(moved.body));
  assert.equal(moved.body.hostOrigin, 'https://crm.example.test');
  const requeued = await owner.interaction.findUniqueOrThrow({
    where: { id: offer },
    select: { state: true, agentId: true, requeueAt: true },
  });
  assert.deepEqual([requeued.state, requeued.agentId], ['QUEUED', null]);
  assert.ok(requeued.requeueAt);
  assert.deepEqual(
    f.signals.map((entry) => entry.signal),
    [{ type: 'lease.revoked', leaseId: first.body.leaseId, reason: 'takeover' }],
  );
  const audit = await owner.agentWorkSessionEvent.findMany({
    where: { tenantId: f.tenantA },
    orderBy: { occurredAt: 'asc' },
  });
  assert.deepEqual(
    audit.map((row) => [
      row.action,
      row.surface,
      row.previousSurface,
      row.requeuedInteractionCount,
    ]),
    [
      ['ACQUIRED', 'workspace', null, 0],
      ['TAKEOVER', 'embedded', 'workspace', 1],
    ],
  );

  // มีสายอยู่: ห้ามย้ายและห้ามปล่อย
  await f.interaction('ACTIVE');
  const busy = await f.call('POST', `${PATH}/takeover`, token, {
    surface: 'workspace',
    expectedLeaseId: moved.body.leaseId,
  });
  assert.deepEqual(
    [busy.status, busy.body.code, busy.body.holder.busy],
    [409, 'WORK_SESSION_BUSY', true],
  );
  const release = await f.call('DELETE', PATH, token, undefined, {
    'x-work-session-lease-id': moved.body.leaseId,
  });
  assert.deepEqual([release.status, release.body.code], [409, 'WORK_SESSION_BUSY']);
});

test('ปล่อยตอนว่าง = OFFLINE ทันที; lease ของแท็บเก่าปล่อยของที่ใหม่ไม่ได้', async (t) => {
  const f = await setup(t);
  const token = `${f.tenantA}|${f.agentA}`;
  const lease = (await f.call('POST', PATH, token, { surface: 'dphone' })).body;
  const wrong = await f.call('DELETE', PATH, token, undefined, {
    'x-work-session-lease-id': randomUUID(),
  });
  assert.deepEqual([wrong.status, wrong.body.code], [409, 'WORK_SESSION_CHANGED']);
  const released = await f.call('DELETE', PATH, token, undefined, {
    'x-work-session-lease-id': lease.leaseId,
  });
  assert.equal(released.status, 204);
  const state = await owner.agentStateLog.findFirstOrThrow({
    where: { tenantId: f.tenantA, userId: f.agentA },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  });
  assert.deepEqual([state.state, state.reason], ['OFFLINE', 'work_session_released']);
  assert.equal((await f.call('POST', PATH, token, { surface: 'workspace' })).status, 201);
});

test('หลุดตอนว่าง: ปล่อยเมื่อครบ 60 วินาที; หลุดระหว่างมีงาน: lease ยังอยู่จนงานจบ', async (t) => {
  const f = await setup(t);
  const actor = { tenantId: f.tenantA, userId: f.agentA };
  const idle = await f.leases.acquire(actor, { surface: 'workspace', hostOrigin: null }, 'c1');
  f.advance(59_000);
  assert.equal(await f.leases.sweep(), 0);
  assert.equal(await f.leases.isCurrent(actor, idle.leaseId), true);
  f.advance(2_000);
  assert.ok((await f.leases.sweep()) >= 1);
  assert.equal(await f.leases.isCurrent(actor, idle.leaseId), false);
  assert.deepEqual((await f.leases.heartbeat(actor, idle.leaseId)).status, 'EXPIRED');
  assert.deepEqual(f.signals.at(-1)?.signal, { type: 'lease.expired', leaseId: idle.leaseId });
  const offline = await owner.agentStateLog.findFirstOrThrow({
    where: { tenantId: f.tenantA, userId: f.agentA },
    orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
  });
  assert.equal(offline.reason, 'work_session_expired');

  // มีสาย: หลุด heartbeat เกิน TTL ก็ยังเป็น lease ปัจจุบัน และ heartbeat ที่กลับมาต่ออายุได้
  const busyLease = await f.leases.acquire(actor, { surface: 'workspace', hostOrigin: null }, 'c2');
  const call = await f.interaction('ACTIVE');
  f.advance(5 * 60_000);
  await f.leases.sweep();
  assert.equal(await f.leases.isCurrent(actor, busyLease.leaseId), true);
  assert.equal((await f.leases.heartbeat(actor, busyLease.leaseId)).status, 'ACTIVE');
  // จบสาย + ไม่มี heartbeat อีก → ปล่อยเมื่อครบ TTL
  await owner.$executeRaw(
    Prisma.sql`UPDATE interactions SET state = 'COMPLETED' WHERE id = ${call}::uuid`,
  );
  f.advance(61_000);
  await f.leases.sweep();
  assert.equal(await f.leases.isCurrent(actor, busyLease.leaseId), false);
});

test('แยก tenant: A มองไม่เห็น lease ของ B และ lease id ของ B ใช้กับ identity ของ A ไม่ได้', async (t) => {
  const f = await setup(t);
  const leaseB = await f.leases.acquire(
    { tenantId: f.tenantB, userId: f.agentB },
    { surface: 'workspace', hostOrigin: null },
    'c-b',
  );
  const visibleToA = await withTenantDatabaseTransaction(application, f.tenantA, (tx) =>
    tx.agentWorkSessionLease.count({ where: { id: leaseB.leaseId } }),
  );
  assert.equal(visibleToA, 0);
  const actorA = { tenantId: f.tenantA, userId: f.agentA };
  assert.equal(await f.leases.isCurrent(actorA, leaseB.leaseId), false);
  assert.equal((await f.leases.heartbeat(actorA, leaseB.leaseId)).status, 'EXPIRED');
  // lease ของ B ไม่บัง A
  assert.equal(
    (await f.call('POST', PATH, `${f.tenantA}|${f.agentA}`, { surface: 'workspace' })).status,
    201,
  );
  // ขอพร้อมกันสองที่: ได้แค่อันเดียว (partial unique index + row lock)
  const actorB = { tenantId: f.tenantB, userId: f.agentB };
  await f.leases.release(actorB, leaseB.leaseId, 'c-release');
  const results = await Promise.allSettled([
    f.leases.acquire(actorB, { surface: 'workspace', hostOrigin: null }, 'r1'),
    f.leases.acquire(actorB, { surface: 'dphone', hostOrigin: null }, 'r2'),
  ]);
  assert.deepEqual(results.map((result) => result.status).sort(), ['fulfilled', 'rejected']);
});

class FakeSocket implements WorkspaceSessionSocket {
  sent: any[] = [];
  closed: [number, string] | null = null;
  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  close(code: number, reason: string) {
    this.closed = [code, reason];
  }
}

test('WS ของ tenant ที่บังคับ lease: ไม่มี lease/lease เก่า = 4409; งานส่งเฉพาะ socket ที่ถือ lease ปัจจุบัน', async (t) => {
  const f = await setup(t, { enforced: true });
  const gateway = new WorkspaceSessionGateway(
    { verifyAccessToken: async (token) => claims(token) },
    new WorkspaceSessionRegistry(),
    { isActive: async () => true },
  );
  const adapter = new WorkspaceSessionWebSocketAdapter(gateway, undefined, undefined, f.leases);
  const token = `${f.tenantA}|${f.agentA}`;
  const connect = async (leaseId?: string, tabId = randomUUID()) => {
    const socket = new FakeSocket();
    await adapter.handle(socket, {
      type: 'auth:connect',
      accessToken: token,
      tabId,
      ...(leaseId ? { leaseId } : {}),
    });
    return socket;
  };

  assert.deepEqual((await connect()).closed, [4409, 'work session lease required']);
  assert.deepEqual((await connect(randomUUID())).closed, [4409, 'work session lease required']);

  const actor = { tenantId: f.tenantA, userId: f.agentA };
  const first = await f.leases.acquire(actor, { surface: 'workspace', hostOrigin: null }, 'w1');
  const holder = await connect(first.leaseId);
  assert.equal(holder.closed, null);
  assert.equal(holder.sent[0].session.routingEnabled, true);
  // supervisor ที่ไม่ใช่ agent ต่อได้เพื่อดูข้อมูลสด แต่ไม่รับงาน
  const supervisorSocket = new FakeSocket();
  await adapter.handle(supervisorSocket, {
    type: 'auth:connect',
    accessToken: `${f.tenantA}|${randomUUID()}|supervisor`,
    tabId: 'sup',
  });
  assert.equal(supervisorSocket.closed, null);
  assert.equal(supervisorSocket.sent[0].session.routingEnabled, false);

  const offer = {
    type: 'routing.offered' as const,
    tenantId: f.tenantA,
    userId: f.agentA,
    interactionId: randomUUID(),
  };
  assert.equal(await adapter.deliverRoutingEvent(offer), 1);

  // heartbeat ต่ออายุ; takeover จากที่ใหม่ → ที่เดิมได้ lease.revoked และไม่ได้งานอีก
  await adapter.handle(holder, { type: 'lease:heartbeat', leaseId: first.leaseId });
  assert.equal(holder.sent.at(-1).type, 'lease.active');
  const moved = await f.leases.takeover(
    actor,
    { surface: 'embedded', hostOrigin: 'https://crm.example.test', expectedLeaseId: first.leaseId },
    'w2',
  );
  for (const { tenantId, userId, signal } of f.signals) {
    await adapter.signalLease(tenantId, userId, signal);
  }
  assert.deepEqual(holder.sent.at(-1), {
    type: 'lease.revoked',
    leaseId: first.leaseId,
    reason: 'takeover',
  });
  const embedded = await connect(moved.leaseId);
  assert.equal(await adapter.deliverRoutingEvent({ ...offer, interactionId: randomUUID() }), 1);
  assert.equal(embedded.sent.filter((message) => message.type === 'routing.offered').length, 1);
  assert.equal(holder.sent.filter((message) => message.type === 'routing.offered').length, 1);
  // lease เก่าต่อใหม่ไม่ได้ (client ค้าง)
  assert.deepEqual((await connect(first.leaseId)).closed, [4409, 'work session lease required']);
});
