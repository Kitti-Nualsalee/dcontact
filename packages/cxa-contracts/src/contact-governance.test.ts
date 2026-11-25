import assert from 'node:assert/strict';
import test from 'node:test';
import {
  actionKey,
  contactId,
  deliveryId,
  identityId,
  outcomeRef,
  providerRequestKey,
  reservationId,
  tenantId,
  type AuthorizeAndReserveInput,
  type ContactGovernancePort,
  type ClaimReservationForDeliveryInput,
  type SettleDeliveryInput,
} from './index.js';
import { ContactGovernanceFake } from './testing/contact-governance-fake.js';

function setup(refund = true) {
  let now = Date.parse('2026-09-09T00:00:00Z');
  const fake = new ContactGovernanceFake(() => now);
  const authorization: AuthorizeAndReserveInput = {
    actionKey: actionKey('action-a'),
    channel: 'EMAIL',
    purpose: 'SERVICE',
    source: 'JOURNEY',
    sourceId: 'journey-a',
    contactId: contactId('contact-a'),
    identityId: identityId('identity-a'),
    policyVersion: 1,
  };
  fake.seed(
    tenantId('tenant-a'),
    authorization,
    {
      decision: 'ALLOW',
      decisionId: 'decision-a',
      reasonCode: 'POLICY_PASSED',
      policyVersion: 1,
      trace: [],
      reservationId: 'reservation-a',
      reservationExpiresAt: '2026-09-09T00:15:00Z',
    },
    refund,
  );
  const port: ContactGovernancePort = fake;
  const claim: ClaimReservationForDeliveryInput = {
    tenantId: tenantId('tenant-a'),
    correlationId: 'trace-a',
    actionKey: actionKey('action-a'),
    reservationId: reservationId('reservation-a'),
    deliveryId: deliveryId('delivery-a'),
    contactId: contactId('contact-a'),
    identityId: identityId('identity-a'),
    channel: 'EMAIL',
    purpose: 'SERVICE',
    senderIdentityId: 'sender-a',
    leaseExpiresAt: '2026-09-09T00:05:00Z',
  };
  const binding = {
    tenantId: claim.tenantId,
    correlationId: claim.correlationId,
    actionKey: claim.actionKey,
    reservationId: claim.reservationId,
    deliveryId: claim.deliveryId,
  };
  const confirm = { ...binding, providerRequestKey: providerRequestKey('provider-a') };
  const outcome: SettleDeliveryInput = {
    ...confirm,
    outcomeRef: outcomeRef('outcome-a'),
    outcome: 'DELIVERED',
    occurredAt: '2026-09-09T00:01:00Z',
  };
  return {
    fake,
    port,
    claim,
    binding,
    confirm,
    outcome,
    authorization,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const code = (code: string) => ({ code });

async function beginSubmission(
  port: ContactGovernancePort,
  claim: ClaimReservationForDeliveryInput,
) {
  return port.beginProviderSubmission({
    tenantId: claim.tenantId,
    correlationId: claim.correlationId,
    reservationId: claim.reservationId,
    actionKey: claim.actionKey,
    deliveryId: claim.deliveryId,
    expectedLeaseVersion: 1,
    providerRequestKey: providerRequestKey('provider-a'),
  });
}

test('authorization keeps the original signature and the duplicate/conflict contract without importing a concrete app', async () => {
  const { port, claim, authorization } = setup();
  const input = { ...authorization, correlationId: 'trace' };
  const first = await port.authorizeAndReserve(claim.tenantId, input);
  assert.deepEqual(
    await port.authorizeAndReserve(claim.tenantId, { ...input, correlationId: 'retry' }),
    first,
  );
  await assert.rejects(
    port.authorizeAndReserve(claim.tenantId, { ...input, purpose: 'MARKETING' }),
    code('IDEMPOTENCY_CONFLICT'),
  );
  await assert.rejects(
    port.authorizeAndReserve(tenantId('tenant-b'), input),
    code('RESERVATION_NOT_FOUND'),
  );
});

test('a concurrent claim with the same values gets one binding; a different binding is rejected', async () => {
  const { port, claim } = setup();
  const results = await Promise.all(
    Array.from({ length: 12 }, () => port.claimReservationForDelivery(claim)),
  );
  for (const result of results) assert.deepEqual(result, results[0]);
  results[0].state = 'REFUNDED';
  assert.equal((await port.claimReservationForDelivery(claim)).state, 'RESERVED');
  await assert.rejects(
    port.claimReservationForDelivery({ ...claim, deliveryId: deliveryId('delivery-b') }),
    code('IDEMPOTENCY_CONFLICT'),
  );
});

test('tenant/reservation/action/contact/identity/channel/purpose/sender swap fail closed', async () => {
  const cases: Partial<ClaimReservationForDeliveryInput>[] = [
    { tenantId: tenantId('tenant-b') },
    { reservationId: reservationId('reservation-b') },
    { actionKey: actionKey('action-b') },
    { contactId: contactId('contact-b') },
    { identityId: identityId('identity-b') },
    { channel: 'VOICE' },
    { purpose: 'MARKETING' },
    { senderIdentityId: 'sender-b' },
  ];
  for (const change of cases) {
    const { port, claim } = setup();
    await assert.rejects(
      port.claimReservationForDelivery({ ...claim, ...change }),
      code(
        change.tenantId || change.reservationId
          ? 'RESERVATION_NOT_FOUND'
          : 'RESERVATION_BINDING_CONFLICT',
      ),
    );
    assert.equal((await port.claimReservationForDelivery(claim)).status, 'CLAIMED');
  }
});

test('expiry and an invalid lease block a claim but allow releasing an expired reservation before submit', async () => {
  const { port, claim, binding, advance } = setup();
  for (const leaseExpiresAt of ['invalid', '2026-09-08T00:00:00Z', '2026-09-09T00:16:00Z']) {
    await assert.rejects(
      port.claimReservationForDelivery({ ...claim, leaseExpiresAt }),
      code('INVALID_RESERVATION_LEASE'),
    );
  }
  advance(16 * 60_000);
  await assert.rejects(port.claimReservationForDelivery(claim), code('RESERVATION_EXPIRED'));
  const released = await port.releaseBeforeSubmit({
    ...binding,
    deliveryId: undefined,
    reason: 'LEASE_EXPIRED',
  });
  assert.equal(released.state, 'RELEASED');
});

test('release before submit is idempotent, and terminal does not revert to confirmed', async () => {
  const { port, claim, binding, confirm } = setup();
  await port.claimReservationForDelivery(claim);
  const input = { ...binding, reason: 'CANCELLED_BEFORE_SUBMIT' as const };
  const released = await port.releaseBeforeSubmit(input);
  assert.equal(released.state, 'RELEASED');
  assert.deepEqual(await port.releaseBeforeSubmit(input), released);
  await assert.rejects(
    port.confirmProviderAcceptance(confirm),
    code('INVALID_RESERVATION_TRANSITION'),
  );
});

test('a lease that expires after claim before submit can be released; a lease that has not expired cannot be released by expiry', async () => {
  const { port, claim, binding, advance } = setup();
  await port.claimReservationForDelivery(claim);
  const input = { ...binding, reason: 'LEASE_EXPIRED' as const };
  await assert.rejects(port.releaseBeforeSubmit(input), code('INVALID_RESERVATION_LEASE'));
  advance(6 * 60_000);
  assert.equal((await port.releaseBeforeSubmit(input)).state, 'RELEASED');
});

test('after a timeout following submit, release is forbidden even when the TTL expires; reconcile with the original request key', async () => {
  const { port, claim, binding, confirm, outcome, advance } = setup();
  await port.claimReservationForDelivery(claim);
  await beginSubmission(port, claim);
  const uncertain = { ...outcome, outcome: 'UNKNOWN_RECONCILING' as const };
  assert.equal((await port.settleDelivery(uncertain)).status, 'UNKNOWN_RECONCILING');
  advance(20 * 60_000);
  await assert.rejects(
    port.releaseBeforeSubmit({ ...binding, reason: 'LEASE_EXPIRED' }),
    code('DELIVERY_RECONCILIATION_REQUIRED'),
  );
  await assert.rejects(
    port.confirmProviderAcceptance({
      ...confirm,
      providerRequestKey: providerRequestKey('new-key'),
    }),
    code('RESERVATION_BINDING_CONFLICT'),
  );
  assert.equal((await port.confirmProviderAcceptance(confirm)).state, 'CONFIRMED');
  const settled = await port.settleDelivery({ ...outcome, outcomeRef: outcomeRef('resolved') });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.state, 'CONFIRMED');
});

test('confirm duplicate, concurrent outcome and late outcome do not revert the terminal state', async () => {
  const { port, claim, confirm, outcome } = setup();
  await port.claimReservationForDelivery(claim);
  await beginSubmission(port, claim);
  const accepted = await port.confirmProviderAcceptance(confirm);
  assert.deepEqual(await port.confirmProviderAcceptance(confirm), accepted);
  const results = await Promise.all(Array.from({ length: 12 }, () => port.settleDelivery(outcome)));
  for (const result of results) assert.deepEqual(result, { ...accepted, status: 'SETTLED' });
  const late = await port.settleDelivery({
    ...outcome,
    outcomeRef: outcomeRef('late-failure'),
    outcome: 'DELIVERY_FAILED',
  });
  assert.deepEqual(late, results[0]);
  await assert.rejects(
    port.settleDelivery({ ...outcome, outcome: 'DELIVERY_FAILED' }),
    code('IDEMPOTENCY_CONFLICT'),
  );
});

test('terminal failure refunds only per the Governance fixture policy', async () => {
  for (const refund of [true, false]) {
    const { port, claim, confirm, outcome } = setup(refund);
    await port.claimReservationForDelivery(claim);
    await beginSubmission(port, claim);
    await port.confirmProviderAcceptance(confirm);
    const failed = await port.settleDelivery({ ...outcome, outcome: 'DELIVERY_FAILED' });
    assert.equal(failed.state, refund ? 'REFUNDED' : 'CONFIRMED');
    assert.deepEqual(
      await port.settleDelivery({ ...outcome, outcomeRef: outcomeRef('late-success') }),
      failed,
    );
    assert.equal('countsAsTouch' in failed, false);
  }
});

test('a provider rejection before accept releases; a terminal failure with no acceptance must reconcile', async () => {
  const { port, claim, outcome } = setup();
  await port.claimReservationForDelivery(claim);
  await beginSubmission(port, claim);
  await assert.rejects(
    port.settleDelivery({ ...outcome, outcome: 'DELIVERY_FAILED' }),
    code('DELIVERY_RECONCILIATION_REQUIRED'),
  );
  assert.equal(
    (await port.settleDelivery({ ...outcome, outcome: 'PROVIDER_REJECTED' })).state,
    'RELEASED',
  );
});

test('confirm/release/outcome reject a tenant and delivery swap before changing state', async () => {
  const { port, claim, confirm, binding, outcome } = setup();
  await port.claimReservationForDelivery(claim);
  await beginSubmission(port, claim);
  for (const change of [
    { tenantId: tenantId('tenant-b') },
    { deliveryId: deliveryId('delivery-b') },
  ]) {
    const error = code(
      'tenantId' in change ? 'RESERVATION_NOT_FOUND' : 'RESERVATION_BINDING_CONFLICT',
    );
    await assert.rejects(port.confirmProviderAcceptance({ ...confirm, ...change }), error);
    await assert.rejects(
      port.releaseBeforeSubmit({ ...binding, ...change, reason: 'CANCELLED_BEFORE_SUBMIT' }),
      error,
    );
    await assert.rejects(port.settleDelivery({ ...outcome, ...change }), error);
  }
  assert.equal((await port.confirmProviderAcceptance(confirm)).state, 'CONFIRMED');
});

test('two deliveries claiming concurrently must have a single winner', async () => {
  const { port, claim } = setup();
  const result = await Promise.allSettled([
    port.claimReservationForDelivery(claim),
    port.claimReservationForDelivery({ ...claim, deliveryId: deliveryId('competing-delivery') }),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(result.filter((r) => r.status === 'rejected').length, 1);
});

test('a delivered that arrives before the acceptance callback can be confirmed, and a late callback does not revert the terminal state', async () => {
  const { port, claim, confirm, outcome, binding } = setup();
  await port.claimReservationForDelivery(claim);
  await beginSubmission(port, claim);
  assert.equal((await port.settleDelivery(outcome)).state, 'CONFIRMED');
  await assert.rejects(
    port.confirmProviderAcceptance(confirm),
    code('INVALID_RESERVATION_TRANSITION'),
  );
  await assert.rejects(
    port.releaseBeforeSubmit({ ...binding, reason: 'CANCELLED_BEFORE_SUBMIT' }),
    code('INVALID_RESERVATION_TRANSITION'),
  );
});

test('the same outcomeRef is separate across tenants, but reuse across actions in one tenant must conflict', async () => {
  const { fake, port, claim, authorization, outcome } = setup();
  for (const [tenant, suffix] of [
    [tenantId('tenant-b'), 'b'],
    [tenantId('tenant-a'), 'c'],
  ] as const) {
    fake.seed(
      tenant,
      { ...authorization, actionKey: actionKey(`action-${suffix}`) },
      {
        decision: 'ALLOW',
        decisionId: `decision-${suffix}`,
        reasonCode: 'POLICY_PASSED',
        policyVersion: 1,
        trace: [],
        reservationId: `reservation-${suffix}`,
        reservationExpiresAt: '2026-09-09T00:15:00Z',
      },
    );
    await port.claimReservationForDelivery({
      ...claim,
      tenantId: tenant,
      actionKey: actionKey(`action-${suffix}`),
      reservationId: reservationId(`reservation-${suffix}`),
      deliveryId: deliveryId(`delivery-${suffix}`),
    });
    await beginSubmission(port, {
      ...claim,
      tenantId: tenant,
      actionKey: actionKey(`action-${suffix}`),
      reservationId: reservationId(`reservation-${suffix}`),
      deliveryId: deliveryId(`delivery-${suffix}`),
    });
  }
  await port.claimReservationForDelivery(claim);
  await beginSubmission(port, claim);
  await port.settleDelivery(outcome);
  assert.equal(
    (
      await port.settleDelivery({
        ...outcome,
        tenantId: tenantId('tenant-b'),
        actionKey: actionKey('action-b'),
        reservationId: reservationId('reservation-b'),
        deliveryId: deliveryId('delivery-b'),
      })
    ).status,
    'SETTLED',
  );
  await assert.rejects(
    port.settleDelivery({
      ...outcome,
      actionKey: actionKey('action-c'),
      reservationId: reservationId('reservation-c'),
      deliveryId: deliveryId('delivery-c'),
    }),
    code('IDEMPOTENCY_CONFLICT'),
  );
});

test('a crash before the barrier can release the lease, but a crash after the barrier must not return the entitlement even with no callback', async () => {
  for (const begun of [false, true]) {
    const { port, claim, binding, advance } = setup();
    await port.claimReservationForDelivery(claim);
    if (begun) {
      const barrier = await beginSubmission(port, claim);
      assert.equal(barrier.state, 'RESERVED');
      assert.equal(barrier.status, 'UNKNOWN_RECONCILING');
    }
    // the worker disappeared without confirm/settle; both the lease and the reservation TTL have expired
    advance(20 * 60_000);
    const release = port.releaseBeforeSubmit({ ...binding, reason: 'LEASE_EXPIRED' });
    if (begun) await assert.rejects(release, code('DELIVERY_RECONCILIATION_REQUIRED'));
    else assert.equal((await release).state, 'RELEASED');
  }
});

test('a duplicate begin returns the original snapshot and a different request key conflicts; a snapshot is not entitlement to resend', async () => {
  const { port, claim, confirm, binding, advance } = setup();
  await port.claimReservationForDelivery(claim);
  const first = await beginSubmission(port, claim);
  assert.deepEqual(await beginSubmission(port, claim), first);
  await assert.rejects(
    port.beginProviderSubmission({
      ...confirm,
      expectedLeaseVersion: 1,
      providerRequestKey: providerRequestKey('other-key'),
    }),
    code('IDEMPOTENCY_CONFLICT'),
  );
  advance(20 * 60_000);
  assert.deepEqual(await beginSubmission(port, claim), first);
  await assert.rejects(
    port.releaseBeforeSubmit({ ...binding, reason: 'CANCELLED_BEFORE_SUBMIT' }),
    code('DELIVERY_RECONCILIATION_REQUIRED'),
  );
  assert.equal((await port.confirmProviderAcceptance(confirm)).state, 'CONFIRMED');
});

test('confirming/settling a provider fact before the submission barrier is forbidden', async () => {
  const { port, claim, confirm, outcome } = setup();
  await port.claimReservationForDelivery(claim);
  await assert.rejects(
    port.confirmProviderAcceptance(confirm),
    code('INVALID_RESERVATION_TRANSITION'),
  );
  await assert.rejects(port.settleDelivery(outcome), code('INVALID_RESERVATION_TRANSITION'));
  await beginSubmission(port, claim);
  assert.equal((await port.settleDelivery(outcome)).status, 'SETTLED');
});

test('renew extends the expiry and bumps the version; an original duplicate does not extend again, and a conflicting request fails', async () => {
  const { port, claim, binding } = setup();
  const initial = await port.claimReservationForDelivery(claim);
  assert.equal(initial.leaseVersion, 1);
  const renew = { ...binding, expectedLeaseVersion: 1, leaseExpiresAt: '2026-09-09T00:10:00Z' };
  const renewed = await port.renewReservationLease(renew);
  assert.equal(renewed.leaseVersion, 2);
  assert.equal(renewed.leaseExpiresAt, renew.leaseExpiresAt);
  assert.deepEqual(
    await port.renewReservationLease({ ...renew, correlationId: 'retry-trace' }),
    renewed,
  );
  await assert.rejects(
    port.renewReservationLease({ ...renew, leaseExpiresAt: '2026-09-09T00:12:00Z' }),
    code('IDEMPOTENCY_CONFLICT'),
  );
  const second = await port.renewReservationLease({
    ...renew,
    expectedLeaseVersion: 2,
    leaseExpiresAt: '2026-09-09T00:15:00Z',
  });
  assert.equal(second.leaseVersion, 3);
});

test('renew fences a stale begin, and the expiry sweeper must read the new lease', async () => {
  const { port, claim, binding, confirm, advance } = setup();
  await port.claimReservationForDelivery(claim);
  await port.renewReservationLease({
    ...binding,
    expectedLeaseVersion: 1,
    leaseExpiresAt: '2026-09-09T00:10:00Z',
  });
  // A claim retry may return a snapshot of an old version, but it cannot be used to begin
  assert.equal((await port.claimReservationForDelivery(claim)).leaseVersion, 1);
  await assert.rejects(beginSubmission(port, claim), code('STALE_RESERVATION_LEASE'));
  advance(6 * 60_000);
  await assert.rejects(
    port.releaseBeforeSubmit({ ...binding, reason: 'LEASE_EXPIRED' }),
    code('INVALID_RESERVATION_LEASE'),
  );
  assert.equal(
    (await port.beginProviderSubmission({ ...confirm, expectedLeaseVersion: 2 })).status,
    'UNKNOWN_RECONCILING',
  );
});

test('renew rejects an invalid expiry/version, an expired lease and an extension beyond the reservation TTL', async () => {
  const { port, claim, binding, advance } = setup();
  await port.claimReservationForDelivery(claim);
  const renew = { ...binding, expectedLeaseVersion: 1, leaseExpiresAt: '2026-09-09T00:10:00Z' };
  for (const leaseExpiresAt of [
    'invalid',
    claim.leaseExpiresAt,
    '2026-09-09T00:04:00Z',
    '2026-09-09T00:16:00Z',
  ]) {
    await assert.rejects(
      port.renewReservationLease({ ...renew, leaseExpiresAt }),
      code('INVALID_RESERVATION_LEASE'),
    );
  }
  for (const expectedLeaseVersion of [0, 0.5, 2, -1, NaN]) {
    await assert.rejects(
      port.renewReservationLease({ ...renew, expectedLeaseVersion }),
      code('STALE_RESERVATION_LEASE'),
    );
  }
  advance(5 * 60_000);
  await assert.rejects(port.renewReservationLease(renew), code('RESERVATION_EXPIRED'));
  await assert.rejects(beginSubmission(port, claim), code('RESERVATION_EXPIRED'));
});

test('renew/begin reject a tenant, reservation, action and delivery swap', async () => {
  const { port, claim, binding, confirm } = setup();
  await port.claimReservationForDelivery(claim);
  for (const change of [
    { tenantId: tenantId('tenant-b') },
    { reservationId: reservationId('reservation-b') },
    { actionKey: actionKey('action-b') },
    { deliveryId: deliveryId('delivery-b') },
  ]) {
    const error = code(
      'tenantId' in change || 'reservationId' in change
        ? 'RESERVATION_NOT_FOUND'
        : 'RESERVATION_BINDING_CONFLICT',
    );
    await assert.rejects(
      port.renewReservationLease({
        ...binding,
        ...change,
        expectedLeaseVersion: 1,
        leaseExpiresAt: '2026-09-09T00:10:00Z',
      }),
      error,
    );
    await assert.rejects(
      port.beginProviderSubmission({ ...confirm, ...change, expectedLeaseVersion: 1 }),
      error,
    );
  }
  assert.equal((await beginSubmission(port, claim)).status, 'UNKNOWN_RECONCILING');
});

test('renew must not change state after the barrier/terminal, and begin is forbidden after release', async () => {
  for (const state of ['BARRIER', 'SETTLED', 'RELEASED']) {
    const { port, claim, binding, outcome } = setup();
    await port.claimReservationForDelivery(claim);
    if (state === 'RELEASED') {
      await port.releaseBeforeSubmit({ ...binding, reason: 'CANCELLED_BEFORE_SUBMIT' });
      await assert.rejects(beginSubmission(port, claim), code('INVALID_RESERVATION_TRANSITION'));
    } else {
      await beginSubmission(port, claim);
      if (state === 'SETTLED') await port.settleDelivery(outcome);
    }
    await assert.rejects(
      port.renewReservationLease({
        ...binding,
        expectedLeaseVersion: 1,
        leaseExpiresAt: '2026-09-09T00:10:00Z',
      }),
      code(
        state === 'BARRIER' ? 'DELIVERY_RECONCILIATION_REQUIRED' : 'INVALID_RESERVATION_TRANSITION',
      ),
    );
  }
});

test('a race between renew and begin on the same version lets only one operation succeed, in both orders', async () => {
  for (const beginFirst of [false, true]) {
    const { port, claim, binding, confirm } = setup();
    await port.claimReservationForDelivery(claim);
    const renew = () =>
      port.renewReservationLease({
        ...binding,
        expectedLeaseVersion: 1,
        leaseExpiresAt: '2026-09-09T00:10:00Z',
      });
    const begin = () => beginSubmission(port, claim);
    const operations = beginFirst ? [begin, renew] : [renew, begin];
    const results = await Promise.allSettled(operations.map((operation) => operation()));
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
    if (!beginFirst) await port.beginProviderSubmission({ ...confirm, expectedLeaseVersion: 2 });
    await assert.rejects(
      port.releaseBeforeSubmit({ ...binding, reason: 'CANCELLED_BEFORE_SUBMIT' }),
      code('DELIVERY_RECONCILIATION_REQUIRED'),
    );
  }
});

test('a race between begin and cancel lets only one operation succeed, and terminal does not revert', async () => {
  for (const beginFirst of [false, true]) {
    const { port, claim, binding } = setup();
    await port.claimReservationForDelivery(claim);
    const release = () =>
      port.releaseBeforeSubmit({ ...binding, reason: 'CANCELLED_BEFORE_SUBMIT' });
    const begin = () => beginSubmission(port, claim);
    const results = await Promise.allSettled(
      (beginFirst ? [begin, release] : [release, begin]).map((operation) => operation()),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    assert.equal(results.filter((r) => r.status === 'rejected').length, 1);
  }
});

test('a race between renewal and expiry release refers to the current lease; a concurrent renew has a single version', async () => {
  for (const expired of [false, true]) {
    const { port, claim, binding, advance } = setup();
    await port.claimReservationForDelivery(claim);
    if (expired) advance(5 * 60_000);
    const results = await Promise.allSettled([
      port.renewReservationLease({
        ...binding,
        expectedLeaseVersion: 1,
        leaseExpiresAt: '2026-09-09T00:10:00Z',
      }),
      port.releaseBeforeSubmit({ ...binding, reason: 'LEASE_EXPIRED' }),
    ]);
    assert.equal(results[0].status, expired ? 'rejected' : 'fulfilled');
    assert.equal(results[1].status, expired ? 'fulfilled' : 'rejected');
  }
  const { port, claim, binding } = setup();
  await port.claimReservationForDelivery(claim);
  const renew = { ...binding, expectedLeaseVersion: 1, leaseExpiresAt: '2026-09-09T00:10:00Z' };
  const same = await Promise.all(
    Array.from({ length: 8 }, () => port.renewReservationLease(renew)),
  );
  for (const result of same) assert.equal(result.leaseVersion, 2);
});
