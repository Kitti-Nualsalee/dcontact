import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WorkspaceSessionGateway, WorkspaceSessionRegistry } from './workspace-session.js';
import {
  WorkspaceSessionWebSocketAdapter,
  type WorkspaceSessionSocket,
  type WorkspaceTenantScope,
} from './websocket-session-adapter.js';
import type { WorkspaceMutationAuthBinding } from './mutation-auth.js';

function fixture(strictCas = false, scope?: WorkspaceTenantScope) {
  const tenantId = randomUUID(),
    userId = randomUUID(),
    leaseId = randomUUID();
  const events: string[] = [],
    sent: Record<string, unknown>[] = [],
    closed: number[] = [];
  let epoch = 0;
  const authCalls: Array<{ token: string; expected?: string }> = [];
  let persistenceFailure = false;
  let onlineFailure = false;
  let leaseCurrent = true;
  let releaseAuth: (() => void) | undefined;
  let authReached: (() => void) | undefined;
  const authWaiting = new Promise<void>((resolve) => {
    authReached = resolve;
  });
  let slow: (() => void) | undefined;
  let releaseHeartbeat: (() => void) | undefined;
  let heartbeatReached: (() => void) | undefined;
  const heartbeatWaiting = new Promise<void>((resolve) => {
    heartbeatReached = resolve;
  });
  const registry = new WorkspaceSessionRegistry();
  const gateway = new WorkspaceSessionGateway(
    {
      async verifyAccessToken(token) {
        if (token === 'slow')
          await new Promise<void>((resolve) => {
            slow = resolve;
          });
        if (token === 'expired' || token === 'slow') throw Error('invalid token');
        return {
          tenant_id: tenantId,
          tenant_slug: 'test',
          dc_user_id: userId,
          sid: `sid-${token}`,
          exp: 2_000_000_000,
          realm_access: { roles: token === 'forbidden' ? [] : ['agent'] },
        };
      },
    },
    registry,
    { isActive: async () => true },
  );
  const socket: WorkspaceSessionSocket = {
    send(value) {
      events.push('send');
      sent.push(JSON.parse(value));
    },
    close(code) {
      events.push('close');
      closed.push(code);
    },
  };
  const adapter = new WorkspaceSessionWebSocketAdapter(
    gateway,
    scope,
    undefined,
    {
      enforced: async () => true,
      heartbeat: async (_actor, _lease, correlationId) => {
        if (correlationId === 'delayed-heartbeat') {
          heartbeatReached?.();
          await new Promise<void>((resolve) => {
            releaseHeartbeat = resolve;
          });
          return { status: 'EXPIRED' };
        }
        return { status: 'ACTIVE', expiresAt: new Date('2030-01-01') };
      },
      isCurrent: async () => leaseCurrent,
      async revokeForAuth() {
        events.push('lease-revoke');
        return false;
      },
    },
    {
      async reauthenticate({ accessToken, expected }) {
        authCalls.push({ token: accessToken, expected: expected?.authEpoch });
        if (accessToken === 'delayed-auth') {
          authReached?.();
          await new Promise<void>((resolve) => {
            releaseAuth = resolve;
          });
        }
        if (onlineFailure) throw Error('identity unavailable');
        if (strictCas && expected && Number(expected.authEpoch) !== epoch)
          throw Error('stale auth epoch');
        epoch += 1;
        return {
          tenantId,
          userId,
          leaseId,
          authEpoch: String(epoch),
          issuer: 'https://idp.test',
          subject: userId,
          sid: `sid-${accessToken}`,
          tokenFingerprint: 'a'.repeat(64),
          tokenExpiresAt: new Date('2030-01-01'),
        };
      },
      async invalidateCaptured(binding: WorkspaceMutationAuthBinding) {
        if (persistenceFailure) throw Error('database unavailable');
        if (Number(binding.authEpoch) + 1 === epoch) {
          events.push('already-invalidated');
          return true;
        }
        if (Number(binding.authEpoch) !== epoch) return false;
        events.push('persist-invalidation');
        epoch += 1;
        return true;
      },
    },
  );
  return {
    adapter,
    socket,
    leaseId,
    registry,
    tenantId,
    userId,
    events,
    sent,
    closed,
    authCalls,
    failOnline: () => {
      onlineFailure = true;
    },
    failPersistence: () => {
      persistenceFailure = true;
    },
    replaceBinding: () => {
      epoch += 2;
    },
    releaseSlow: () => slow?.(),
    heartbeatWaiting,
    releaseHeartbeat: () => releaseHeartbeat?.(),
    authWaiting,
    releaseAuth: () => releaseAuth?.(),
    revokeLease: () => {
      leaseCurrent = false;
    },
  };
}

