import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  actionKey,
  contactId,
  deliveryId,
  identityId,
  outcomeRef,
  providerRequestKey,
  reservationId,
  tenantId,
  ReservationBindingError,
  type ClaimReservationForDeliveryInput,
  type ReservationBindingErrorCode,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceService } from './contact-governance-service.js';

async function fixture(t: TestContext, legacyNullStatus = false) {
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
  const rawTenantId = randomUUID();
  const rawContactId = randomUUID();
  const rawIdentityId = randomUUID();
  const rawReservationId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);
  let currentTime = new Date('2026-09-10T09:00:00.000Z');

  t.after(async () => {
    await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgTouch.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgAttempt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contact.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `CG runtime ${suffix}`,
      slug: `cg-runtime-${suffix}`,
      sipDomain: `${suffix}.cg-runtime.test`,
    },
  });
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'CG runtime contact' },
  });
  await owner.contactIdentity.create({
    data: {
      id: rawIdentityId,
      tenantId: rawTenantId,
      contactId: rawContactId,
      type: 'EMAIL',
      value: `runtime-${suffix}@example.test`,
    },
  });

  async function createReservation(label = 'primary') {
    const rawId = label === 'primary' ? rawReservationId : randomUUID();
    await owner.cgReservation.create({
      data: {
        id: rawId,
        tenantId: rawTenantId,
        contactId: rawContactId,
        identityId: rawIdentityId,
        channel: 'EMAIL',
        purpose: 'MARKETING',
        source: 'JOURNEY',
        sourceId: `journey-${label}`,
        actionKey: `action-${suffix}-${label}`,
        inputHash: `hash-${suffix}-${label}`,
        expiresAt: new Date('2026-09-10T10:00:00.000Z'),
        ...(!legacyNullStatus || label !== 'primary'
          ? { settlementStatus: 'UNCLAIMED' as const }
          : {}),
      },
    });
    return {
      reservationId: reservationId(rawId),
      actionKey: actionKey(`action-${suffix}-${label}`),
    };
  }

  const primary = await createReservation();
  const tenant = tenantId(rawTenantId);
  const contact = contactId(rawContactId);
  const identity = identityId(rawIdentityId);
  const service = (options: ConstructorParameters<typeof ContactGovernanceService>[1] = {}) =>
    new ContactGovernanceService(application, {
      now: () => currentTime,
      ...options,
    });

  return {
    owner,
    application,
    tenantId: tenant,
    contactId: contact,
    identityId: identity,
    ...primary,
    createReservation,
    service,
    setNow(value: string) {
      currentTime = new Date(value);
    },
  };
}

function commands(
  f: Awaited<ReturnType<typeof fixture>>,
  binding: {
    reservationId: ReturnType<typeof reservationId>;
    actionKey: ReturnType<typeof actionKey>;
  } = f,
  delivery = 'delivery-primary',
) {
  const claim: ClaimReservationForDeliveryInput = {
    tenantId: f.tenantId,
    correlationId: 'correlation-claim',
    reservationId: binding.reservationId,
    actionKey: binding.actionKey,
    deliveryId: deliveryId(delivery),
    contactId: f.contactId,
    identityId: f.identityId,
    channel: 'EMAIL',
    purpose: 'MARKETING',
    senderIdentityId: 'sender-approved',
    leaseExpiresAt: '2026-09-10T09:15:00.000Z',
  };
  const begin = {
    tenantId: f.tenantId,
    correlationId: 'correlation-begin',
    reservationId: binding.reservationId,
    actionKey: binding.actionKey,
    deliveryId: claim.deliveryId,
    expectedLeaseVersion: 1,
    providerRequestKey: providerRequestKey(`provider-${delivery}`),
  };
  const renew = {
    tenantId: f.tenantId,
    correlationId: 'correlation-renew',
    reservationId: binding.reservationId,
    actionKey: binding.actionKey,
    deliveryId: claim.deliveryId,
    expectedLeaseVersion: 1,
    leaseExpiresAt: '2026-09-10T09:30:00.000Z',
  };
  const confirm = {
    tenantId: f.tenantId,
    correlationId: 'correlation-confirm',
    reservationId: binding.reservationId,
    actionKey: binding.actionKey,
    deliveryId: claim.deliveryId,
    providerRequestKey: begin.providerRequestKey,
  };
  const delivered = {
    ...confirm,
    correlationId: 'correlation-outcome',
    outcomeRef: outcomeRef(`outcome-${delivery}`),
    outcome: 'DELIVERED' as const,
    occurredAt: '2026-09-10T09:05:00.000Z',
  };
  return { claim, renew, begin, confirm, delivered };
}

