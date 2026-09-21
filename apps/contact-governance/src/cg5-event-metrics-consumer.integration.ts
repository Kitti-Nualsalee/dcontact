import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { Cg5EventMetricsConsumer, type Cg4InboundEvent } from './index.js';

const NOW = new Date('2026-09-19T10:07:23.000Z');
const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

async function fixture(t: TestContext) {
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
  const tenantId = randomUUID();
  const contactId = randomUUID();

  t.after(async () => {
    await owner.cg5MetricBucket.deleteMany({ where: { tenantId } });
    await owner.cgScopePause.deleteMany({ where: { tenantId } });
    await owner.cgConsumerInbox.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG5.3 ${tenantId}`,
      slug: `cg53-${tenantId}`,
      sipDomain: `${tenantId}.cg53.test`,
    },
  });

  return {
    owner,
    tenantId,
    contactId,
    consumer: new Cg5EventMetricsConsumer(application, { now: () => NOW }),
  };
}

function preferencePayload(version: number) {
  return {
    contractVersion: 1,
    mutationId: randomUUID(),
    subjectVersion: version,
    affectedScope: {
      identityId: null,
      channel: 'VOICE',
      purpose: 'SUPPORT',
      contactKind: null,
    },
    effectiveAt: NOW.toISOString(),
    stateDigest: HASH_A,
  };
}

function event(
  f: Awaited<ReturnType<typeof fixture>>,
  overrides: Partial<Cg4InboundEvent> = {},
): Cg4InboundEvent {
  const version = overrides.aggregateVersion ?? 1;
  return {
    tenantId: f.tenantId,
    eventId: randomUUID(),
    eventType: 'preference.changed',
    aggregateType: 'CONTACT',
    aggregateId: f.contactId,
    aggregateVersion: version,
    payloadHash: version === 1 ? HASH_A : HASH_B,
    payload: preferencePayload(version),
    receivedAt: NOW,
    ...overrides,
  };
}

async function bucketSummary(f: Awaited<ReturnType<typeof fixture>>) {
  const buckets = await f.owner.cg5MetricBucket.findMany({
    where: { tenantId: f.tenantId },
    orderBy: [{ metricKey: 'asc' }, { granularity: 'asc' }],
  });
  return buckets.map((bucket) => ({
    metricKey: bucket.metricKey,
    granularity: bucket.granularity,
    value: bucket.value.toString(),
    sampleCount: bucket.sampleCount,
    channel: bucket.channel,
    purpose: bucket.purpose,
  }));
}

test('duplicate delivery เพิ่ม event metrics เพียงครั้งเดียว และไม่แตะ canonical state', async (t) => {
  const f = await fixture(t);
  const original = event(f);
  const applied = await f.consumer.consume(original);
  const replay = await f.consumer.consume(original);

  assert.equal(applied.decision.kind, 'APPLY');
  assert.equal(replay.decision.kind, 'DUPLICATE');
  assert.deepEqual(await bucketSummary(f), [
    {
      metricKey: 'cg.audit',
      granularity: 'FIVE_MIN',
      value: '1',
      sampleCount: 1n,
      channel: 'VOICE',
      purpose: 'SUPPORT',
    },
    {
      metricKey: 'cg.audit',
      granularity: 'HOUR',
      value: '1',
      sampleCount: 1n,
      channel: 'VOICE',
      purpose: 'SUPPORT',
    },
    {
      metricKey: 'cg.audit',
      granularity: 'DAY',
      value: '1',
      sampleCount: 1n,
      channel: 'VOICE',
      purpose: 'SUPPORT',
    },
    {
      metricKey: 'cg.restriction',
      granularity: 'FIVE_MIN',
      value: '1',
      sampleCount: 1n,
      channel: 'VOICE',
      purpose: 'SUPPORT',
    },
    {
      metricKey: 'cg.restriction',
      granularity: 'HOUR',
      value: '1',
      sampleCount: 1n,
      channel: 'VOICE',
      purpose: 'SUPPORT',
    },
    {
      metricKey: 'cg.restriction',
      granularity: 'DAY',
      value: '1',
      sampleCount: 1n,
      channel: 'VOICE',
      purpose: 'SUPPORT',
    },
  ]);
  assert.equal(await f.owner.cgEventOutbox.count({ where: { tenantId: f.tenantId } }), 0);
  assert.equal(await f.owner.cgAuditLog.count({ where: { tenantId: f.tenantId } }), 0);
});

test('CG5-CC02 consumer สองตัวรับ event เดียวกันพร้อมกันนับครั้งเดียว', async (t) => {
  const f = await fixture(t);
  const second = new PrismaClient({
    datasources: {
      db: {
        url:
          process.env.APPLICATION_DATABASE_URL ??
          'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public',
      },
    },
  });
  t.after(() => second.$disconnect());
  const consumers = [f.consumer, new Cg5EventMetricsConsumer(second, { now: () => NOW })];
  const original = event(f);
  const settled = await Promise.allSettled(consumers.map((consumer) => consumer.consume(original)));
  const applied = settled.filter(
    (result) => result.status === 'fulfilled' && result.value.decision.kind === 'APPLY',
  );
  assert.equal(applied.length, 1);
  // ตัวที่แพ้ race ได้ DUPLICATE หรือ error ที่ retry ได้ — retry ต้องเป็น DUPLICATE ไม่ใช่ APPLY ซ้ำ
  assert.equal((await consumers[1]!.consume(original)).decision.kind, 'DUPLICATE');
  const summary = await bucketSummary(f);
  assert.equal(summary.length, 6);
  assert.ok(summary.every((bucket) => bucket.value === '1' && bucket.sampleCount === 1n));
});

test('gap pause scope โดยไม่เพิ่ม projection bucket', async (t) => {
  const f = await fixture(t);
  await f.consumer.consume(event(f));
  const before = await bucketSummary(f);

  const gap = await f.consumer.consume(event(f, { aggregateVersion: 3 }));
  assert.equal(gap.decision.kind, 'GAP');
  assert.equal(await f.consumer.isPaused(f.tenantId, { kind: 'CONTACT', ref: f.contactId }), true);
  assert.deepEqual(await bucketSummary(f), before);
});

test('out-of-order pause scope โดยไม่เพิ่ม projection bucket', async (t) => {
  const f = await fixture(t);
  const aggregateId = randomUUID();
  await f.consumer.consume(event(f, { aggregateId, aggregateVersion: 1 }));
  await f.consumer.consume(event(f, { aggregateId, aggregateVersion: 2 }));
  const before = await bucketSummary(f);

  const stale = await f.consumer.consume(
    event(f, { aggregateId, aggregateVersion: 1, eventId: randomUUID() }),
  );
  assert.equal(stale.decision.kind, 'OUT_OF_ORDER');
  assert.equal(await f.consumer.isPaused(f.tenantId, { kind: 'CONTACT', ref: aggregateId }), true);
  assert.deepEqual(await bucketSummary(f), before);
  const pauses = await f.consumer.activePauses(f.tenantId);
  assert.equal(pauses.length, 1);
  assert.equal(pauses[0]?.reason, 'EVENT_OUT_OF_ORDER');
});
