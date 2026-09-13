import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient, type Prisma } from '@d-contact/db';
import type { DcProducer, KafkaEventEnvelope } from '@d-contact/kafka';
import type { KafkaTopic } from '@d-contact/shared';
import { stableDigest } from './cg3-persistence.js';
import { Cg4Cache, type Cg4CacheClient } from './cg4-cache.js';
import { Cg4EventRelay } from './cg4-event-relay.js';
import type { Cg4PolicyLifecycleRepository } from './cg4-policy-lifecycle.js';
import { Cg4ActivationWorker, Cg4ExpirySweeper } from './cg4-workers.js';

/**
 * CG4.6 (#189): relay, activation worker and expiry sweeper against a real database.
 *
 * The producer is a stub rather than a broker: everything this slice owns on the publish
 * path — lease claim and recovery, contract quarantine, backoff, cache invalidation — is
 * decided in Postgres, so a stub exercises all of it while keeping the suite runnable
 * without Kafka. Broker-side delivery stays covered by cg3-event-relay.integration.ts.
 */

const NOW = new Date('2026-01-05T12:00:00.000Z');
const DIGEST = 'a'.repeat(64);

class StubProducer implements DcProducer {
  readonly sent: Array<{ topic: string; eventId: string; type: string; payload: unknown }> = [];
  failNext = false;

  async send<TPayload extends Record<string, unknown>>(
    topic: KafkaTopic,
    event: KafkaEventEnvelope<TPayload>,
  ): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('broker unavailable');
    }
    this.sent.push({
      topic,
      eventId: event.eventId,
      type: event.type,
      payload: event.payload,
    });
  }

  async disconnect(): Promise<void> {}
}

class FakeRedis implements Cg4CacheClient {
  readonly store = new Map<string, string>();
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }
  async set(key: string, value: string): Promise<unknown> {
    this.store.set(key, value);
    return 'OK';
  }
  async del(...keys: string[]): Promise<unknown> {
    let removed = 0;
    for (const key of keys) if (this.store.delete(key)) removed += 1;
    return removed;
  }
}

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
  const tenant = randomUUID();
  const contact = randomUUID();
  const policyId = randomUUID();

  t.after(async () => {
    await owner.cg4PolicyActivationJob.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ExceptionHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Exception.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4ContactExceptionHead.deleteMany({ where: { tenantId: tenant } });
    await owner.cg4Policy.deleteMany({ where: { tenantId: tenant } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId: tenant } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId: tenant } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId: tenant } });
    await owner.contact.deleteMany({ where: { tenantId: tenant } });
    await owner.tenant.deleteMany({ where: { id: tenant } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenant,
      name: `CG4.6 ${tenant}`,
      slug: `cg46r-${tenant}`,
      sipDomain: `${tenant}.cg46r.test`,
    },
  });
  await owner.contact.create({ data: { id: contact, tenantId: tenant, displayName: 'CG4.6' } });
  await owner.cg4Policy.create({
    data: {
      id: randomUUID(),
      tenantId: tenant,
      policyId,
      version: 1,
      scopeKey: 'channel=VOICE|contactKind=*|purpose=*|sourceType=*',
      content: { allowedOperationalRuleCodes: ['QUIET_HOURS'] },
      contentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      status: 'DRAFT',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      makerActorRef: 'maker-1',
    },
  });

  const redis = new FakeRedis();
  const producer = new StubProducer();
  return {
    owner,
    application,
    tenant,
    contact,
    policyId,
    redis,
    producer,
    cache: new Cg4Cache(redis, { now: () => NOW }),
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function canonicalPayload(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    mutationId: randomUUID(),
    transitionKind: 'POLICY_ACTIVATED',
    subjectId: randomUUID(),
    subjectVersion: 1,
    state: 'ACTIVE',
    effectiveAt: NOW.toISOString(),
    affectedScope: { scopeKey: 'channel=VOICE|contactKind=*|purpose=*|sourceType=*' },
    scopeDigest: 'c'.repeat(64),
    ruleRegistryVersion: 'CG4_RULE_REGISTRY_V1',
    policySchemaVersion: 1,
    evaluatorVersion: 'CG4_EVALUATOR_V1',
    stateDigest: 'd'.repeat(64),
    restrictiveness: 'TIGHTENING',
    ...overrides,
  };
}

