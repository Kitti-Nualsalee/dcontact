import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { WorkspaceSessionGateway, WorkspaceSessionRegistry } from './workspace-session.js';
import {
  WorkspaceSessionWebSocketAdapter,
  type WorkspaceSessionSocket,
} from './websocket-session-adapter.js';
import type { WorkspaceMutationAuthBinding } from './mutation-auth.js';

function fixture() {
  const tenantId = randomUUID(),
    userId = randomUUID(),
    leaseId = randomUUID();
  const events: string[] = [],
    sent: Record<string, unknown>[] = [],
    closed: number[] = [];
  let epoch = 0;
  let persistenceFailure = false;
  let onlineFailure = false;
  let slow: (() => void) | undefined;
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
    new WorkspaceSessionRegistry(),
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
    undefined,
    undefined,
    {
      enforced: async () => true,
      heartbeat: async () => ({ status: 'ACTIVE', expiresAt: new Date('2030-01-01') }),
      isCurrent: async () => true,
      async revokeForAuth() {
        events.push('lease-revoke');
        return false;
      },
    },
    {
      async reauthenticate({ accessToken }) {
        if (onlineFailure) throw Error('identity unavailable');
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
        assert.equal(Number(binding.authEpoch), epoch);
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
    events,
    sent,
    closed,
    failOnline: () => {
      onlineFailure = true;
    },
    failPersistence: () => {
      persistenceFailure = true;
    },
    releaseSlow: () => slow?.(),
  };
}

test('refresh ล้ม persist invalidation ก่อนส่ง lease signal และไม่เปิด private fields', async () => {
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

test('ผล forbidden persist invalidation ก่อนลบ binding หรือรายงาน failure', async () => {
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

test('callback เก่าหลัง reauth สำเร็จไม่เปลี่ยน binding ใหม่', async () => {
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

test('เมื่อ persist ล้มต้องไม่รายงาน lease revoked หรือ invalidation สำเร็จ', async () => {
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

test('Cus360 online ล้มหลัง gateway ผ่านต้องคง Voice lease/routing session และปิดเฉพาะ customer mutation', async () => {
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
