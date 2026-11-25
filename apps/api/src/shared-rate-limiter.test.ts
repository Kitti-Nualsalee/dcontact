import assert from 'node:assert/strict';
import test from 'node:test';
import {
  C360_SEARCH_POLICY,
  createCustomer360SearchLimiter,
  RedisSharedRateLimiter,
} from './shared-rate-limiter.js';

const input = { tenantId: 'tenant', actorId: 'actor', policy: C360_SEARCH_POLICY };

test('no Redis configuration does not allow search', async () => {
  await assert.rejects(createCustomer360SearchLimiter(undefined).consume(input));
  await assert.rejects(createCustomer360SearchLimiter('').consume(input));
});

test('a malformed Redis result must fail closed', async () => {
  for (const value of [null, [], [1, 1], [0, -1], [0, 60001], ['1', 0]]) {
    const limiter = new RedisSharedRateLimiter({ eval: async () => value });
    await assert.rejects(limiter.consume(input));
  }
});
