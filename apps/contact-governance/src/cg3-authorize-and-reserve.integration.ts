import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { Prisma, PrismaClient } from '@d-contact/db';
import {
  actionKey,
  contactId,
  deliveryId,
  providerRequestKey,
  reservationId,
  tenantId as tenantIdBrand,
  ReservationBindingError,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceService } from './contact-governance-service.js';
import { Cg3PreferenceRepository } from './cg3-persistence.js';

const DIGEST = 'a'.repeat(64);

async function createTenantFixture(t: TestContext) {
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
    await owner.cgCallbackRequest.deleteMany({ where: { tenantId } });
    await owner.cgHolidayCalendarEntry.deleteMany({ where: { tenantId } });
    await owner.cgPolicy.deleteMany({ where: { tenantId } });
    await owner.cgEventOutbox.deleteMany({ where: { tenantId } });
    await owner.cgAuditLog.deleteMany({ where: { tenantId } });
    await owner.cgCommandReceipt.deleteMany({ where: { tenantId } });
    await owner.cgPreference.deleteMany({ where: { tenantId } });
    await owner.cgContactStateHead.deleteMany({ where: { tenantId } });
    await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId } });
    await owner.cgReservation.updateMany({
      where: { tenantId },
      data: { authorizationDecisionId: null },
    });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId } });
    await owner.cgRestriction.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `CG3 ${tenantId}`,
      slug: `cg3-${tenantId}`,
      sipDomain: `${tenantId}.cg3.test`,
    },
  });
  await owner.contact.create({
    data: { id: contactId, tenantId, displayName: 'CG3 contact' },
  });
  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      purpose: 'MARKETING',
      channel: 'LINE',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'cg3-integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });

  return { owner, application, tenantId, contactId };
}

async function publishPolicy(
  owner: PrismaClient,
  params: {
    tenantId: string;
    quietHours?: unknown[];
    callbackMode?: 'NO_OVERRIDE' | 'SCOPED_OVERRIDE' | 'TIME_POLICY_OVERRIDE';
    overridableRules?: string[];
    timezoneFallback?: string;
    holidays?: Array<{ localDate: string; effect: 'CLOSED' | 'WINDOWS'; windows?: unknown[] }>;
  },
) {
  const policyId = randomUUID();
  await owner.cgPolicy.create({
    data: {
      id: randomUUID(),
      tenantId: params.tenantId,
      policyId,
      version: 1,
      purpose: 'MARKETING',
      channel: 'LINE',
      timezoneFallback: params.timezoneFallback ?? 'Asia/Bangkok',
      quietHours: (params.quietHours ?? []) as unknown as Prisma.InputJsonValue,
      callbackMode: params.callbackMode ?? 'SCOPED_OVERRIDE',
      overridableRules: (params.overridableRules ?? []) as unknown as Prisma.InputJsonValue,
      status: 'PUBLISHED',
      contentDigest: DIGEST,
      makerActorRef: 'tenant-admin-1',
      checkerActorRef: 'compliance-1',
      approvalRef: 'approval-cg3-integration-test',
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      publishedAt: new Date('2026-01-01T00:00:00.000Z'),
    },
  });
  for (const holiday of params.holidays ?? []) {
    await owner.cgHolidayCalendarEntry.create({
      data: {
        id: randomUUID(),
        tenantId: params.tenantId,
        policyId,
        policyVersion: 1,
        localDate: new Date(`${holiday.localDate}T00:00:00.000Z`),
        effect: holiday.effect,
        windows: (holiday.windows ?? []) as unknown as Prisma.InputJsonValue,
        entryDigest: DIGEST,
      },
    });
  }
  return policyId;
}

async function requestCallback(
  owner: PrismaClient,
  params: {
    tenantId: string;
    contactId: string;
    channel: string;
    purpose: string;
    expiresAt: Date;
    approvedExceptionId?: string;
  },
) {
  const id = randomUUID();
  await owner.cgCallbackRequest.create({
    data: {
      id,
      tenantId: params.tenantId,
      seriesId: id,
      version: 1,
      contactId: params.contactId,
      channel: params.channel as never,
      purpose: params.purpose,
      requestedAt: new Date('2026-09-15T19:00:00.000Z'),
      requestedTimezone: 'Asia/Bangkok',
      expiresAt: params.expiresAt,
      sourceKind: 'CUSTOMER',
      oneUseTokenHash: randomUUID().replace(/-/g, '').padEnd(64, '0'),
      approvedExceptionId: params.approvedExceptionId,
      mutationKind: 'REQUEST',
      evidenceRef: 'cg3-integration-test',
      requestHash: DIGEST,
      actorClass: 'CUSTOMER',
    },
  });
  return id;
}