function errorCode(expected: ReservationBindingErrorCode) {
  return (error: unknown) => {
    assert.ok(error instanceof ReservationBindingError);
    assert.equal(error.code, expected);
    return true;
  };
}

test('claim-renew-begin-confirm-settle persist ครบและ duplicate หลัง restart คืน snapshot เดิม', async (t) => {
  const f = await fixture(t);
  const first = f.service();
  const { claim, renew, begin, confirm, delivered } = commands(f);

  const claimed = await first.claimReservationForDelivery(claim);
  const renewed = await first.renewReservationLease(renew);
  const renewedBegin = { ...begin, expectedLeaseVersion: 2 };
  const barrier = await first.beginProviderSubmission(renewedBegin);
  const accepted = await first.confirmProviderAcceptance(confirm);
  const settled = await first.settleDelivery(delivered);

  assert.equal(claimed.status, 'CLAIMED');
  assert.equal(renewed.leaseVersion, 2);
  assert.equal(barrier.status, 'UNKNOWN_RECONCILING');
  assert.equal(accepted.status, 'ACCEPTED');
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.state, 'CONFIRMED');
  assert.equal(await f.owner.cgAttempt.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.cgTouch.count({ where: { tenantId: f.tenantId } }), 1);

  const restarted = f.service();
  assert.deepEqual(
    await restarted.claimReservationForDelivery({ ...claim, correlationId: 'retry-claim' }),
    claimed,
  );
  assert.deepEqual(
    await restarted.renewReservationLease({ ...renew, correlationId: 'retry-renew' }),
    renewed,
  );
  assert.deepEqual(
    await restarted.beginProviderSubmission({
      ...renewedBegin,
      correlationId: 'retry-begin',
    }),
    barrier,
  );
  assert.deepEqual(
    await restarted.confirmProviderAcceptance({ ...confirm, correlationId: 'retry-confirm' }),
    accepted,
  );
  assert.deepEqual(
    await restarted.settleDelivery({ ...delivered, correlationId: 'retry-outcome' }),
    settled,
  );
});

test('claim รองรับ E0 row ที่ settlement fields เป็น null และ conflicting duplicate fail closed', async (t) => {
  const f = await fixture(t, true);
  const service = f.service();
  const { claim } = commands(f);
  const claimed = await service.claimReservationForDelivery(claim);
  assert.equal(claimed.status, 'CLAIMED');
  assert.equal(claimed.leaseVersion, 1);

  await assert.rejects(
    () =>
      service.claimReservationForDelivery({
        ...claim,
        deliveryId: deliveryId('conflicting-delivery'),
      }),
    errorCode('IDEMPOTENCY_CONFLICT'),
  );
});

test('concurrent claim ของ delivery เดียวให้ reservation เดียวชนะ', async (t) => {
  const f = await fixture(t);
  const second = await f.createReservation('second');
  const service = f.service();
  const firstClaim = commands(f).claim;
  const secondClaim = commands(f, second).claim;

  const results = await Promise.allSettled([
    service.claimReservationForDelivery(firstClaim),
    service.claimReservationForDelivery(secondClaim),
  ]);
  assert.equal(results.filter(({ status }) => status === 'fulfilled').length, 1);
  const rejected = results.find(({ status }) => status === 'rejected');
  assert.equal(rejected?.status, 'rejected');
  if (rejected?.status === 'rejected')
    assert.ok(errorCode('RESERVATION_BINDING_CONFLICT')(rejected.reason));
});

