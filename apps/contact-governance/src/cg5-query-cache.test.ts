import assert from 'node:assert/strict';
import test from 'node:test';
import { Cg5QueryCache, type Cg5QueryCacheClient } from './cg5-query-cache.js';

class FakeRedis implements Cg5QueryCacheClient {
  readonly values = new Map<string, string>();
  readonly ttls: number[] = [];
  fail = false;
  async get(key: string) {
    if (this.fail) throw new Error('redis unavailable');
    return this.values.get(key) ?? null;
  }
  async set(key: string, value: string, _mode: 'EX', ttlSeconds: number) {
    if (this.fail) throw new Error('redis unavailable');
    this.ttls.push(ttlSeconds);
    this.values.set(key, value);
  }
}

test('CG5 cache ไม่ตอบข้อมูลเก่ากว่า asOf ที่ประกาศและไม่อยู่เกินรอบ refresh', async () => {
  const redis = new FakeRedis();
  let now = new Date('2026-09-20T00:00:00.000Z');
  const cache = new Cg5QueryCache(redis, () => now);
  const key = cache.key({
    tenantId: 'tenant-a',
    kind: 'metrics',
    scope: { kind: 'TENANT' },
    query: { granularity: 'FIVE_MIN' },
  });
  let projectionAsOf = new Date('2026-09-19T23:59:00.000Z');
  let loads = 0;
  const input = {
    key,
    refreshIntervalSeconds: 60,
    load: async () => ({ asOf: projectionAsOf, value: ++loads }),
  };

  const first = await cache.getOrLoad(input);
  const hit = await cache.getOrLoad(input);
  assert.equal(hit.value, first.value);
  // entry ที่ตอบจาก cache ต้องประกาศ asOf เดียวกับ projection ที่ถูกอ่าน ไม่ใช่เวลาที่เขียน cache
  assert.equal(new Date(hit.asOf as Date | string).toISOString(), projectionAsOf.toISOString());
  assert.deepEqual(redis.ttls, [60]);

  // Redis ยังถือ entry เดิมอยู่ แต่เกินรอบ refresh แล้ว: ต้องอ่าน projection ใหม่ ไม่ตอบของเก่า
  projectionAsOf = new Date('2026-09-20T00:00:59.000Z');
  now = new Date('2026-09-20T00:01:00.000Z');
  const refreshed = await cache.getOrLoad(input);
  assert.equal(refreshed.value, first.value + 1);
  assert.equal(refreshed.asOf, projectionAsOf);
  assert.ok(redis.ttls.every((ttl) => ttl <= input.refreshIntervalSeconds));

  // entry ที่เสียหายหรือไม่มีเวลาหมดอายุถือเป็น miss ไม่ใช่ข้อมูลที่ไม่รู้อายุ
  redis.values.set(
    key,
    JSON.stringify({ asOf: projectionAsOf.toISOString(), value: { asOf: null } }),
  );
  assert.equal((await cache.getOrLoad(input)).value, first.value + 2);
});

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