test('takeover after the lease check but before installing the binding does not open routing', async () => {
  let reached!: () => void, release!: () => void;
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const f = fixture(true, async (_tenant, work) => {
    reached();
    await held;
    return work();
  });
  const connect = f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await waiting;
  assert.equal(
    await f.adapter.signalLease(f.tenantId, f.userId, {
      type: 'lease.revoked',
      leaseId: f.leaseId,
      reason: 'takeover',
    }),
    0,
  );
  release();
  await connect;
  assert.deepEqual(f.closed, [4409]);
  assert.equal(
    f.sent.some((message) => message.type === 'workspace.session'),
    false,
  );
  assert.equal(f.registry.canReceiveRoutingWork(f.tenantId, f.userId, 'a'), false);
});

test('takeover marks the binding before waiting for tenant scope to stop routing that already passed the lease check', async () => {
  let pause = false,
    count = 0,
    reachedRouting!: () => void,
    reachedSignal!: () => void;
  let releaseRouting!: () => void, releaseSignal!: () => void;
  const routingWaiting = new Promise<void>((resolve) => {
    reachedRouting = resolve;
  });
  const signalWaiting = new Promise<void>((resolve) => {
    reachedSignal = resolve;
  });
  const routingHeld = new Promise<void>((resolve) => {
    releaseRouting = resolve;
  });
  const signalHeld = new Promise<void>((resolve) => {
    releaseSignal = resolve;
  });
  const f = fixture(true, async (_tenant, work) => {
    if (pause) {
      if (++count === 1) {
        reachedRouting();
        await routingHeld;
      } else {
        reachedSignal();
        await signalHeld;
      }
    }
    return work();
  });
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  pause = true;
  const routing = f.adapter.deliverRoutingEvent({
    type: 'routing.offered',
    tenantId: f.tenantId,
    userId: f.userId,
    interactionId: randomUUID(),
  });
  await routingWaiting;
  const signal = f.adapter.signalLease(f.tenantId, f.userId, {
    type: 'lease.revoked',
    leaseId: f.leaseId,
    reason: 'takeover',
  });
  await signalWaiting;
  pause = false;
  releaseRouting();
  assert.equal(await routing, 0);
  releaseSignal();
  assert.equal(await signal, 1);
  assert.equal(
    f.sent.some((message) => message.type === 'routing.offered'),
    false,
  );
});

test('overlapping refresh: the old callback commits first, then the new callback uses the latest private epoch', async () => {
  const f = fixture(true);
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const old = f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'delayed-auth',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await f.authWaiting;
  const latest = f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'new',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.releaseAuth();
  await Promise.all([old, latest]);
  assert.deepEqual(f.authCalls, [
    { token: 'one', expected: undefined },
    { token: 'delayed-auth', expected: '1' },
    { token: 'new', expected: '2' },
  ]);
  assert.equal(f.sent.filter((event) => event.type === 'workspace.session').length, 2);
  assert.equal(
    f.sent.some((event) => event.state === 'UNAVAILABLE'),
    false,
  );
  assert.equal(JSON.stringify(f.sent).includes('authEpoch'), false);
});

