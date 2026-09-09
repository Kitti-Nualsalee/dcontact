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

test('authorization คง signature เดิมและ duplicate/conflict contract โดยไม่ import concrete app', async () => {
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

test('concurrent claim ค่าเดิมได้ binding เดียว; binding ต่างถูกปฏิเสธ', async () => {
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

test('expiry และ invalid lease กัน claim แต่ปล่อย expired reservation ก่อน submit ได้', async () => {
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

test('release ก่อน submit idempotent และ terminal ไม่ย้อนไป confirmed', async () => {
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

test('lease หมดหลัง claim ก่อน submit ปล่อยได้; lease ยังไม่หมดปล่อยด้วย expiry ไม่ได้', async () => {
  const { port, claim, binding, advance } = setup();
  await port.claimReservationForDelivery(claim);
  const input = { ...binding, reason: 'LEASE_EXPIRED' as const };
  await assert.rejects(port.releaseBeforeSubmit(input), code('INVALID_RESERVATION_LEASE'));
  advance(6 * 60_000);
  assert.equal((await port.releaseBeforeSubmit(input)).state, 'RELEASED');
});

test('timeout หลัง submit ห้าม release แม้ TTL หมด; reconcile ด้วย request key เดิม', async () => {
  const { port, claim, binding, confirm, outcome, advance } = setup();
  await port.claimReservationForDelivery(claim);
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

test('confirm duplicate, concurrent outcome และ late outcome ไม่ย้อน terminal state', async () => {
  const { port, claim, confirm, outcome } = setup();
  await port.claimReservationForDelivery(claim);
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

test('terminal failure refund ตาม Governance fixture policy เท่านั้น', async () => {
  for (const refund of [true, false]) {
    const { port, claim, confirm, outcome } = setup(refund);
    await port.claimReservationForDelivery(claim);
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

test('provider rejection ก่อน accept release; terminal failure ที่ไม่มี acceptance ต้อง reconcile', async () => {
  const { port, claim, outcome } = setup();
  await port.claimReservationForDelivery(claim);
  await assert.rejects(
    port.settleDelivery({ ...outcome, outcome: 'DELIVERY_FAILED' }),
    code('DELIVERY_RECONCILIATION_REQUIRED'),
  );
  assert.equal(
    (await port.settleDelivery({ ...outcome, outcome: 'PROVIDER_REJECTED' })).state,
    'RELEASED',
  );
});

test('confirm/release/outcome ปฏิเสธ tenant และ delivery swap ก่อนเปลี่ยน state', async () => {
  const { port, claim, confirm, binding, outcome } = setup();
  await port.claimReservationForDelivery(claim);
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

test('claim สอง delivery แข่งกันต้องมีผู้ชนะเดียว', async () => {
  const { port, claim } = setup();
  const result = await Promise.allSettled([
    port.claimReservationForDelivery(claim),
    port.claimReservationForDelivery({ ...claim, deliveryId: deliveryId('competing-delivery') }),
  ]);
  assert.equal(result.filter((r) => r.status === 'fulfilled').length, 1);
  assert.equal(result.filter((r) => r.status === 'rejected').length, 1);
});

test('delivered ที่มาก่อน acceptance callback ยืนยันได้และ callback ช้าไม่ย้อน terminal', async () => {
  const { port, claim, confirm, outcome, binding } = setup();
  await port.claimReservationForDelivery(claim);
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

test('outcomeRef เดียวกันข้าม tenant แยกกัน แต่ reuse ข้าม action ใน tenant เดียวต้อง conflict', async () => {
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
  }
  await port.claimReservationForDelivery(claim);
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