async function outboxRow(
  f: Fixture,
  overrides: {
    aggregateType?: 'CONTACT' | 'POLICY';
    aggregateId?: string;
    eventType?: string;
    payload?: Record<string, unknown>;
    aggregateVersion?: number;
  } = {},
) {
  const payload = overrides.payload ?? canonicalPayload();
  return f.owner.cgEventOutbox.create({
    data: {
      id: randomUUID(),
      mutationId: randomUUID(),
      tenantId: f.tenant,
      aggregateType: overrides.aggregateType ?? 'POLICY',
      aggregateId: overrides.aggregateId ?? f.policyId,
      aggregateVersion: overrides.aggregateVersion ?? 1,
      eventType: overrides.eventType ?? 'policy.changed',
      orderingKey: `${f.tenant}:${f.policyId}`,
      payload: payload as unknown as Prisma.InputJsonValue,
      payloadHash: stableDigest(payload),
      // Default is the real wall clock, which is far ahead of the pinned test clock.
      availableAt: NOW,
    },
  });
}

function relay(f: Fixture, options: Record<string, unknown> = {}) {
  return new Cg4EventRelay(f.application, f.producer, {
    now: () => NOW,
    cache: f.cache,
    leaseOwner: 'relay-test',
    ...options,
  });
}

test('relay เผยแพร่ canonical event ด้วย eventId เดิม แล้ว mark PUBLISHED', async (t) => {
  const f = await fixture(t);
  const row = await outboxRow(f);
  const result = await relay(f).publishNext(f.tenant);
  assert.equal(result?.state, 'PUBLISHED');
  assert.equal(f.producer.sent.length, 1);
  assert.equal(f.producer.sent[0]?.eventId, row.id);
  assert.equal(f.producer.sent[0]?.topic, 'dc.contact-governance.events');

  const after = await f.owner.cgEventOutbox.findFirstOrThrow({ where: { id: row.id } });
  assert.equal(after.state, 'PUBLISHED');
  assert.equal(after.leaseOwner, null);
  assert.equal(after.leaseExpiresAt, null);
  assert.equal(await relay(f).publishNext(f.tenant), undefined);
});

test('publish สำเร็จแล้ว invalidate mutable head แต่ไม่แตะ immutable snapshot', async (t) => {
  const f = await fixture(t);
  const headKey = f.cache.policyHeadKey(f.tenant, f.policyId);
  const snapshotKey = f.cache.policySnapshotKey(f.tenant, f.policyId, 1, DIGEST);
  await f.cache.setHead(headKey, { version: 1, digest: DIGEST });
  await f.cache.setSnapshot(snapshotKey, { version: 1 });

  await outboxRow(f);
  await relay(f).publishNext(f.tenant);
  assert.equal(f.redis.store.has(headKey), false);
  assert.equal(f.redis.store.has(snapshotKey), true);
});

test('exception event invalidate ทั้ง contact head และ exception series head', async (t) => {
  const f = await fixture(t);
  const seriesId = randomUUID();
  const contactHeadKey = `cg:contact:${f.tenant}:${f.contact}:head`;
  const seriesHeadKey = f.cache.exceptionHeadKey(f.tenant, seriesId);
  f.redis.store.set(contactHeadKey, '1');
  await f.cache.setHead(seriesHeadKey, { version: 1, digest: DIGEST });

  await outboxRow(f, {
    aggregateType: 'CONTACT',
    aggregateId: f.contact,
    eventType: 'exception.changed',
    payload: canonicalPayload({ subjectId: seriesId, transitionKind: 'EXCEPTION_APPROVED' }),
  });
  await relay(f).publishNext(f.tenant);
  assert.equal(f.redis.store.has(contactHeadKey), false);
  assert.equal(f.redis.store.has(seriesHeadKey), false);
});

test('payload ที่หลุด restricted field ถูก quarantine ไม่ publish และไม่ retry', async (t) => {
  const f = await fixture(t);
  const quarantined: string[] = [];
  const row = await outboxRow(f, {
    payload: canonicalPayload({ evidenceRef: 'ticket://INC-1' }),
  });
  const result = await relay(f, {
    onQuarantine: ({ reason }: { reason: string }) => quarantined.push(reason),
  }).publishNext(f.tenant);

  assert.equal(result?.state, 'QUARANTINED');
  assert.equal(result?.rejection, 'RESTRICTED_FIELD_PRESENT');
  assert.deepEqual(quarantined, ['RESTRICTED_FIELD_PRESENT']);
  assert.equal(f.producer.sent.length, 0);
  assert.equal(
    (await f.owner.cgEventOutbox.findFirstOrThrow({ where: { id: row.id } })).state,
    'QUARANTINED',
  );
  // ไม่ถูกหยิบมาอีกในรอบถัดไป
  assert.equal(await relay(f).publishNext(f.tenant), undefined);
});

