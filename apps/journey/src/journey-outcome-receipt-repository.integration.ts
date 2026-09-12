import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  JourneyOutcomeReceiptRepository,
  OutcomeReceiptHashConflictError,
  type IngestOutcomeReceiptInput,
} from './journey-outcome-receipt-repository.js';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

async function fixture(t: TestContext) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const tenantId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `J2.3 outcome ${suffix}`,
      slug: `j2-3-outcome-${suffix}`,
      sipDomain: `${suffix}.j2-3-outcome.test`,
    },
  });
  t.after(async () => {
    await owner.jrOutcomeReceipt.deleteMany({ where: { tenantId } });
    await owner.jrOutcomeHead.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });
  return { owner, application, tenantId };
}

function baseInput(
  tenantId: string,
  overrides: Partial<IngestOutcomeReceiptInput> = {},
): IngestOutcomeReceiptInput {
  return {
    tenantId,
    source: 'INTERACTION',
    eventId: randomUUID(),
    outcomeType: 'INTERACTION_ABANDONED',
    outcomeId: randomUUID(),
    outcomeVersion: 1,
    payloadHash: 'a'.repeat(64),
    correlationId: 'corr-1',
    ...overrides,
  };
}

test('receipt แรกของ stream ได้ READY และ retry ด้วย eventId เดิมคืนผลเดิมแบบ DUPLICATE', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const input = baseInput(f.tenantId);

  const first = await repository.ingest(input);
  assert.equal(first.outcome, 'READY');

  const duplicate = await repository.ingest(input);
  assert.equal(duplicate.outcome, 'DUPLICATE');
  assert.equal(duplicate.receipt.id, first.receipt.id);
  assert.equal(await f.owner.jrOutcomeReceipt.count({ where: { tenantId: f.tenantId } }), 1);
});

test('eventId เดิมแต่ payloadHash ต่างถูกปฏิเสธเป็น IDEMPOTENCY_CONFLICT', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const input = baseInput(f.tenantId);
  await repository.ingest(input);

  await assert.rejects(
    () => repository.ingest({ ...input, payloadHash: 'b'.repeat(64) }),
    (error: unknown) => {
      assert.ok(error instanceof OutcomeReceiptHashConflictError);
      assert.equal(error.kind, 'TRANSPORT');
      return true;
    },
  );
});

test('outcomeVersion 2 มาก่อน version 1 apply ถูกจัดเป็น WAITING_FOR_GAP', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const outcomeId = randomUUID();

  const result = await repository.ingest(baseInput(f.tenantId, { outcomeId, outcomeVersion: 2 }));
  assert.equal(result.outcome, 'WAITING_FOR_GAP');
});

test('version ที่ head เคย fast-forward ผ่านไปแล้วแต่ไม่เคยมี receipt ถูกจัดเป็น IGNORED_SUPERSEDED', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const outcomeId = randomUUID();
  // จำลอง head ที่ fast-forward ผ่าน manual reconcile (ticket ถัดไป) โดยไม่เคยมี
  // receipt ของ version 1 เกิดขึ้นจริงในระบบนี้เลย
  await f.owner.jrOutcomeHead.create({
    data: {
      tenantId: f.tenantId,
      outcomeType: 'INTERACTION_ABANDONED',
      outcomeId,
      lastAppliedVersion: 1,
    },
  });

  const stale = await repository.ingest(baseInput(f.tenantId, { outcomeId, outcomeVersion: 1 }));
  assert.equal(stale.outcome, 'IGNORED_SUPERSEDED');
});

test('receipt WAITING_FOR_GAP ถูกเลื่อนเป็น READY อัตโนมัติเมื่อ gap ที่ขาดถูกเติมและ apply แล้ว', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const outcomeId = randomUUID();

  const v2 = await repository.ingest(baseInput(f.tenantId, { outcomeId, outcomeVersion: 2 }));
  assert.equal(v2.outcome, 'WAITING_FOR_GAP');

  const v1 = await repository.ingest(baseInput(f.tenantId, { outcomeId, outcomeVersion: 1 }));
  assert.equal(v1.outcome, 'READY');
  await repository.markApplied(f.tenantId, v1.receipt.id);

  const resolved = await f.owner.jrOutcomeReceipt.findUniqueOrThrow({
    where: { id: v2.receipt.id },
  });
  assert.equal(resolved.state, 'READY');

  const claimed = await repository.claimNextReady(f.tenantId, 'worker-gap');
  assert.equal(claimed?.id, v2.receipt.id);
});

