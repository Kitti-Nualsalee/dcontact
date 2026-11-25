/**
 * C1.3 acceptance: the real adapter backed by Postgres and the real ContactGovernanceService.
 *
 * `@d-contact/contact-governance` is a devDependency only: production code in
 * this app knows only `ContactGovernancePort`, while the test is the composition root that wires
 * the two real sides together to prove the boundary, not to borrow code across apps.
 */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { reservationId } from '@d-contact/cxa-contracts';
import { createDeliveryFixture, type DeliveryFixture } from './delivery-fixture.js';
import type { TransportResponse } from './test-transport.js';

async function fixture(t: TestContext, script: TransportResponse[] = []): Promise<DeliveryFixture> {
  const context = await createDeliveryFixture(script);
  t.after(() => context.dispose());
  return context;
}

async function enqueued(context: DeliveryFixture) {
  const result = await context.delivery.enqueue(context.command);
  assert.equal(result.status, 'QUEUED');
  return result as { status: 'QUEUED'; deliveryId: string; providerRequestKey: string };
}

async function submitted(context: DeliveryFixture, deliveryId: string) {
  return context.delivery.submit({
    tenantId: context.rawTenantId,
    deliveryId,
    correlationId: 'corr-submit',
  });
}

test('enqueue persists a durable outbox row before returning QUEUED', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);

  const row = await context.outboxRow(queued.deliveryId);
  assert.ok(row, 'the outbox row must be persisted');
  assert.equal(row.state, 'QUEUED');
  assert.equal(row.adapter, 'TEST_ADAPTER');
  assert.equal(row.providerRequestKey, queued.providerRequestKey);
  assert.equal(row.leaseVersion, 1);

  const reservation = await context.reservationRow(row.reservationId);
  assert.equal(reservation?.settlementStatus, 'CLAIMED');
  assert.equal(reservation?.deliveryId, queued.deliveryId);
  assert.equal(context.transport.requests.length, 0, 'enqueue must not touch the transport');
});

test('a failed claim leaves no outbox row behind', async (t) => {
  const context = await fixture(t);
  const rejected = await context.delivery.enqueue({
    ...context.command,
    reservationId: reservationId(randomUUID()),
  });
  assert.deepEqual(rejected, { status: 'ERROR', code: 'RESERVATION_NOT_FOUND' });
  assert.equal(await context.outboxCount(), 0);
});

test('same actionKey and input replays the same delivery and provider request key', async (t) => {
  const context = await fixture(t);
  const first = await enqueued(context);
  const second = await context.delivery.enqueue(context.command);
  assert.deepEqual(second, first);
  assert.equal(await context.outboxCount(), 1);
});

test('same actionKey with different input never opens a second delivery', async (t) => {
  const context = await fixture(t);
  await enqueued(context);
  const conflict = await context.delivery.enqueue({
    ...context.command,
    contentRef: 'template:other/v1',
  });
  assert.deepEqual(conflict, { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' });
  assert.equal(await context.outboxCount(), 1);
});

test('an enqueue retried after a crash before persistence keeps the same delivery id', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);
  // Simulate a crash after claim but before insert: the reservation is already claimed but the outbox is empty
  await context.owner.dlOutboxEntry.deleteMany({ where: { tenantId: context.rawTenantId } });

  const retried = await context.delivery.enqueue(context.command);
  assert.deepEqual(retried, queued, 'retry must mint the same values and replay the same claim');
  assert.equal(await context.outboxCount(), 1);
});

test('submit crosses the durable barrier before touching transport', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);
  const result = await submitted(context, queued.deliveryId);

  assert.equal(result.status, 'SUBMITTED');
  assert.equal(context.transport.submissionsFor(queued.providerRequestKey), 1);
  const row = await context.outboxRow(queued.deliveryId);
  assert.equal(row?.state, 'SUBMITTED');
  assert.ok(row?.submittedAt, 'submittedAt must be recorded before calling the transport');
  const reservation = await context.reservationRow(row!.reservationId);
  assert.equal(reservation?.settlementStatus, 'ACCEPTED');
  assert.equal(reservation?.providerRequestKey, queued.providerRequestKey);
});