test('contract version ที่ใหม่กว่ายัง publish ได้ — consumer เป็นคนตัดสิน DLQ', async (t) => {
  const f = await fixture(t);
  await outboxRow(f, { payload: canonicalPayload({ contractVersion: 99 }) });
  const result = await relay(f).publishNext(f.tenant);
  assert.equal(result?.state, 'PUBLISHED');
  assert.equal(f.producer.sent.length, 1);
});

test('broker ล้มเหลวทำให้ retry ตาม backoff และไม่ invalidate cache', async (t) => {
  const f = await fixture(t);
  const headKey = f.cache.policyHeadKey(f.tenant, f.policyId);
  await f.cache.setHead(headKey, { version: 1, digest: DIGEST });
  const row = await outboxRow(f);
  f.producer.failNext = true;

  const failed = await relay(f).publishNext(f.tenant);
  assert.equal(failed?.state, 'FAILED');
  assert.equal(f.redis.store.has(headKey), true, 'publish ไม่สำเร็จต้องไม่ล้าง head');

  const after = await f.owner.cgEventOutbox.findFirstOrThrow({ where: { id: row.id } });
  assert.equal(after.attempts, 1);
  assert.equal(after.availableAt.toISOString(), '2026-01-05T12:00:02.000Z');
  // ยังไม่ถึงเวลา retry
  assert.equal(await relay(f).publishNext(f.tenant), undefined);

  const later = new Relay(f, new Date('2026-01-05T12:00:03.000Z'));
  const retried = await later.publishNext(f.tenant);
  assert.equal(retried?.state, 'PUBLISHED');
  assert.equal(retried?.attempts, 2);
});

class Relay extends Cg4EventRelay {
  constructor(f: Fixture, now: Date) {
    super(f.application, f.producer, { now: () => now, cache: f.cache, leaseOwner: 'relay-late' });
  }
}

test('lease ที่หมดอายุระหว่าง PUBLISHING ถูกกู้กลับมาเป็น PENDING', async (t) => {
  const f = await fixture(t);
  const row = await outboxRow(f);
  await f.owner.cgEventOutbox.update({
    where: { id: row.id },
    data: {
      state: 'PUBLISHING',
      leaseOwner: 'relay-crashed',
      leaseExpiresAt: new Date('2026-01-05T11:59:00.000Z'),
    },
  });

  assert.equal(await relay(f).publishNext(f.tenant), undefined, 'PUBLISHING ไม่ถูกหยิบตรง ๆ');
  assert.equal(await relay(f).recoverExpiredLeases(f.tenant), 1);

  const recovered = await f.owner.cgEventOutbox.findFirstOrThrow({ where: { id: row.id } });
  assert.equal(recovered.state, 'PENDING');
  assert.equal(recovered.leaseOwner, null);
  assert.equal((await relay(f).publishNext(f.tenant))?.state, 'PUBLISHED');
});

test('lease ที่ยังไม่หมดอายุไม่ถูกกู้', async (t) => {
  const f = await fixture(t);
  const row = await outboxRow(f);
  await f.owner.cgEventOutbox.update({
    where: { id: row.id },
    data: {
      state: 'PUBLISHING',
      leaseOwner: 'relay-alive',
      leaseExpiresAt: new Date('2026-01-05T12:00:30.000Z'),
    },
  });
  assert.equal(await relay(f).recoverExpiredLeases(f.tenant), 0);
});

// ── Activation worker ────────────────────────────────────────────────────────

async function activationJob(f: Fixture, scheduledFor: string, version = 1) {
  if (version !== 1) {
    // The job's composite FK points at (tenant, policyId, version), so the version has to
    // exist before a job can reference it.
    await f.owner.cg4Policy.create({
      data: {
        id: randomUUID(),
        tenantId: f.tenant,
        policyId: f.policyId,
        version,
        scopeKey: `channel=VOICE|contactKind=*|purpose=P${version}|sourceType=*`,
        content: { allowedOperationalRuleCodes: [] },
        contentDigest: DIGEST,
        registryVersion: 'CG4_RULE_REGISTRY_V1',
        status: 'DRAFT',
        effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
        makerActorRef: 'maker-1',
      },
    });
  }
  return f.owner.cg4PolicyActivationJob.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenant,
      policyId: f.policyId,
      policyVersion: version,
      // CG4.5 allows one open job per scope, so each fixture job takes its own scope.
      scopeKey: `channel=VOICE|contactKind=*|purpose=P${version}|sourceType=*`,
      scheduledFor: new Date(scheduledFor),
      state: 'PENDING',
    },
  });
}

