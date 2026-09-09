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

test('confirm duplicate, concurrent outcome และ late outcome ไม่ย้อน terminal state', async () => {
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

test('terminal failure refund ตาม Governance fixture policy เท่านั้น', async () => {
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

test('provider rejection ก่อน accept release; terminal failure ที่ไม่มี acceptance ต้อง reconcile', async () => {
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

test('confirm/release/outcome ปฏิเสธ tenant และ delivery swap ก่อนเปลี่ยน state', async () => {
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

test('crash ก่อน barrier ปล่อย lease ได้ แต่ crash หลัง barrier ห้ามคืนสิทธิ์แม้ไม่มี callback', async () => {
  for (const begun of [false, true]) {
    const { port, claim, binding, advance } = setup();
    await port.claimReservationForDelivery(claim);
    if (begun) {
      const barrier = await beginSubmission(port, claim);
      assert.equal(barrier.state, 'RESERVED');
      assert.equal(barrier.status, 'UNKNOWN_RECONCILING');
    }
    // worker หายไปโดยไม่ confirm/settle; ทั้ง lease และ reservation TTL หมดแล้ว
    advance(20 * 60_000);
    const release = port.releaseBeforeSubmit({ ...binding, reason: 'LEASE_EXPIRED' });
    if (begun) await assert.rejects(release, code('DELIVERY_RECONCILIATION_REQUIRED'));
    else assert.equal((await release).state, 'RELEASED');
  }
});

test('begin duplicate คืน snapshot เดิมและ request key อื่น conflict; snapshot ไม่ใช่สิทธิ์ส่งซ้ำ', async () => {
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

test('ห้าม confirm/settle provider fact ก่อนมี submission barrier', async () => {
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

test('renew ต่อ expiry และเพิ่ม version; duplicate เดิมไม่ต่อซ้ำ ส่วน conflicting request ไม่ผ่าน', async () => {
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

test('renew fence stale begin และ expiry sweeper ต้องอ่าน lease ใหม่', async () => {
  const { port, claim, binding, confirm, advance } = setup();
  await port.claimReservationForDelivery(claim);
  await port.renewReservationLease({
    ...binding,
    expectedLeaseVersion: 1,
    leaseExpiresAt: '2026-09-09T00:10:00Z',
  });
  // Claim retry คืน snapshot version เก่าได้ แต่เอาไป begin ไม่ได้
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

test('renew ปฏิเสธ invalid expiry/version, expired lease และการต่อเกิน reservation TTL', async () => {
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

test('renew/begin ปฏิเสธ tenant, reservation, action และ delivery swap', async () => {
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

test('renew ห้ามเปลี่ยน state หลัง barrier/terminal และ begin ห้ามหลัง release', async () => {
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

test('race renew กับ begin ใช้ version เดียวกัน สำเร็จได้ operation เดียวทั้งสองลำดับ', async () => {
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

test('race begin กับ cancel สำเร็จได้ operation เดียวและ terminal ไม่ย้อน', async () => {
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

test('race renewal กับ expiry release อ้าง lease ปัจจุบัน; concurrent renew มี version เดียว', async () => {
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