test('a delivery stuck in SUBMITTING is reconciled, never resubmitted', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);
  await submitted(context, queued.deliveryId);
  // Simulate a crash while awaiting the result: the row stays in the "may have been sent" state
  await context.owner.dlOutboxEntry.updateMany({
    where: { tenantId: context.rawTenantId, deliveryId: queued.deliveryId },
    data: { state: 'SUBMITTING' },
  });

  const retry = await context.delivery.submit({
    tenantId: context.rawTenantId,
    deliveryId: queued.deliveryId,
    correlationId: 'corr-retry',
  });
  assert.equal(retry.status, 'RECONCILE_REQUIRED');
  assert.equal(
    context.transport.submissionsFor(queued.providerRequestKey),
    1,
    'must not send twice',
  );
});

test('provider timeout reconciles instead of releasing the reservation', async (t) => {
  const context = await fixture(t, [{ status: 'TIMEOUT' }]);
  const queued = await enqueued(context);
  const result = await submitted(context, queued.deliveryId);

  assert.equal(result.status, 'RECONCILE_REQUIRED');
  const row = await context.outboxRow(queued.deliveryId);
  assert.equal(row?.state, 'RECONCILING');
  const reservation = await context.reservationRow(row!.reservationId);
  assert.equal(reservation?.state, 'RESERVED', 'must not release after the barrier');
  assert.equal(reservation?.settlementStatus, 'UNKNOWN_RECONCILING');
  assert.equal(await context.attemptCount(), 0, 'reconcile is not a terminal outcome yet');
});

test('provider rejection settles once through Governance', async (t) => {
  const context = await fixture(t, [{ status: 'REJECTED', reasonCode: 'SENDER_BLOCKED' }]);
  const queued = await enqueued(context);
  const result = await submitted(context, queued.deliveryId);

  assert.equal(result.status, 'SETTLED');
  const row = await context.outboxRow(queued.deliveryId);
  assert.equal(row?.state, 'SETTLED');
  assert.equal(row?.outcome, 'PROVIDER_REJECTED');
  const reservation = await context.reservationRow(row!.reservationId);
  assert.equal(reservation?.state, 'RELEASED');
  assert.equal(await context.attemptCount(), 1);
  assert.equal(await context.touchCount(), 0);
});

test('a delivered outcome records exactly one Attempt and one Touch', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);
  await submitted(context, queued.deliveryId);

  const outcome = {
    tenantId: context.rawTenantId,
    deliveryId: queued.deliveryId,
    correlationId: 'corr-outcome',
    outcome: 'DELIVERED' as const,
    outcomeRef: `ocr-${queued.providerRequestKey}`,
    occurredAt: '2026-09-10T09:05:00.000Z',
  };
  const settled = await context.delivery.recordOutcome(outcome);
  assert.equal(settled.state, 'SETTLED');
  assert.equal(settled.outcome, 'DELIVERED');

  const replay = await context.delivery.recordOutcome(outcome);
  assert.deepEqual(replay, settled, 'a duplicate outcome must return the same snapshot');

  assert.equal(await context.attemptCount(), 1);
  assert.equal(await context.touchCount(), 1);
});

test('a late second outcome never re-settles or adds facts', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);
  await submitted(context, queued.deliveryId);
  const base = {
    tenantId: context.rawTenantId,
    deliveryId: queued.deliveryId,
    correlationId: 'corr-outcome',
    occurredAt: '2026-09-10T09:05:00.000Z',
  };
  const first = await context.delivery.recordOutcome({
    ...base,
    outcome: 'DELIVERED',
    outcomeRef: `ocr-first-${queued.providerRequestKey}`,
  });
  const late = await context.delivery.recordOutcome({
    ...base,
    outcome: 'DELIVERY_FAILED',
    outcomeRef: `ocr-late-${queued.providerRequestKey}`,
  });

  assert.equal(late.outcome, 'DELIVERED', 'the first terminal outcome wins');
  assert.deepEqual(late, first);
  assert.equal(await context.attemptCount(), 1);
  assert.equal(await context.touchCount(), 1);
});

