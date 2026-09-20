import assert from 'node:assert/strict';
import test from 'node:test';
import { TenantClientRateLimiter } from './tenant-client-rate-limiter.js';

test('rate limiter แยก tenant/client และคืน Retry-After จนกว่าจะขึ้น window ใหม่', () => {
  let now = new Date('2026-09-20T00:00:00.000Z');
  const limiter = new TenantClientRateLimiter(() => now);
  assert.equal(limiter.consume({ tenantId: 'a', clientId: 'one', limitPerMinute: 2 }), null);
  assert.equal(limiter.consume({ tenantId: 'a', clientId: 'one', limitPerMinute: 2 }), null);
  assert.deepEqual(limiter.consume({ tenantId: 'a', clientId: 'one', limitPerMinute: 2 }), {
    retryAfterSeconds: 60,
  });
  assert.equal(limiter.consume({ tenantId: 'a', clientId: 'two', limitPerMinute: 2 }), null);
  assert.equal(limiter.consume({ tenantId: 'b', clientId: 'one', limitPerMinute: 2 }), null);
  now = new Date('2026-09-20T00:01:00.000Z');
  assert.equal(limiter.consume({ tenantId: 'a', clientId: 'one', limitPerMinute: 2 }), null);
});
