import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { Redis } from 'ioredis';
import { Customer360ReadController } from './customer-360-read-api.js';
import { setup } from './customer-360-test-fixtures.js';
import {
  C360_SEARCH_POLICY,
  createCustomer360SearchLimiter,
  RedisSharedRateLimiter,
} from './shared-rate-limiter.js';

const url = process.env.C360_RATE_LIMIT_TEST_REDIS_URL;
const options = {
  enableOfflineQueue: false,
  maxRetriesPerRequest: 0,
  autoResendUnfulfilledCommands: false,
  commandTimeout: 1000,
};
const skip = !url ? 'NOT_RUN: ต้องตั้ง C360_RATE_LIMIT_TEST_REDIS_URL สำหรับ Redis แยก' : false;
const client = () => {
  const redis = new Redis(url!, { ...options, lazyConnect: true });
  redis.on('error', () => undefined);
  return redis;
};

test(
  'HTTP: ไม่มี Redis configuration ปิดเฉพาะ search ไม่ปิด profile route',
  { skip },
  async (t) => {
    const f = await setup([Customer360ReadController], createCustomer360SearchLimiter(undefined));
    t.after(() => f.close());
    const search = await f.request('customer-360/contacts/search', 'admin', {});
    assert.equal(search.status, 503);
    assert.equal(search.body.error.code, 'RATE_LIMITER_UNAVAILABLE');
    const profile = await f.request(`customer-360/contacts/${randomUUID()}`, 'admin');
    assert.equal(profile.status, 404);
  },
);

async function clients(t: import('node:test').TestContext) {
  const a = client();
  const b = client();
  t.after(() => {
    a.disconnect();
    b.disconnect();
  });
  await Promise.all([a.connect(), b.connect()]);
  return { a, b, first: new RedisSharedRateLimiter(a), second: new RedisSharedRateLimiter(b) };
}

test(
  'Redis จริง: สอง instance แข่งกันใช้ quota actor ร่วมกันและแยก actor/tenant',
  { skip },
  async (t) => {
    const { a, first, second } = await clients(t);
    const tenantId = randomUUID();
    const actorId = randomUUID();
    const input = { tenantId, actorId, policy: C360_SEARCH_POLICY };
    const results = await Promise.all(
      Array.from({ length: 90 }, (_, i) => (i % 2 ? first : second).consume(input)),
    );
    assert.equal(results.filter((r) => r === null).length, 60);
    for (const r of results.filter((r) => r !== null))
      assert.ok(r!.retryAfterSeconds >= 1 && r!.retryAfterSeconds <= 60);
    assert.equal(await first.consume({ ...input, actorId: randomUUID() }), null);
    assert.equal(await second.consume({ ...input, tenantId: randomUUID() }), null);
    const keys = await a.keys(`dc:rate:{${createHash('sha256').update(tenantId).digest('hex')}}:*`);
    assert.ok(keys.length >= 2);
    assert.ok(keys.every((key) => !key.includes(tenantId) && !key.includes(actorId)));
  },
);

test(
  'Redis จริง: tenant quota รวมทุก actor และไม่กิน actor quota เมื่อ tenant เต็ม',
  { skip },
  async (t) => {
    const { a, first, second } = await clients(t);
    const policy = { name: 'test-tenant-v1', actorLimit: 10, tenantLimit: 3, windowMs: 60_000 };
    const tenantId = randomUUID();
    const freshActor = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 9 }, () => first.consume({ tenantId, actorId: randomUUID(), policy })),
    );
    assert.equal(results.filter((r) => r === null).length, 3);
    assert.ok(await second.consume({ tenantId, actorId: freshActor, policy }));
    const actorKey = `dc:rate:{${createHash('sha256').update(tenantId).digest('hex')}}:${policy.name}:actor:${createHash('sha256').update(freshActor).digest('hex')}`;
    assert.equal(await a.exists(actorKey), 0);
    // Other tenant remains independent.
    assert.equal(
      await first.consume({ tenantId: randomUUID(), actorId: freshActor, policy }),
      null,
    );
  },
);