/** Only the claim/lease/retry contract is under test here; activateDue has its own suite. */
function stubLifecycle(behaviour: () => Promise<{ headVersion: number }>) {
  return { activateDue: () => behaviour() } as unknown as Cg4PolicyLifecycleRepository;
}

test('activation worker หยิบเฉพาะ job ที่ถึงเวลา แล้วเรียก activateDue หนึ่งครั้ง', async (t) => {
  const f = await fixture(t);
  await activationJob(f, '2026-01-05T18:00:00.000Z');
  let calls = 0;
  const worker = new Cg4ActivationWorker(
    f.application,
    stubLifecycle(async () => {
      calls += 1;
      return { headVersion: 2 };
    }),
    { now: () => NOW, leaseOwner: 'worker-1' },
  );

  assert.equal(await worker.runNext(f.tenant), undefined, 'ยังไม่ถึงเวลา');
  assert.equal(calls, 0);

  await activationJob(f, '2026-01-05T11:00:00.000Z', 2);
  const result = await worker.runNext(f.tenant);
  assert.equal(result?.outcome, 'ACTIVATED');
  assert.equal(calls, 1);
});

test('activateDue ที่ล้มเหลวทำให้ job ถอยไป PENDING พร้อม backoff และนับ attempts', async (t) => {
  const f = await fixture(t);
  const job = await activationJob(f, '2026-01-05T11:00:00.000Z');
  const worker = new Cg4ActivationWorker(
    f.application,
    stubLifecycle(async () => {
      throw new Error('head conflict');
    }),
    { now: () => NOW, leaseOwner: 'worker-1', maxAttempts: 2 },
  );

  const first = await worker.runNext(f.tenant);
  assert.equal(first?.outcome, 'RETRY');
  const afterFirst = await f.owner.cg4PolicyActivationJob.findFirstOrThrow({
    where: { id: job.id },
  });
  assert.equal(afterFirst.state, 'PENDING');
  assert.equal(afterFirst.attempts, 1);
  assert.equal(afterFirst.lastError, 'head conflict');
  assert.equal(afterFirst.leaseOwner, null);
  assert.ok(afterFirst.scheduledFor > NOW, 'backoff ต้องเลื่อนเวลาออกไป');
});

test('job ที่ retry จนครบถูก park เป็น FAILED ให้ scope fail closed แทนที่จะเงียบ', async (t) => {
  const f = await fixture(t);
  const job = await activationJob(f, '2026-01-05T11:00:00.000Z');
  const worker = new Cg4ActivationWorker(
    f.application,
    stubLifecycle(async () => {
      throw new Error('still broken');
    }),
    { now: () => NOW, leaseOwner: 'worker-1', maxAttempts: 1 },
  );
  const result = await worker.runNext(f.tenant);
  assert.equal(result?.outcome, 'FAILED');
  const parked = await f.owner.cg4PolicyActivationJob.findFirstOrThrow({ where: { id: job.id } });
  assert.equal(parked.state, 'FAILED');
  assert.equal(await worker.dueBacklog(f.tenant), 0, 'job ที่ park แล้วไม่นับเป็น backlog');
});

test('dueBacklog นับเฉพาะ job ที่ถึงเวลาแล้วแต่ยังไม่จบ', async (t) => {
  const f = await fixture(t);
  await activationJob(f, '2026-01-05T11:00:00.000Z', 1);
  await activationJob(f, '2026-01-05T18:00:00.000Z', 2);
  const worker = new Cg4ActivationWorker(
    f.application,
    stubLifecycle(async () => ({ headVersion: 1 })),
    { now: () => NOW },
  );
  assert.equal(await worker.dueBacklog(f.tenant), 1);
});

// ── Expiry sweeper ───────────────────────────────────────────────────────────