test('preference BLOCK ที่ scope เฉพาะเจาะจงปิดกั้นแม้ consent ยังมีผล', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  const preferences = new Cg3PreferenceRepository(application);
  await preferences.append({
    tenantId,
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'BLOCK',
    preferredWindows: [],
    sourceKind: 'CUSTOMER',
    occurredAt: '2026-09-10T00:00:00.000Z',
    effectiveFrom: '2026-09-10T00:00:00.000Z',
    evidenceRef: 'customer-opt-out',
    actorClass: 'CUSTOMER',
    actorRef: 'customer-1',
    idempotencyKey: randomUUID(),
    expectedVersion: 0,
    correlationId: randomUUID(),
  });

  const service = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-15T10:00:00.000Z'),
  });
  const result = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-cg3-001',
    actionKey: 'enrollment-cg3-001:1:step-001',
    policyVersion: 1,
  });

  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.reasonCode, 'PREFERENCE_BLOCKED');
  assert.equal(result.reservationId, undefined);
  assert.equal(result.preferenceVersion, 1);
  assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 0);
});

test('quiet hours ที่ไม่ overridable ให้ DEFER พร้อม nextEligibleAt ที่ persist ไว้', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  await publishPolicy(owner, {
    tenantId,
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
  });

  const service = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-15T20:00:00.000Z'), // 03:00 Asia/Bangkok วันถัดไป
  });
  const result = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-cg3-002',
    actionKey: 'enrollment-cg3-002:1:step-001',
    policyVersion: 1,
  });

  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'QUIET_HOURS');
  assert.ok(result.nextEligibleAt);
  assert.equal(result.reservationId, undefined);

  const decision = await owner.cgDecisionLog.findUniqueOrThrow({
    where: { id: result.decisionId },
  });
  assert.equal(decision.nextEligibleAt?.toISOString(), result.nextEligibleAt);
  assert.equal(decision.timezoneSource, 'POLICY_FALLBACK');
});

test('SCOPED_OVERRIDE callback ที่ valid ยก quiet hours แล้วสร้าง reservation พร้อม authorization version และ consume callback', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  await publishPolicy(owner, {
    tenantId,
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
    overridableRules: ['QUIET_HOURS'],
  });
  const callbackId = await requestCallback(owner, {
    tenantId,
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    expiresAt: new Date('2026-09-16T00:00:00.000Z'),
  });

  const service = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-15T20:00:00.000Z'),
  });
  const result = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-cg3-003',
    actionKey: 'enrollment-cg3-003:1:step-001',
    policyVersion: 1,
  });

  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.reasonCode, 'POLICY_PASSED');
  assert.ok(result.reservationId);
  assert.equal(result.aggregateVersion, 0);
  assert.equal(result.exceptionMode, 'SCOPED_OVERRIDE');
  assert.equal(result.exceptionRef, callbackId);

  const reservation = await owner.cgReservation.findUniqueOrThrow({
    where: { id: result.reservationId },
  });
  assert.equal(reservation.authorizationPolicyVersion, 1);
  assert.equal(reservation.authorizationDecisionId, result.decisionId);

  const callbackHistory = await owner.cgCallbackRequest.findMany({
    where: { tenantId, seriesId: callbackId },
    orderBy: { version: 'asc' },
  });
  assert.equal(callbackHistory.length, 2);
  assert.equal(callbackHistory[1]!.mutationKind, 'CONSUME');
  assert.equal(callbackHistory[1]!.supersedesId, callbackId);
});

test('preference ALLOW ยกไม่ได้เมื่อ consent ถูกเพิกถอน (S1-CG3-F02)', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  await owner.cgConsent.updateMany({
    where: { tenantId, contactId },
    data: { status: 'REVOKED', revokedAt: new Date('2026-09-14T00:00:00.000Z') },
  });
  const preferences = new Cg3PreferenceRepository(application);
  await preferences.append({
    tenantId,
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'ALLOW',
    preferredWindows: [],
    sourceKind: 'CUSTOMER',
    occurredAt: '2026-09-10T00:00:00.000Z',
    effectiveFrom: '2026-09-10T00:00:00.000Z',
    evidenceRef: 'customer-opt-in',
    actorClass: 'CUSTOMER',
    actorRef: 'customer-1',
    idempotencyKey: randomUUID(),
    expectedVersion: 0,
    correlationId: randomUUID(),
  });

  const service = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-15T10:00:00.000Z'),
  });
  const result = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-cg3-004',
    actionKey: 'enrollment-cg3-004:1:step-001',
    policyVersion: 1,
  });

  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.reasonCode, 'CONSENT_REVOKED');
  assert.equal(
    result.trace.some((entry) => entry.gate === 'PREFERENCE'),
    false,
  );
  assert.equal(result.reservationId, undefined);
});