test('overlapping refresh: the new callback passes before the old verifier, so the old callback must not touch durable auth', async () => {
  const f = fixture(true);
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const old = f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'slow',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'new',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.releaseSlow();
  await old;
  assert.deepEqual(f.authCalls, [
    { token: 'one', expected: undefined },
    { token: 'new', expected: '1' },
  ]);
  assert.equal(f.events.includes('persist-invalidation'), false);
});

test('disconnect during durable reauth sends no callback or private binding to the socket', async () => {
  const f = fixture(true);
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const before = f.sent.length;
  const old = f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'delayed-auth',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await f.authWaiting;
  f.adapter.disconnect(f.socket);
  f.releaseAuth();
  await old;
  assert.equal(f.sent.length, before);
  assert.equal(f.closed.length, 0);
  assert.ok(f.events.includes('persist-invalidation'));
});

test('overlapping initial connect uses the private epoch that the old callback already committed', async () => {
  const f = fixture(true);
  const old = f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'delayed-auth',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await f.authWaiting;
  const latest = f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'new',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.releaseAuth();
  await Promise.all([old, latest]);
  assert.deepEqual(f.authCalls, [
    { token: 'delayed-auth', expected: undefined },
    { token: 'new', expected: '1' },
  ]);
  assert.equal(f.sent.filter((event) => event.type === 'workspace.session').length, 1);
});

test('failed refresh following an old callback must invalidate the already-committed epoch', async () => {
  const f = fixture(true);
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const old = f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'delayed-auth',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await f.authWaiting;
  const latest = f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'expired',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.releaseAuth();
  await Promise.all([old, latest]);
  assert.ok(f.events.includes('persist-invalidation'));
  assert.ok(f.events.includes('lease-revoke'));
  assert.ok(f.sent.some((event) => event.type === 'lease.revoked'));
});

test('new initial connect with a failing token must invalidate the epoch the old callback committed', async () => {
  const f = fixture(true);
  const old = f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'delayed-auth',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await f.authWaiting;
  const latest = f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'expired',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.releaseAuth();
  await Promise.all([old, latest]);
  assert.ok(f.events.includes('persist-invalidation'));
  assert.deepEqual(f.closed, [4401]);
  assert.equal(f.sent.length, 0);
});

test('initial connect does not open routing when the lease is taken over while waiting for online auth', async () => {
  const f = fixture();
  const connect = f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'delayed-auth',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await f.authWaiting;
  f.revokeLease();
  f.releaseAuth();
  await connect;
  assert.deepEqual(f.closed, [4409]);
  assert.equal(
    f.sent.some((message) => message.type === 'workspace.session'),
    false,
  );
});

test('failed refresh persists invalidation before sending the lease signal and does not open private fields', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.ok(!JSON.stringify(f.sent).includes('authEpoch'));
  assert.ok(!JSON.stringify(f.sent).includes('tokenFingerprint'));
  f.events.length = 0;
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'expired',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.deepEqual(f.events, ['persist-invalidation', 'lease-revoke', 'send', 'send']);
  assert.equal(f.closed.length, 0, 'active media policy must not close socket on refresh failure');
});

test('stale heartbeat that lost authorization after a new refresh does not delete or close the new binding', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const old = f.adapter.handle(
    f.socket,
    { type: 'auth:refresh', accessToken: 'old', tabId: 'a', leaseId: f.leaseId },
    'delayed-heartbeat',
  );
  await f.heartbeatWaiting;
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'new',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const before = [...f.events];
  f.releaseHeartbeat();
  await old;
  assert.deepEqual(f.events, before);
  assert.equal(f.closed.length, 0);
  await f.adapter.handle(f.socket, { type: 'lease:heartbeat', leaseId: f.leaseId });
  assert.equal(f.sent.at(-1)?.type, 'lease.active');
});