test('race renew/begin และ release/begin ทำ business transition ได้ครั้งเดียว', async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const primary = commands(f);
  await service.claimReservationForDelivery(primary.claim);

  const renewBeginRace = await Promise.allSettled([
    service.renewReservationLease({ ...primary.renew, correlationId: 'race-renew' }),
    service.beginProviderSubmission(primary.begin),
  ]);
  assert.equal(renewBeginRace.filter(({ status }) => status === 'fulfilled').length, 1);

  const second = await f.createReservation('release-race');
  const other = commands(f, second, 'delivery-release-race');
  await service.claimReservationForDelivery(other.claim);
  const releaseBeginRace = await Promise.allSettled([
    service.releaseBeforeSubmit({
      tenantId: f.tenantId,
      correlationId: 'race-release',
      reservationId: second.reservationId,
      actionKey: second.actionKey,
      deliveryId: other.claim.deliveryId,
      reason: 'CANCELLED_BEFORE_SUBMIT',
    }),
    service.beginProviderSubmission(other.begin),
  ]);
  assert.equal(releaseBeginRace.filter(({ status }) => status === 'fulfilled').length, 1);
});

test('barrier คง durable หลัง restart/lease expiry และบังคับ reconcile แทน release', async (t) => {
  const f = await fixture(t);
  const initial = f.service();
  const command = commands(f);
  await initial.claimReservationForDelivery(command.claim);
  await initial.beginProviderSubmission(command.begin);

  f.setNow('2026-09-10T10:01:00.000Z');
  const restarted = f.service();
  await assert.rejects(
    () =>
      restarted.releaseBeforeSubmit({
        tenantId: f.tenantId,
        correlationId: 'release-after-crash',
        reservationId: f.reservationId,
        actionKey: f.actionKey,
        deliveryId: command.claim.deliveryId,
        reason: 'LEASE_EXPIRED',
      }),
    errorCode('DELIVERY_RECONCILIATION_REQUIRED'),
  );
  assert.equal(await restarted.releaseExpiredReservations(f.tenantId), 0);
  assert.equal(
    (await f.owner.cgReservation.findUniqueOrThrow({ where: { id: f.reservationId } })).state,
    'RESERVED',
  );
  assert.equal(
    (
      await restarted.settleDelivery({
        ...command.delivered,
        outcomeRef: outcomeRef('outcome-still-unknown'),
        outcome: 'UNKNOWN_RECONCILING',
      })
    ).status,
    'UNKNOWN_RECONCILING',
  );
  assert.equal((await restarted.confirmProviderAcceptance(command.confirm)).status, 'ACCEPTED');
});

test('sweeper ปล่อย claimed lease ที่หมดอายุก่อน submission เพียงครั้งเดียว', async (t) => {
  const f = await fixture(t);
  const service = f.service();
  await service.claimReservationForDelivery(commands(f).claim);
  f.setNow('2026-09-10T09:20:00.000Z');

  assert.equal(await service.releaseExpiredReservations(f.tenantId), 1);
  assert.equal(await service.releaseExpiredReservations(f.tenantId), 0);
  const released = await f.owner.cgReservation.findUniqueOrThrow({
    where: { id: f.reservationId },
  });
  assert.equal(released.state, 'RELEASED');
  assert.equal(released.settlementStatus, 'SETTLED');
});

test('release ก่อน submit คืน durable snapshot เดิมหลัง restart', async (t) => {
  const f = await fixture(t);
  const command = commands(f);
  const initial = f.service();
  await initial.claimReservationForDelivery(command.claim);
  const release = {
    tenantId: f.tenantId,
    correlationId: 'correlation-release',
    reservationId: f.reservationId,
    actionKey: f.actionKey,
    deliveryId: command.claim.deliveryId,
    reason: 'CANCELLED_BEFORE_SUBMIT' as const,
  };

  const released = await initial.releaseBeforeSubmit(release);
  assert.equal(released.state, 'RELEASED');
  assert.equal(released.status, 'SETTLED');
  assert.deepEqual(
    await f.service().releaseBeforeSubmit({ ...release, correlationId: 'retry-release' }),
    released,
  );
});