test('ไม่มี CG3 data เลยยัง ALLOW เหมือน C1 เดิม พร้อม trace ที่ผ่านทุก gate ใหม่', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  const service = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-15T10:00:00.000Z'),
  });
  const result = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-cg3-005',
    actionKey: 'enrollment-cg3-005:1:step-001',
    policyVersion: 1,
  });

  assert.equal(result.decision, 'ALLOW');
  assert.equal(result.reasonCode, 'POLICY_PASSED');
  assert.ok(result.reservationId);
  assert.deepEqual(
    result.trace.map((entry) => entry.gate),
    [
      'IDENTITY',
      'HARD_RESTRICTION',
      'CONSENT',
      'PREFERENCE',
      'TEMPORAL_POLICY',
      'ATTEMPT_TOUCH_CAP',
      'SENDER_IDENTITY',
    ],
  );
  const reservation = await owner.cgReservation.findUniqueOrThrow({
    where: { id: result.reservationId },
  });
  assert.equal(reservation.authorizationAggregateVersion, 0);
});

test('S1-CG3-CC01: callback หนึ่งครั้งถูก consume ได้แค่ครั้งเดียวแม้เรียกสองครั้งติดกัน', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  await publishPolicy(owner, {
    tenantId,
    quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
    overridableRules: ['QUIET_HOURS'],
  });
  await requestCallback(owner, {
    tenantId,
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    expiresAt: new Date('2026-09-16T00:00:00.000Z'),
  });

  const service = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-15T20:00:00.000Z'),
  });
  const first = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-cg3-006a',
    actionKey: 'enrollment-cg3-006:1:step-001',
    policyVersion: 1,
  });
  const second = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-cg3-006b',
    actionKey: 'enrollment-cg3-006:2:step-001',
    policyVersion: 1,
  });

  assert.equal(first.decision, 'ALLOW');
  // callback ถูก consume ไปแล้วจาก call แรก จึงยกไม่ได้อีกในครั้งที่สอง
  assert.equal(second.decision, 'DEFER');
  assert.equal(second.reasonCode, 'QUIET_HOURS');

  const consumeRows = await owner.cgCallbackRequest.count({
    where: { tenantId, mutationKind: 'CONSUME' },
  });
  assert.equal(consumeRows, 1);
});

test('beginProviderSubmission revalidate authorization aggregate version ก่อนข้าม submission barrier (#98 §3)', async (t) => {
  const { application, tenantId, contactId: rawContactId } = await createTenantFixture(t);
  const service = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-15T10:00:00.000Z'),
  });
  const authorization = await service.authorizeAndReserve(tenantId, {
    contactId: rawContactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-cg3-007',
    actionKey: 'enrollment-cg3-007:1:step-001',
    policyVersion: 1,
  });
  assert.ok(authorization.reservationId);
  const reservedId = authorization.reservationId!;
  assert.equal(authorization.aggregateVersion, 0);

  const claimed = await service.claimReservationForDelivery({
    tenantId: tenantIdBrand(tenantId),
    correlationId: 'correlation-claim',
    reservationId: reservationId(reservedId),
    actionKey: actionKey('enrollment-cg3-007:1:step-001'),
    deliveryId: deliveryId('delivery-cg3-007'),
    contactId: contactId(rawContactId),
    channel: 'LINE',
    purpose: 'MARKETING',
    senderIdentityId: 'sender-approved',
    leaseExpiresAt: '2026-09-15T10:15:00.000Z',
  });
  assert.equal(claimed.status, 'CLAIMED');

  // preference mutation ใหม่ bump aggregateVersion ของ contact นี้หลัง authorize ไปแล้ว
  const preferences = new Cg3PreferenceRepository(application);
  await preferences.append({
    tenantId,
    contactId: rawContactId,
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'ALLOW',
    preferredWindows: [],
    sourceKind: 'CUSTOMER',
    occurredAt: '2026-09-15T10:05:00.000Z',
    effectiveFrom: '2026-09-15T10:05:00.000Z',
    evidenceRef: 'customer-update',
    actorClass: 'CUSTOMER',
    actorRef: 'customer-1',
    idempotencyKey: randomUUID(),
    expectedVersion: 0,
    correlationId: randomUUID(),
  });

  await assert.rejects(
    () =>
      service.beginProviderSubmission({
        tenantId: tenantIdBrand(tenantId),
        correlationId: 'correlation-begin',
        reservationId: reservationId(reservedId),
        actionKey: actionKey('enrollment-cg3-007:1:step-001'),
        deliveryId: deliveryId('delivery-cg3-007'),
        expectedLeaseVersion: 1,
        providerRequestKey: providerRequestKey('provider-cg3-007'),
      }),
    (error: unknown) => {
      assert.ok(error instanceof ReservationBindingError);
      assert.equal(error.code, 'GOVERNANCE_VERSION_STALE');
      return true;
    },
  );
});