test('stale lease heartbeat that lost authorization after a new refresh sends no revoke', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const old = f.adapter.handle(
    f.socket,
    { type: 'lease:heartbeat', leaseId: f.leaseId },
    'delayed-heartbeat',
  );
  await f.heartbeatWaiting;
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'new',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const before = [...f.events];
  f.releaseHeartbeat();
  await old;
  assert.deepEqual(f.events, before);
  assert.equal(f.closed.length, 0);
  await f.adapter.handle(f.socket, { type: 'lease:heartbeat', leaseId: f.leaseId });
  assert.equal(f.sent.at(-1)?.type, 'lease.active');
});

test('lease expiring during a refresh that has not committed must close routing of the existing binding', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const heartbeat = f.adapter.handle(
    f.socket,
    { type: 'lease:heartbeat', leaseId: f.leaseId },
    'delayed-heartbeat',
  );
  await f.heartbeatWaiting;
  const refresh = f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'slow',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.releaseHeartbeat();
  await heartbeat;
  assert.equal(f.sent.at(-1)?.type, 'lease.expired');
  f.releaseSlow();
  await refresh;
  assert.equal(f.sent.at(-1)?.type, 'lease.expired');
});

test('two initial connects stuck on heartbeat must use the binding of the newer request', async () => {
  const f = fixture();
  const old = f.adapter.handle(
    f.socket,
    {
      type: 'auth:connect',
      accessToken: 'old',
      tabId: 'a',
      leaseId: f.leaseId,
    },
    'delayed-heartbeat',
  );
  await f.heartbeatWaiting;
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'new',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const before = [...f.events];
  f.releaseHeartbeat();
  await old;
  assert.deepEqual(f.events, before);
  assert.equal(f.closed.length, 0);
  await f.adapter.handle(f.socket, { type: 'lease:heartbeat', leaseId: f.leaseId });
  assert.equal(f.sent.at(-1)?.type, 'lease.active');
});

test('stale claim stuck on the lease does not change the working tab of the new refresh', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const old = f.adapter.handle(
    f.socket,
    { type: 'auth:claim', accessToken: 'old', tabId: 'b', leaseId: f.leaseId },
    'delayed-heartbeat',
  );
  await f.heartbeatWaiting;
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'new',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.releaseHeartbeat();
  await old;
  assert.equal(f.registry.canReceiveRoutingWork(f.tenantId, f.userId, 'a'), true);
  assert.equal(f.registry.canReceiveRoutingWork(f.tenantId, f.userId, 'b'), false);
  assert.equal(f.closed.length, 0);
});

test('token expiring while waiting to commit does not open routing from the lease', async () => {
  const tenantId = randomUUID(),
    userId = randomUUID(),
    leaseId = randomUUID();
  let now = 1_700_000_000_000;
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const registry = new WorkspaceSessionRegistry(() => new Date(now));
  const gateway = new WorkspaceSessionGateway(
    {
      async verifyAccessToken() {
        return {
          tenant_id: tenantId,
          tenant_slug: 'test',
          dc_user_id: userId,
          sid: 'session',
          exp: 1_700_000_100,
          realm_access: { roles: ['agent'] },
        };
      },
    },
    registry,
    { isActive: async () => true },
    () => new Date(now),
  );
  const sent: Record<string, unknown>[] = [];
  const socket: WorkspaceSessionSocket = {
    send: (value) => sent.push(JSON.parse(value)),
    close: () => assert.fail('socket closed'),
  };
  const adapter = new WorkspaceSessionWebSocketAdapter(
    gateway,
    async (_tenant, work) => {
      reached();
      await held;
      return work();
    },
    undefined,
    {
      enforced: async () => true,
      heartbeat: async () => ({ status: 'ACTIVE', expiresAt: new Date('2030-01-01') }),
      isCurrent: async () => true,
      revokeForAuth: async () => false,
    },
  );
  const connecting = adapter.handle(socket, {
    type: 'auth:connect',
    accessToken: 'token',
    tabId: 'a',
    leaseId,
  });
  await waiting;
  now = 1_700_000_200_000;
  release();
  await connecting;
  const event = sent.at(-1) as {
    session: { status: string; routingEnabled: boolean; availability: string };
  };
  assert.equal(event.session.status, 'reauthentication-required');
  assert.equal(event.session.routingEnabled, false);
  assert.equal(event.session.availability, 'OFFLINE');
  assert.equal(
    await adapter.deliverRoutingEvent({
      type: 'routing.offered',
      tenantId,
      userId,
      interactionId: randomUUID(),
    }),
    0,
  );
});