test('logical identity เดิมมาพร้อม hash ต่างกันจาก eventId คนละใบถูก QUARANTINED', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const outcomeId = randomUUID();
  const first = await repository.ingest(
    baseInput(f.tenantId, { outcomeId, outcomeVersion: 1, payloadHash: 'a'.repeat(64) }),
  );
  assert.equal(first.outcome, 'READY');

  const conflicting = await repository.ingest(
    baseInput(f.tenantId, {
      outcomeId,
      outcomeVersion: 1,
      eventId: randomUUID(),
      payloadHash: 'c'.repeat(64),
    }),
  );
  assert.equal(conflicting.outcome, 'QUARANTINED');
  assert.equal(conflicting.receipt.id, first.receipt.id);
  assert.equal(conflicting.receipt.reviewReasonCode, 'EVENT_HASH_CONFLICT');
});

test('claimNextReady เคลม lease แล้ว markApplied เลื่อน head ให้ version ถัดไปพร้อม READY', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const outcomeId = randomUUID();
  const v1 = await repository.ingest(baseInput(f.tenantId, { outcomeId, outcomeVersion: 1 }));

  const claimed = await repository.claimNextReady(f.tenantId, 'worker-1');
  assert.equal(claimed?.id, v1.receipt.id);
  assert.equal(claimed?.state, 'PROCESSING');
  assert.equal(claimed?.leaseOwner, 'worker-1');

  assert.equal(await repository.claimNextReady(f.tenantId, 'worker-2'), undefined);

  await repository.markApplied(f.tenantId, v1.receipt.id);
  const v2 = await repository.ingest(
    baseInput(f.tenantId, { outcomeId, outcomeVersion: 2, eventId: randomUUID() }),
  );
  assert.equal(v2.outcome, 'READY');
});

test('lease ที่หมดอายุกลับมา claim ได้อีกครั้งโดยไม่ apply ซ้ำ', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const v1 = await repository.ingest(baseInput(f.tenantId));
  const claimed = await repository.claimNextReady(f.tenantId, 'worker-1', -1);
  assert.equal(claimed?.id, v1.receipt.id);

  const reclaimed = await repository.claimNextReady(f.tenantId, 'worker-2', 30);
  assert.equal(reclaimed?.id, v1.receipt.id);
  assert.equal(reclaimed?.leaseOwner, 'worker-2');
});

test('markRetryableFailure กลับไป READY พร้อม backoff และนับ attempts', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const v1 = await repository.ingest(baseInput(f.tenantId));
  await repository.claimNextReady(f.tenantId, 'worker-1');

  const retried = await repository.markRetryableFailure(
    f.tenantId,
    v1.receipt.id,
    60_000,
    'owner unavailable',
  );
  assert.equal(retried.state, 'READY');
  assert.equal(retried.attempts, 1);
  assert.ok(retried.availableAt.getTime() > Date.now());
  assert.equal(await repository.claimNextReady(f.tenantId, 'worker-2'), undefined);
});

test('findStaleGaps คืนเฉพาะ WAITING_FOR_GAP ที่ค้างเกิน cutoff', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const outcomeId = randomUUID();
  const gap = await repository.ingest(baseInput(f.tenantId, { outcomeId, outcomeVersion: 5 }));
  assert.equal(gap.outcome, 'WAITING_FOR_GAP');

  const future = await repository.findStaleGaps(f.tenantId, new Date(Date.now() - 60_000));
  assert.deepEqual(future, []);

  const stale = await repository.findStaleGaps(f.tenantId, new Date(Date.now() + 60_000));
  assert.equal(stale.length, 1);
  assert.equal(stale[0]?.id, gap.receipt.id);
});

test('tenant คนละใบไม่เห็น receipt ของกันและกัน', async (t) => {
  const a = await fixture(t);
  const b = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(a.application);
  const otherRepository = new JourneyOutcomeReceiptRepository(b.application);
  const outcomeId = randomUUID();

  await repository.ingest(baseInput(a.tenantId, { outcomeId }));
  const otherView = await otherRepository.findByOutcome(
    b.tenantId,
    'INTERACTION_ABANDONED',
    outcomeId,
  );
  assert.deepEqual(otherView, []);
});
