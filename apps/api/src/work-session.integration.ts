/**
 * E1.9 (#483) on real Postgres with the app role (`dcontact_app`, RLS):
 * overlapping lease 409, takeover when idle/busy, dropped while idle is released within 60 seconds, dropped during work stays,
 * a WS without a lease or with an old lease is rejected, and tenant A cannot see tenant B's lease
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
import { WorkSessionLeases, type LeaseSignal } from './work-session.js';

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

async function setup(t: TestContext): Promise<Fixture> {
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
    data: { id: queueA, tenantId: tenantA, name: 'Test queue', channels: ['VOICE'] },
  });
  let clock = Date.parse('2026-09-25T10:00:00.000Z');
  const signals: Fixture['signals'] = [];
  const leases = new WorkSessionLeases(application, {
    now: () => new Date(clock),
    signals: { signal: (tenantId, userId, signal) => signals.push({ tenantId, userId, signal }) },
    // E1.11: the host of an embedded surface must be in the allowlist — the lease tests use a fixed policy
    embedOrigins: {
      isEmbeddable: async (_tenantId, origin) => origin === 'https://crm.example.test',
    },
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

test('overlapping lease 409 + holder; takeover when idle returns a pending offer to the queue + audit; takeover/release during work 409', async (t) => {
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

  // wrong input: embedded needs an https exact origin, other surfaces must not have an origin
  for (const body of [
    { surface: 'embedded' },
    { surface: 'embedded', hostOrigin: 'http://crm.example.test' },
    { surface: 'embedded', hostOrigin: 'https://crm.example.test/app' },
    { surface: 'embedded', hostOrigin: 'HTTPS://CRM.example.test' },
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

  // a pending offer = not outstanding work → takeover allowed, and the offer returns to the queue
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

  // on a call: moving and releasing are forbidden
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

test('release when idle = OFFLINE immediately; a lease of an old tab cannot release the new one', async (t) => {
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

test('an inactive account does not accept a routing offer and a heartbeat revokes its idle lease', async (t) => {
  const f = await setup(t);
  const actor = { tenantId: f.tenantA, userId: f.agentA };
  const lease = await f.leases.acquire(
    actor,
    { surface: 'workspace', hostOrigin: null },
    'disable-idle',
  );
  await owner.user.update({ where: { id: f.agentA }, data: { isActive: false } });
  assert.equal(await f.leases.isCurrent(actor, lease.leaseId), false);
  assert.deepEqual(await f.leases.heartbeat(actor, lease.leaseId), {
    status: 'REVOKED',
    reason: 'auth_revoked',
  });
  const released = await owner.agentWorkSessionLease.findUniqueOrThrow({
    where: { id: lease.leaseId },
  });
  assert.ok(released.releasedAt);
  assert.equal(released.releaseReason, 'auth_revoked');
  await assert.rejects(
    f.leases.acquire(actor, { surface: 'workspace', hostOrigin: null }, 'disabled-acquire'),
    /AGENT_NOT_FOUND/,
  );
});

test('an inactive account during work stops taking new work but its active lease is not cut before the work ends', async (t) => {
  const f = await setup(t);
  const actor = { tenantId: f.tenantA, userId: f.agentA };
  const lease = await f.leases.acquire(
    actor,
    { surface: 'workspace', hostOrigin: null },
    'disable-busy',
  );
  await f.interaction('ACTIVE');
  await owner.user.update({ where: { id: f.agentA }, data: { isActive: false } });
  assert.equal(await f.leases.isCurrent(actor, lease.leaseId), false);
  assert.deepEqual(await f.leases.heartbeat(actor, lease.leaseId), {
    status: 'REVOKED',
    reason: 'auth_revoked',
  });
  const retained = await owner.agentWorkSessionLease.findUniqueOrThrow({
    where: { id: lease.leaseId },
  });
  assert.equal(retained.releasedAt, null);
});

test('dropped while idle: released after 60 seconds; dropped during work: the lease stays until the work ends', async (t) => {
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

  // on a call: a heartbeat gap beyond the TTL is still the current lease and a returning heartbeat renews it
  const busyLease = await f.leases.acquire(actor, { surface: 'workspace', hostOrigin: null }, 'c2');
  const call = await f.interaction('ACTIVE');
  f.advance(5 * 60_000);
  await f.leases.sweep();
  assert.equal(await f.leases.isCurrent(actor, busyLease.leaseId), true);
  assert.equal((await f.leases.heartbeat(actor, busyLease.leaseId)).status, 'ACTIVE');
  // call ended + no more heartbeat → released when the TTL is up
  await owner.$executeRaw(
    Prisma.sql`UPDATE interactions SET state = 'COMPLETED' WHERE id = ${call}::uuid`,
  );
  f.advance(61_000);
  await f.leases.sweep();
  assert.equal(await f.leases.isCurrent(actor, busyLease.leaseId), false);
});

test('tenant separation: A cannot see the lease of B and the lease id of B cannot be used with the identity of A', async (t) => {
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
  // the lease of B does not block A
  assert.equal(
    (await f.call('POST', PATH, `${f.tenantA}|${f.agentA}`, { surface: 'workspace' })).status,
    201,
  );
  // two requests at once: only one succeeds (partial unique index + row lock)
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

// #583: every tenant enforces the lease — a tenant may have no flag row at all and still gets 4409 when there is no lease
test('WS enforces the lease for every tenant: no lease/old lease = 4409; work is sent only to the socket holding the current lease', async (t) => {
  const f = await setup(t);
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
  // a supervisor who is not an agent can connect to see live data but does not receive work
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

  // heartbeat renews; takeover from a new place → the old one gets lease.revoked and no more work
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
  // an old lease cannot be renewed (a stuck client)
  assert.deepEqual((await connect(first.leaseId)).closed, [4409, 'work session lease required']);
});

test('E1.12/#583: GET status — always enforced + holder (surface, start time, has work); expired while idle = no holder', async (t) => {
  const f = await setup(t);
  const token = `${f.tenantA}|${f.agentA}`;
  const empty = await f.call('GET', PATH, token);
  assert.deepEqual([empty.status, empty.body], [200, { enforced: true, holder: null }]);

  const lease = (await f.call('POST', PATH, token, { surface: 'dphone' })).body;
  const held = await f.call('GET', PATH, token);
  assert.deepEqual(held.body, {
    enforced: true,
    holder: {
      leaseId: lease.leaseId,
      surface: 'dphone',
      hostOrigin: null,
      acquiredAt: lease.acquiredAt,
      busy: false,
    },
  });
  await f.interaction('ACTIVE');
  assert.equal((await f.call('GET', PATH, token)).body.holder.busy, true);
  // tenant B does not see the lease of A
  assert.deepEqual((await f.call('GET', PATH, `${f.tenantB}|${f.agentB}`)).body, {
    enforced: true,
    holder: null,
  });
  // a role other than agent cannot read
  assert.equal((await f.call('GET', PATH, `${f.tenantA}|${f.agentA}|supervisor`)).status, 403);

  // idle and silent beyond the TTL: no holder is shown even though the sweeper has not closed it yet
  await owner.$executeRaw(
    Prisma.sql`UPDATE interactions SET state = 'COMPLETED' WHERE tenant_id = ${f.tenantA}::uuid`,
  );
  f.advance(61_000);
  assert.equal((await f.call('GET', PATH, token)).body.holder, null);
});

test('E1.11: embedded needs an origin in the allowlist — not in it = 403 EMBED_ORIGIN_NOT_ALLOWED', async (t) => {
  const f = await setup(t);
  const denied = await f.call('POST', PATH, `${f.tenantA}|${f.agentA}`, {
    surface: 'embedded',
    hostOrigin: 'https://other.example.test',
  });
  assert.deepEqual([denied.status, denied.body.code], [403, 'EMBED_ORIGIN_NOT_ALLOWED']);
});