test('legacy state transition ข้าม delivery binding และ submission barrier ไม่ได้', async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const command = commands(f);
  await service.claimReservationForDelivery(command.claim);

  await assert.rejects(
    () => service.changeReservationState(f.tenantId, f.reservationId, 'CONFIRM'),
    errorCode('INVALID_RESERVATION_TRANSITION'),
  );

  await service.beginProviderSubmission(command.begin);
  await assert.rejects(
    () => service.changeReservationState(f.tenantId, f.reservationId, 'RELEASE'),
    errorCode('DELIVERY_RECONCILIATION_REQUIRED'),
  );
});

test('pre-barrier และ terminal transition คืน error code ตาม ContactGovernancePort contract', async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const command = commands(f);
  await service.claimReservationForDelivery(command.claim);

  await assert.rejects(
    () => service.confirmProviderAcceptance(command.confirm),
    errorCode('INVALID_RESERVATION_TRANSITION'),
  );
  await assert.rejects(
    () => service.settleDelivery(command.delivered),
    errorCode('INVALID_RESERVATION_TRANSITION'),
  );

  await service.beginProviderSubmission(command.begin);
  await service.settleDelivery(command.delivered);
  await assert.rejects(
    () => service.renewReservationLease(command.renew),
    errorCode('INVALID_RESERVATION_TRANSITION'),
  );
  await assert.rejects(
    () =>
      service.releaseBeforeSubmit({
        tenantId: f.tenantId,
        correlationId: 'release-after-terminal',
        reservationId: f.reservationId,
        actionKey: f.actionKey,
        deliveryId: command.claim.deliveryId,
        reason: 'CANCELLED_BEFORE_SUBMIT',
      }),
    errorCode('INVALID_RESERVATION_TRANSITION'),
  );
  await assert.rejects(
    () => service.confirmProviderAcceptance(command.confirm),
    errorCode('INVALID_RESERVATION_TRANSITION'),
  );
});

test('terminal outcome แรกสร้าง fact ครั้งเดียวและ late outcome ไม่ย้อน state', async (t) => {
  const f = await fixture(t);
  const service = f.service();
  const command = commands(f);
  await service.claimReservationForDelivery(command.claim);
  await service.beginProviderSubmission(command.begin);
  const delivered = await service.settleDelivery(command.delivered);

  const late = await service.settleDelivery({
    ...command.delivered,
    outcomeRef: outcomeRef('late-failure'),
    outcome: 'DELIVERY_FAILED',
    occurredAt: '2026-09-10T09:06:00.000Z',
  });
  assert.deepEqual(late, delivered);
  assert.equal(late.state, 'CONFIRMED');
  assert.equal(await f.owner.cgAttempt.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.cgTouch.count({ where: { tenantId: f.tenantId } }), 1);

  await assert.rejects(
    () =>
      service.settleDelivery({
        ...command.delivered,
        outcome: 'DELIVERY_FAILED',
      }),
    errorCode('IDEMPOTENCY_CONFLICT'),
  );
});

test('failed outcome ก่อน acceptance ต้อง reconcile และ refund ใช้ policy ของ Governance', async (t) => {
  const f = await fixture(t);
  const command = commands(f);
  const defaultService = f.service();
  await defaultService.claimReservationForDelivery(command.claim);
  await defaultService.beginProviderSubmission(command.begin);
  await assert.rejects(
    () =>
      defaultService.settleDelivery({
        ...command.delivered,
        outcomeRef: outcomeRef('failed-before-acceptance'),
        outcome: 'DELIVERY_FAILED',
      }),
    errorCode('DELIVERY_RECONCILIATION_REQUIRED'),
  );

  await defaultService.confirmProviderAcceptance(command.confirm);
  const failed = await defaultService.settleDelivery({
    ...command.delivered,
    outcomeRef: outcomeRef('failed-after-acceptance'),
    outcome: 'DELIVERY_FAILED',
  });
  assert.equal(failed.state, 'REFUNDED');
  assert.equal(failed.status, 'SETTLED');
  assert.equal(await f.owner.cgTouch.count({ where: { tenantId: f.tenantId } }), 0);
});

