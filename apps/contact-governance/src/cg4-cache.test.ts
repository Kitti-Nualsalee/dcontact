import assert from 'node:assert/strict';
import test from 'node:test';
import {
  Cg4Cache,
  cg4HeadValidUntil,
  resolveCg4CachedHead,
  type Cg4CacheClient,
} from './cg4-cache.js';

const NOW = new Date('2026-01-05T12:00:00.000Z');
const DIGEST = 'a'.repeat(64);

/** In-memory stand-in with the same three calls the cache uses on ioredis. */
class FakeRedis implements Cg4CacheClient {
  readonly store = new Map<string, { value: string; ttlSeconds: number }>();
  failing = false;

  async get(key: string): Promise<string | null> {
    if (this.failing) throw new Error('redis unavailable');
    return this.store.get(key)?.value ?? null;
  }

  async set(key: string, value: string, _mode: 'EX', ttlSeconds: number): Promise<unknown> {
    if (this.failing) throw new Error('redis unavailable');
    this.store.set(key, { value, ttlSeconds });
    return 'OK';
  }

  async del(...keys: string[]): Promise<unknown> {
    if (this.failing) throw new Error('redis unavailable');
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }
}

function cache(now: Date = NOW, headTtlSeconds = 30) {
  const redis = new FakeRedis();
  return { redis, cache: new Cg4Cache(redis, { headTtlSeconds, now: () => now }) };
}

test('key scheme ตรงกับ #179 §5 และ immutable key ผูก version+digest', () => {
  const { cache: subject } = cache();
  assert.equal(subject.policySnapshotKey('t', 'p', 3, DIGEST), `cg:policy:t:p:3:${DIGEST}`);
  assert.equal(subject.policyHeadKey('t', 'p'), 'cg:policy:t:p:head');
  assert.equal(subject.exceptionSnapshotKey('t', 's', 2, DIGEST), `cg:exception:t:s:2:${DIGEST}`);
  assert.equal(subject.exceptionHeadKey('t', 's'), 'cg:exception:t:s:head');
  assert.equal(subject.contactSnapshotKey('t', 'c', 9), 'cg:contact:t:c:9');
});

test('authorization projection ผูก epoch และ scope version ไว้ใน key', () => {
  const { cache: subject } = cache();
  assert.equal(subject.authorizationKey('t', 'sub', 4, 2), 'cg:authz:t:sub:4:2');
  // epoch ที่ขยับทำให้ entry เดิมเข้าไม่ถึงอีก แทนที่จะแค่เก่า
  assert.notEqual(
    subject.authorizationKey('t', 'sub', 4, 2),
    subject.authorizationKey('t', 'sub', 5, 2),
  );
});

test('validUntil ถูกตัดด้วย TTL หรือ nextActivationAt แล้วแต่อันไหนมาก่อน', () => {
  assert.equal(
    cg4HeadValidUntil({ now: NOW, ttlSeconds: 30 }).toISOString(),
    '2026-01-05T12:00:30.000Z',
  );
  assert.equal(
    cg4HeadValidUntil({
      now: NOW,
      ttlSeconds: 30,
      nextActivationAt: new Date('2026-01-05T12:00:10.000Z'),
    }).toISOString(),
    '2026-01-05T12:00:10.000Z',
  );
  assert.equal(
    cg4HeadValidUntil({
      now: NOW,
      ttlSeconds: 30,
      nextActivationAt: new Date('2026-01-05T18:00:00.000Z'),
    }).toISOString(),
    '2026-01-05T12:00:30.000Z',
  );
});

test('head ที่ถึง validUntil พอดีถือว่าหมดอายุแล้ว', () => {
  const entry = { version: 3, digest: DIGEST, validUntil: '2026-01-05T12:00:30.000Z' };
  assert.equal(resolveCg4CachedHead(entry, new Date('2026-01-05T12:00:29.999Z')).usable, true);
  const atBoundary = resolveCg4CachedHead(entry, new Date('2026-01-05T12:00:30.000Z'));
  assert.equal(atBoundary.usable, false);
  assert.ok(!atBoundary.usable);
  assert.equal(atBoundary.reason, 'EXPIRED');
  assert.equal(resolveCg4CachedHead(undefined, NOW).usable, false);
});