test('expired leases past the barrier are reconciled without resubmitting', async (t) => {
  const context = await fixture(t, [{ status: 'TIMEOUT' }]);
  const queued = await enqueued(context);
  await submitted(context, queued.deliveryId);
  // Simulate a crash after the barrier but before the result is recorded: the row stays at SUBMITTING until the lease expires
  await context.owner.dlOutboxEntry.updateMany({
    where: { tenantId: context.rawTenantId, deliveryId: queued.deliveryId },
    data: { state: 'SUBMITTING' },
  });
  context.advance(30 * 60_000);

  const evidence = await context.delivery.reconcileExpired(context.rawTenantId, 'corr-sweeper');
  assert.equal(evidence.length, 1);
  assert.equal(evidence[0]?.state, 'RECONCILING');
  assert.equal(context.transport.submissionsFor(queued.providerRequestKey), 1);

  const row = await context.outboxRow(queued.deliveryId);
  const reservation = await context.reservationRow(row!.reservationId);
  assert.equal(reservation?.settlementStatus, 'UNKNOWN_RECONCILING');
  assert.equal(reservation?.state, 'RESERVED', 'the sweeper must not release or refund');
});

test('running the reconcile sweeper twice is a replay, not a second settlement', async (t) => {
  const context = await fixture(t, [{ status: 'TIMEOUT' }]);
  const queued = await enqueued(context);
  await submitted(context, queued.deliveryId);
  await context.owner.dlOutboxEntry.updateMany({
    where: { tenantId: context.rawTenantId, deliveryId: queued.deliveryId },
    data: { state: 'SUBMITTING' },
  });

  context.advance(30 * 60_000);
  await context.delivery.reconcileExpired(context.rawTenantId, 'corr-sweeper-1');
  // Crash again after the first sweeper pass: the row meets the sweeper condition once more, and the second pass
  // must not hit IDEMPOTENCY_CONFLICT even though the clock has advanced a long way
  await context.owner.dlOutboxEntry.updateMany({
    where: { tenantId: context.rawTenantId, deliveryId: queued.deliveryId },
    data: { state: 'SUBMITTING' },
  });
  context.advance(30 * 60_000);
  const second = await context.delivery.reconcileExpired(context.rawTenantId, 'corr-sweeper-2');
  assert.equal(second.length, 1);
  assert.equal(second[0]?.state, 'RECONCILING');

  assert.equal(await context.attemptCount(), 0);
  assert.equal(context.transport.submissionsFor(queued.providerRequestKey), 1);
});

test('a lease that expires after the provider accepted stays ACCEPTED in Governance', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);
  await submitted(context, queued.deliveryId);
  context.advance(30 * 60_000);

  const evidence = await context.delivery.reconcileExpired(context.rawTenantId, 'corr-sweeper');
  assert.equal(
    evidence[0]?.state,
    'RECONCILING',
    'the outbox side does not know the outcome yet so it must reconcile',
  );

  const row = await context.outboxRow(queued.deliveryId);
  const reservation = await context.reservationRow(row!.reservationId);
  assert.equal(
    reservation?.settlementStatus,
    'ACCEPTED',
    'the provider accepted the job; a lease that expires later must not roll the reservation back to UNKNOWN',
  );
});

test('evidence for a live delivery stays inside the PII allowlist', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);
  const evidence = await context.delivery.evidenceFor(context.rawTenantId, queued.deliveryId);
  const serialized = JSON.stringify(evidence);

  assert.equal(evidence.deliveryId, queued.deliveryId);
  for (const secret of [context.command.contentRef, context.command.senderIdentityId]) {
    assert.equal(serialized.includes(secret), false, `evidence still contains ${secret}`);
  }
});

test('reading the outbox without a tenant context fails closed', async (t) => {
  const context = await fixture(t);
  const queued = await enqueued(context);

  // Outside withTenantDatabaseTransaction there is no app.tenant_id for the policy to use, which ends one of two ways
  // depending on whether the connection the pool picked up has run a tenant transaction before:
  //
  //   brand-new connection       -> current_setting(...) = NULL -> policy is NULL -> returns 0 rows
  //   already ran a transaction  -> set_config(..., true) reverts to '' -> ''::uuid fails the whole statement
  //
  // This test used to assert only the latter case, so it passed on a dev machine with a warm pool but failed on CI
  // with a freshly created DB, and more importantly it was tied to the side effect of casting '' instead of checking
  // the real safety property, which is "no row of any tenant leaks out" and holds in both cases
  const leaked = await context.application.dlOutboxEntry
    .findMany({ where: { deliveryId: queued.deliveryId } })
    .catch(() => []);
  assert.deepEqual(leaked, [], 'RLS must not release rows when there is no tenant context');
});
