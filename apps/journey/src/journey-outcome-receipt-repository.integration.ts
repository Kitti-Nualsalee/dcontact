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
    payload: { interactionId: randomUUID(), occurredAt: new Date().toISOString() },
    correlationId: 'corr-1',
    ...overrides,
  };
}

test('the first receipt of a stream gets READY and a retry with the same eventId returns the same result as DUPLICATE', async (t) => {
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

test('the same eventId with a different payloadHash is rejected as IDEMPOTENCY_CONFLICT', async (t) => {
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

test('outcomeVersion 2 arriving before version 1 is applied is classified as WAITING_FOR_GAP', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const outcomeId = randomUUID();

  const result = await repository.ingest(baseInput(f.tenantId, { outcomeId, outcomeVersion: 2 }));
  assert.equal(result.outcome, 'WAITING_FOR_GAP');
});

test('a version the head already fast-forwarded past but never had a receipt is classified as IGNORED_SUPERSEDED', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const outcomeId = randomUUID();
  // simulate a head fast-forwarded through a manual reconcile (a later ticket) without a
  // receipt for version 1 ever really occurring in this system
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

test('a WAITING_FOR_GAP receipt is automatically moved to READY once the missing gap is filled and applied', async (t) => {
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

test('the same logical identity with different hashes from different eventIds is QUARANTINED', async (t) => {
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

test('claimNextReady claims a lease and markApplied moves the head so the next version becomes READY', async (t) => {
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

test('an expired lease can be claimed again without applying twice', async (t) => {
  const f = await fixture(t);
  const repository = new JourneyOutcomeReceiptRepository(f.application);
  const v1 = await repository.ingest(baseInput(f.tenantId));
  const claimed = await repository.claimNextReady(f.tenantId, 'worker-1', -1);
  assert.equal(claimed?.id, v1.receipt.id);

  const reclaimed = await repository.claimNextReady(f.tenantId, 'worker-2', 30);
  assert.equal(reclaimed?.id, v1.receipt.id);
  assert.equal(reclaimed?.leaseOwner, 'worker-2');
});

test('markRetryableFailure returns to READY with backoff and counts attempts', async (t) => {
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

test('findStaleGaps returns only WAITING_FOR_GAP receipts stuck past the cutoff', async (t) => {
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

test('different tenants do not see each other receipts', async (t) => {
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