test('provider rejection หลัง barrier release quota และสร้าง Attempt โดยไม่สร้าง Touch', async (t) => {
  const f = await fixture(t);
  const command = commands(f);
  const service = f.service();
  await service.claimReservationForDelivery(command.claim);
  await service.beginProviderSubmission(command.begin);

  const rejected = await service.settleDelivery({
    ...command.delivered,
    outcomeRef: outcomeRef('provider-rejected'),
    outcome: 'PROVIDER_REJECTED',
  });
  assert.equal(rejected.state, 'RELEASED');
  assert.equal(rejected.status, 'SETTLED');
  assert.equal(await f.owner.cgAttempt.count({ where: { tenantId: f.tenantId } }), 1);
  assert.equal(await f.owner.cgTouch.count({ where: { tenantId: f.tenantId } }), 0);
});

test('failure ระหว่างสร้าง Attempt rollback settlement แล้ว retry หลัง restart สำเร็จ', async (t) => {
  const f = await fixture(t);
  const command = commands(f);
  const setup = f.service();
  await setup.claimReservationForDelivery(command.claim);
  await setup.beginProviderSubmission(command.begin);
  await setup.confirmProviderAcceptance(command.confirm);

  const blocker = await f.createReservation('attempt-id-collision');
  const collidingAttemptId = randomUUID();
  await f.owner.cgAttempt.create({
    data: {
      id: collidingAttemptId,
      tenantId: f.tenantId,
      reservationId: blocker.reservationId,
      deliveryId: 'delivery-id-collision',
      outcomeRef: 'outcome-id-collision',
      contactId: f.contactId,
      identityId: f.identityId,
      channel: 'EMAIL',
      purpose: 'MARKETING',
      source: 'JOURNEY',
      outcome: 'DELIVERED',
      occurredAt: new Date('2026-09-10T09:04:00.000Z'),
      correlationId: 'correlation-id-collision',
    },
  });

  const crashing = f.service({ id: () => collidingAttemptId });
  await assert.rejects(() => crashing.settleDelivery(command.delivered));
  const afterCrash = await f.owner.cgReservation.findUniqueOrThrow({
    where: { id: f.reservationId },
  });
  assert.equal(afterCrash.settlementStatus, 'ACCEPTED');
  assert.equal(afterCrash.terminalOutcome, null);
  assert.equal(
    await f.owner.cgAttempt.count({
      where: { tenantId: f.tenantId, outcomeRef: command.delivered.outcomeRef },
    }),
    0,
  );

  const recovered = await f.service().settleDelivery(command.delivered);
  assert.equal(recovered.status, 'SETTLED');
  assert.equal(
    await f.owner.cgAttempt.count({
      where: { tenantId: f.tenantId, outcomeRef: command.delivered.outcomeRef },
    }),
    1,
  );
});

test('cross-tenant reservation swap ไม่เปิดเผย row และไม่เปลี่ยน state', async (t) => {
  const tenantA = await fixture(t);
  const tenantB = await fixture(t);
  const service = tenantA.service();
  const foreign = commands(tenantB).claim;

  await assert.rejects(
    () => service.claimReservationForDelivery({ ...foreign, tenantId: tenantA.tenantId }),
    errorCode('RESERVATION_NOT_FOUND'),
  );
  const untouched = await tenantB.owner.cgReservation.findUniqueOrThrow({
    where: { id: tenantB.reservationId },
  });
  assert.equal(untouched.deliveryId, null);
  assert.equal(untouched.settlementStatus, 'UNCLAIMED');
});