test('setHead เขียน TTL ของ Redis ให้ไม่เกิน validUntil ที่ประกาศไว้', async () => {
  const { redis, cache: subject } = cache();
  const key = subject.policyHeadKey('t', 'p');
  await subject.setHead(key, {
    version: 3,
    digest: DIGEST,
    nextActivationAt: new Date('2026-01-05T12:00:05.000Z'),
  });
  assert.equal(redis.store.get(key)?.ttlSeconds, 5);
  const entry = JSON.parse(redis.store.get(key)!.value) as { validUntil: string };
  assert.equal(entry.validUntil, '2026-01-05T12:00:05.000Z');
});

test('head ที่หมดอายุอ่านไม่ได้แม้ยังอยู่ใน store', async () => {
  const redis = new FakeRedis();
  let clock = NOW;
  const subject = new Cg4Cache(redis, { headTtlSeconds: 30, now: () => clock });
  const key = subject.policyHeadKey('t', 'p');
  await subject.setHead(key, { version: 3, digest: DIGEST });
  assert.equal((await subject.getHead(key)).usable, true);

  clock = new Date('2026-01-05T12:00:31.000Z');
  const stale = await subject.getHead(key);
  assert.equal(stale.usable, false);
  assert.ok(!stale.usable);
  assert.equal(stale.reason, 'EXPIRED');
  assert.equal(subject.snapshotStats().expired, 1);
});

test('Redis ที่ล่มไม่ throw แต่บอก caller ว่าอ่านไม่ได้เพื่อให้ไป canonical', async () => {
  const { redis, cache: subject } = cache();
  const key = subject.policyHeadKey('t', 'p');
  await subject.setHead(key, { version: 3, digest: DIGEST });
  redis.failing = true;

  const head = await subject.getHead(key);
  assert.equal(head.usable, false);
  assert.ok(!head.usable);
  assert.equal(head.reason, 'UNAVAILABLE');
  assert.equal(
    await subject.getSnapshot(subject.policySnapshotKey('t', 'p', 3, DIGEST)),
    undefined,
  );
  // เขียนและ invalidate ก็ไม่ throw — ทำให้ path ปกติเดินต่อได้ด้วย canonical read
  await subject.setSnapshot('cg:policy:t:p:3:' + DIGEST, { any: 'thing' });
  await subject.invalidatePolicyHead('t', 'p');
  assert.ok(subject.snapshotStats().unavailable >= 4);
});

test('invalidate ลบเฉพาะ mutable head ไม่แตะ immutable snapshot', async () => {
  const { redis, cache: subject } = cache();
  const snapshotKey = subject.policySnapshotKey('t', 'p', 3, DIGEST);
  await subject.setSnapshot(snapshotKey, { version: 3 });
  await subject.setHead(subject.policyHeadKey('t', 'p'), { version: 3, digest: DIGEST });
  await subject.setHead(subject.exceptionHeadKey('t', 's'), { version: 1, digest: DIGEST });

  await subject.invalidatePolicyHead('t', 'p');
  await subject.invalidateExceptionHead('t', 's');
  assert.equal(redis.store.has(subject.policyHeadKey('t', 'p')), false);
  assert.equal(redis.store.has(subject.exceptionHeadKey('t', 's')), false);
  assert.deepEqual(await subject.getSnapshot(snapshotKey), { version: 3 });
});

test('snapshot ที่พังอ่านเป็น miss แทนที่จะ throw', async () => {
  const { redis, cache: subject } = cache();
  redis.store.set('cg:policy:t:p:3:' + DIGEST, { value: '{not json', ttlSeconds: 60 });
  assert.equal(await subject.getSnapshot('cg:policy:t:p:3:' + DIGEST), undefined);
  assert.equal(subject.snapshotStats().misses, 1);
});
