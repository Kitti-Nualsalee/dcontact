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

test('AC4 (#597): window กำหนดได้ เช่น 5 ครั้งต่อชั่วโมง', () => {
  let now = new Date('2026-10-06T00:00:00.000Z');
  const limiter = new TenantClientRateLimiter(() => now);
  const hourly = {
    tenantId: 't',
    clientId: 'user:password',
    limitPerMinute: 1,
    windowMs: 3_600_000,
  };
  assert.equal(limiter.consume(hourly), null);
  now = new Date('2026-10-06T00:30:00.000Z');
  assert.deepEqual(limiter.consume(hourly), { retryAfterSeconds: 1_800 });
  now = new Date('2026-10-06T01:00:00.000Z');
  assert.equal(limiter.consume(hourly), null);
  assert.throws(() => limiter.consume({ ...hourly, windowMs: 0 }), TypeError);
});