async function approvedException(f: Fixture, expiresAt: string) {
  const exceptionId = randomUUID();
  const revisionId = randomUUID();
  await f.owner.cg4Exception.create({
    data: {
      id: revisionId,
      tenantId: f.tenant,
      exceptionId,
      revision: 1,
      contactId: f.contact,
      scopeKind: 'CONTACT_WIDE',
      channel: 'VOICE',
      purpose: 'SERVICE_NOTIFICATION',
      sourceType: 'DIALER',
      sourceId: 'source-1',
      allowedRuleCodes: ['QUIET_HOURS'],
      policyId: f.policyId,
      policyVersion: 1,
      policyContentDigest: DIGEST,
      registryVersion: 'CG4_RULE_REGISTRY_V1',
      startsAt: new Date('2026-01-05T09:00:00.000Z'),
      expiresAt: new Date(expiresAt),
      tier: 'STANDARD',
      status: 'APPROVED',
      reasonCode: 'OPERATIONAL',
      evidenceRef: 'evidence:1',
      actorRef: 'maker-1',
      requestHash: 'e'.repeat(64),
    },
  });
  await f.owner.cg4ExceptionHead.create({
    data: {
      id: randomUUID(),
      tenantId: f.tenant,
      exceptionId,
      currentRevisionId: revisionId,
      currentRevision: 1,
      status: 'APPROVED',
    },
  });
  return exceptionId;
}

test('expiry sweeper ออก event ให้ series ที่หมดอายุแล้วเท่านั้น และเดิน contact aggregate version', async (t) => {
  const f = await fixture(t);
  const expired = await approvedException(f, '2026-01-05T11:00:00.000Z');
  await approvedException(f, '2026-01-05T18:00:00.000Z');

  const sweeper = new Cg4ExpirySweeper(f.application, { now: () => NOW });
  const emitted = await sweeper.sweep(f.tenant);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.exceptionId, expired);
  assert.equal(emitted[0]?.aggregateVersion, 1);

  const event = await f.owner.cgEventOutbox.findFirstOrThrow({
    where: { tenantId: f.tenant, eventType: 'exception.changed' },
  });
  const payload = event.payload as Record<string, unknown>;
  assert.equal(payload.transitionKind, 'EXCEPTION_EXPIRED');
  assert.equal(payload.state, 'EXPIRED');
  assert.equal(payload.restrictiveness, 'TIGHTENING');
  assert.equal(payload.effectiveAt, '2026-01-05T11:00:00.000Z');

  const head = await f.owner.cg4ContactExceptionHead.findFirstOrThrow({
    where: { tenantId: f.tenant, contactId: f.contact },
  });
  assert.equal(head.aggregateVersion, 1);
});

test('sweep ซ้ำไม่ออก event ซ้ำ และ head ไม่ขยับเพิ่ม', async (t) => {
  const f = await fixture(t);
  await approvedException(f, '2026-01-05T11:00:00.000Z');
  const sweeper = new Cg4ExpirySweeper(f.application, { now: () => NOW });

  assert.equal((await sweeper.sweep(f.tenant)).length, 1);
  assert.equal((await sweeper.sweep(f.tenant)).length, 0);
  assert.equal(
    await f.owner.cgEventOutbox.count({
      where: { tenantId: f.tenant, eventType: 'exception.changed' },
    }),
    1,
  );
  const head = await f.owner.cg4ContactExceptionHead.findFirstOrThrow({
    where: { tenantId: f.tenant, contactId: f.contact },
  });
  assert.equal(head.aggregateVersion, 1);
});

test('head ที่ยังไม่ APPROVED ไม่ถูก sweep แม้เลยเวลาหมดอายุ', async (t) => {
  const f = await fixture(t);
  const exceptionId = await approvedException(f, '2026-01-05T11:00:00.000Z');
  await f.owner.cg4ExceptionHead.updateMany({
    where: { tenantId: f.tenant, exceptionId },
    data: { status: 'REVOKED' },
  });
  const sweeper = new Cg4ExpirySweeper(f.application, { now: () => NOW });
  assert.deepEqual(await sweeper.sweep(f.tenant), []);
});

test('event ที่ sweeper ออกผ่าน relay ได้โดยไม่ถูก quarantine', async (t) => {
  const f = await fixture(t);
  await approvedException(f, '2026-01-05T11:00:00.000Z');
  await new Cg4ExpirySweeper(f.application, { now: () => NOW }).sweep(f.tenant);

  // The sweeper's outbox row takes the database default for available_at (wall clock), so
  // the relay reads it with a wall clock too rather than the pinned evaluation time.
  const result = await relay(f, { now: () => new Date() }).publishNext(f.tenant);
  assert.equal(result?.state, 'PUBLISHED');
  assert.equal(f.producer.sent[0]?.type, 'exception.changed');
});