test('stuck signalLease does not unbind or send revoke to the new binding', async () => {
  const tenantId = randomUUID(),
    userId = randomUUID(),
    leaseId = randomUUID();
  let pause = false,
    release!: () => void,
    reached!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waiting = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const gateway = new WorkspaceSessionGateway(
    {
      async verifyAccessToken() {
        return {
          tenant_id: tenantId,
          tenant_slug: 'test',
          dc_user_id: userId,
          sid: 'session',
          exp: 2_000_000_000,
          realm_access: { roles: ['agent'] },
        };
      },
    },
    new WorkspaceSessionRegistry(),
    { isActive: async () => true },
  );
  const sent: Record<string, unknown>[] = [];
  const socket: WorkspaceSessionSocket = {
    send: (value) => sent.push(JSON.parse(value)),
    close: () => assert.fail('socket closed'),
  };
  const adapter = new WorkspaceSessionWebSocketAdapter(
    gateway,
    async (_tenant, work) => {
      if (pause) {
        reached();
        await held;
      }
      return work();
    },
    undefined,
    {
      enforced: async () => true,
      heartbeat: async () => ({ status: 'ACTIVE', expiresAt: new Date('2030-01-01') }),
      isCurrent: async () => true,
      revokeForAuth: async () => false,
    },
  );
  await adapter.handle(socket, { type: 'auth:connect', accessToken: 'one', tabId: 'a', leaseId });
  pause = true;
  const old = adapter.signalLease(tenantId, userId, {
    type: 'lease.revoked',
    leaseId,
    reason: 'takeover',
  });
  await waiting;
  pause = false;
  await adapter.handle(socket, { type: 'auth:refresh', accessToken: 'two', tabId: 'a', leaseId });
  const before = sent.length;
  release();
  assert.equal(await old, 0);
  assert.equal(sent.length, before);
  await adapter.handle(socket, { type: 'lease:heartbeat', leaseId });
  assert.equal(sent.at(-1)?.type, 'lease.active');
});

for (const initial of [false, true])
  test(`stale verified callback that returns late does not overwrite the registry over the new token (had existing binding: ${initial})`, async () => {
    const tenantId = randomUUID(),
      userId = randomUUID();
    let now = 1_700_000_000_000;
    let release!: () => void, reached!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const waiting = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const registry = new WorkspaceSessionRegistry(() => new Date(now));
    const gateway = new WorkspaceSessionGateway(
      {
        async verifyAccessToken(token) {
          if (token === 'old') {
            reached();
            await held;
          }
          return {
            tenant_id: tenantId,
            tenant_slug: 'test',
            dc_user_id: userId,
            sid: token,
            exp: token === 'old' ? 1_700_000_100 : 1_700_001_000,
            realm_access: { roles: ['agent'] },
          };
        },
      },
      registry,
      { isActive: async () => true },
      () => new Date(now),
    );
    const socket: WorkspaceSessionSocket = {
      send: () => undefined,
      close: () => assert.fail('socket closed'),
    };
    const adapter = new WorkspaceSessionWebSocketAdapter(gateway);
    if (initial)
      await adapter.handle(socket, { type: 'auth:connect', accessToken: 'initial', tabId: 'a' });
    const old = adapter.handle(socket, {
      type: initial ? 'auth:refresh' : 'auth:connect',
      accessToken: 'old',
      tabId: 'a',
    });
    await waiting;
    await adapter.handle(socket, {
      type: initial ? 'auth:refresh' : 'auth:connect',
      accessToken: 'new',
      tabId: 'a',
    });
    release();
    await old;
    now = 1_700_000_200_000;
    assert.equal(
      registry.canReceiveRoutingWork(tenantId, userId, 'a'),
      true,
      'registry must use the expiry of the new token',
    );
  });