test(
  'Redis จริง: Retry-After, window expiry, corrupt state และการเชื่อมต่อกลับ',
  { skip },
  async (t) => {
    const { a, first } = await clients(t);
    const tenantId = randomUUID();
    const input = {
      tenantId,
      actorId: randomUUID(),
      policy: { name: 'test-expiry-v1', actorLimit: 1, tenantLimit: 2, windowMs: 1100 },
    };
    assert.equal(await first.consume(input), null);
    const rejected = await first.consume(input);
    assert.ok(rejected && rejected.retryAfterSeconds >= 1 && rejected.retryAfterSeconds <= 2);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(await first.consume(input), null);
    assert.ok(await first.consume(input));
    const prefix = `dc:rate:{${createHash('sha256').update(tenantId).digest('hex')}}:${input.policy.name}`;
    await a.set(`${prefix}:tenant`, '1'); // no TTL: fail closed, do not repair/reset
    await assert.rejects(first.consume({ ...input, actorId: randomUUID() }));
  },
);

test(
  'HTTP สอง instance ใช้ Redis quota ร่วมกันและคืน 503 เมื่อ Redis ใช้ไม่ได้',
  { skip },
  async (t) => {
    const { b, first, second } = await clients(t);
    const f = await setup([Customer360ReadController], first);
    t.after(() => f.close());
    const replica = await f.startReplica(second);
    t.after(() => replica.close());
    const requestReplica = (body: unknown) =>
      fetch(`${replica.base}/api/v1/customer-360/contacts/search`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    for (let i = 0; i < 60; i++) {
      const response =
        i % 2 === 0
          ? await f.request('customer-360/contacts/search', 'admin', {})
          : await requestReplica({});
      assert.equal(response.status, 200);
    }
    const limited = await requestReplica({});
    assert.equal(limited.status, 429);
    assert.equal(
      ((await limited.json()) as { error: { code: string } }).error.code,
      'RATE_LIMITED',
    );
    assert.ok(Number(limited.headers.get('retry-after')) > 0);
    b.disconnect();
    // Invalid body would otherwise be 400: the Redis failure is observed before search.
    const unavailable = await requestReplica({ invalid: true });
    const error = (await unavailable.json()) as { error: { code: string; retryable: boolean } };
    assert.equal(unavailable.status, 503);
    assert.equal(error.error.code, 'RATE_LIMITER_UNAVAILABLE');
    assert.equal(error.error.retryable, true);
    assert.equal(unavailable.headers.get('retry-after'), '1');
    assert.equal(unavailable.headers.get('cache-control'), 'no-store');
  },
);

test(
  'Redis ค้างจริง: fail closed ภายในเวลาและกลับมาใช้ได้หลังคืนบริการ',
  {
    skip:
      !url || !process.env.C360_RATE_LIMIT_TEST_REDIS_CONTAINER
        ? 'NOT_RUN: ต้องใช้ Redis container แยกของ runner'
        : false,
  },
  async (t) => {
    const name = process.env.C360_RATE_LIMIT_TEST_REDIS_CONTAINER!;
    assert.match(name, /^c360-866-redis-[a-f0-9]{12}$/);
    const { a, first } = await clients(t);
    const input = { tenantId: randomUUID(), actorId: randomUUID(), policy: C360_SEARCH_POLICY };
    assert.equal(await first.consume(input), null);
    let stopped = false;
    t.after(() => {
      if (stopped) execFileSync('docker', ['unpause', name], { stdio: 'ignore' });
    });
    execFileSync('docker', ['pause', name], { stdio: 'ignore' });
    stopped = true;
    const start = Date.now();
    await assert.rejects(first.consume(input));
    assert.ok(Date.now() - start < 2500, 'Redis unavailable ต้องตอบในเวลาจำกัด');
    execFileSync('docker', ['unpause', name], { stdio: 'ignore' });
    stopped = false;
    let recovered = false;
    for (let i = 0; i < 80; i++) {
      try {
        await a.ping();
        recovered = true;
        break;
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(recovered, true, 'Redis ต้อง reconnect ได้');
    assert.equal(await first.consume({ ...input, actorId: randomUUID() }), null);
  },
);
