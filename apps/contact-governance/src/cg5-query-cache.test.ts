import assert from 'node:assert/strict';
import test from 'node:test';
import { Cg5QueryCache, type Cg5QueryCacheClient } from './cg5-query-cache.js';

class FakeRedis implements Cg5QueryCacheClient {
  readonly values = new Map<string, string>();
  fail = false;
  async get(key: string) {
    if (this.fail) throw new Error('redis unavailable');
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string) {
    if (this.fail) throw new Error('redis unavailable');
    this.values.set(key, value);
  }
}

test('CG5 cache key แยก team scope และ fallback เมื่อ Redis ล่ม', async () => {
  const redis = new FakeRedis();
  const cache = new Cg5QueryCache(redis, () => new Date('2026-09-20T00:00:00.000Z'));
  const base = {
    tenantId: 'tenant-a',
    kind: 'metrics' as const,
    query: { granularity: 'FIVE_MIN' },
  };
  const teamA = cache.key({ ...base, scope: { kind: 'TEAM', teamId: 'team-a' } });
  const teamB = cache.key({ ...base, scope: { kind: 'TEAM', teamId: 'team-b' } });
  const tenant = cache.key({ ...base, scope: { kind: 'TENANT' } });
  assert.notEqual(teamA, teamB);
  assert.notEqual(teamA, tenant);
  let loads = 0;
  const input = {
    key: teamA,
    refreshIntervalSeconds: 60,
    load: async () => ({ asOf: new Date('2026-09-20T00:00:00.000Z'), value: ++loads }),
  };
  assert.equal((await cache.getOrLoad(input)).value, 1);
  assert.equal((await cache.getOrLoad(input)).value, 1);
  redis.fail = true;
  assert.equal((await cache.getOrLoad(input)).value, 2);
});