test('forbidden result persists invalidation before deleting the binding or reporting failure', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.events.length = 0;
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'forbidden',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.deepEqual(f.events, ['persist-invalidation', 'lease-revoke', 'close']);
  assert.deepEqual(f.closed, [4403]);
});

test('stale callback after a successful reauth does not change the new binding', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const old = f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'slow',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'two',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  const before = [...f.events];
  f.releaseSlow();
  await old;
  assert.deepEqual(f.events, before);
  assert.equal(f.closed.length, 0);
});

test('when persist fails, must not report lease revoked or successful invalidation', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.events.length = 0;
  f.failPersistence();
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'expired',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.deepEqual(f.events, ['close']);
  assert.deepEqual(f.closed, [4401]);
});

test('Cus360 online failing after the gateway passed must keep the Voice lease/routing session and close only customer mutation', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.events.length = 0;
  f.failOnline();
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'two',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.deepEqual(f.events, ['persist-invalidation', 'send', 'send']);
  assert.deepEqual(f.sent.at(-1), { type: 'customer.auth', state: 'REAUTH_REQUIRED' });
  const session = f.sent.at(-2) as {
    session: { routingEnabled: boolean; status: string };
    leaseId: string;
  };
  assert.equal(session.session.routingEnabled, true);
  assert.equal(session.session.status, 'active');
  assert.equal(session.leaseId, f.leaseId);
  assert.equal(f.closed.length, 0);
  assert.equal(f.events.includes('lease-revoke'), false);
});

test('Cus360 online and persistence failing do not claim durable state and keep the existing Voice binding', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.events.length = 0;
  f.failOnline();
  f.failPersistence();
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'two',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.deepEqual(f.events, ['send']);
  assert.deepEqual(f.sent.at(-1), { type: 'customer.auth', state: 'UNAVAILABLE' });
  assert.equal(f.closed.length, 0);
  f.events.length = 0;
  await f.adapter.handle(f.socket, { type: 'lease:heartbeat', leaseId: f.leaseId });
  assert.equal(f.sent.at(-1)?.type, 'lease.active', 'the existing binding can still heartbeat');
  assert.equal(f.events.includes('lease-revoke'), false);
});

test('Cus360 not ready before a private binding exists does not claim a durable state change', async () => {
  const f = fixture();
  f.failOnline();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.deepEqual(f.sent.at(-1), { type: 'customer.auth', state: 'UNAVAILABLE' });
  assert.equal(f.closed.length, 0);
  assert.equal(f.events.includes('lease-revoke'), false);
});

test('Cus360 callback with an older binding does not report or change the new binding', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.replaceBinding();
  f.failOnline();
  f.events.length = 0;
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'two',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.deepEqual(f.events, []);
  assert.equal(f.closed.length, 0);
});

test('gateway expiry after the earlier Cus360 invalidation still uses the Voice auth policy without bumping the epoch again', async () => {
  const f = fixture();
  await f.adapter.handle(f.socket, {
    type: 'auth:connect',
    accessToken: 'one',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.failOnline();
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'two',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  f.events.length = 0;
  await f.adapter.handle(f.socket, {
    type: 'auth:refresh',
    accessToken: 'expired',
    tabId: 'a',
    leaseId: f.leaseId,
  });
  assert.deepEqual(f.events, ['already-invalidated', 'lease-revoke', 'send', 'send']);
  const event = f.sent.at(-2) as { session: { routingEnabled: boolean; status: string } };
  assert.equal(event.session.routingEnabled, false);
  assert.equal(event.session.status, 'reauthentication-required');
  assert.equal(f.closed.length, 0);
});
