import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { type TestContext } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  ContactGovernanceService,
  IdempotencyConflictError,
  ReservationNotUsableError,
} from './contact-governance-service.js';
import { InvalidReservationTransitionError } from './reservation.js';

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
    await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId } });
    await owner.cgRestriction.deleteMany({ where: { tenantId } });
    await owner.jrEventInbox.deleteMany({ where: { tenantId } });
    await owner.contact.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Governance ${tenantId}`,
      slug: `governance-${tenantId}`,
      sipDomain: `${tenantId}.governance.test`,
    },
  });
  await owner.contact.create({
    data: { id: contactId, tenantId, displayName: 'Governance contact' },
  });

  return { owner, application, tenantId, contactId };
}

test('authorizeAndReserve คืน decision และ reservation เดิมแบบ atomic เมื่อ retry', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  const decisionId = randomUUID();
  const reservationId = randomUUID();
  const now = new Date('2026-09-07T06:00:00.000Z');
  const ids = [decisionId, reservationId];

  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      purpose: 'MARKETING',
      channel: 'EMAIL',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
  });

  const service = new ContactGovernanceService(application, {
    now: () => now,
    id: () => ids.shift() ?? randomUUID(),
  });
  const input = {
    contactId,
    channel: 'EMAIL' as const,
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-001',
    actionKey: 'enrollment-001:1:step-001',
    policyVersion: 1,
  };

  const [created, retried] = await Promise.all([
    service.authorizeAndReserve(tenantId, input),
    service.authorizeAndReserve(tenantId, input),
  ]);

  assert.deepEqual(retried, created);
  assert.equal(created.decisionId, decisionId);
  assert.equal(created.decision, 'ALLOW');
  assert.equal(created.reasonCode, 'POLICY_PASSED');
  assert.equal(created.reservationId, reservationId);
  assert.equal(created.reservationExpiresAt, '2026-09-07T06:15:00.000Z');
  assert.equal(await owner.cgDecisionLog.count({ where: { tenantId } }), 1);
  assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 1);

  await assert.rejects(
    () => service.authorizeAndReserve(tenantId, { ...input, sourceId: 'journey-conflict' }),
    (error: unknown) => {
      assert.ok(error instanceof IdempotencyConflictError);
      assert.equal(error.code, 'IDEMPOTENCY_CONFLICT');
      return true;
    },
  );
});

test('hard restriction เขียน decision ที่อธิบายได้โดยไม่สร้าง reservation', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  const decisionId = randomUUID();
  const now = new Date('2026-09-07T07:00:00.000Z');

  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      purpose: 'MARKETING',
      channel: 'EMAIL',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  await owner.cgRestriction.create({
    data: {
      tenantId,
      contactId,
      type: 'DNC',
      scope: 'CONTACT',
      overridable: false,
      reasonCode: 'DNC_GLOBAL',
      source: 'CUSTOMER_REQUEST',
      startsAt: new Date('2026-09-06T00:00:00.000Z'),
      createdBy: 'integration-test',
    },
  });

  const service = new ContactGovernanceService(application, {
    now: () => now,
    id: () => decisionId,
  });
  const result = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'EMAIL',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-002',
    actionKey: 'enrollment-002:1:step-001',
    policyVersion: 1,
  });

  assert.equal(result.decisionId, decisionId);
  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.reasonCode, 'DNC_GLOBAL');
  assert.equal(result.reservationId, undefined);
  assert.equal(await owner.cgDecisionLog.count({ where: { tenantId } }), 1);
  assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 0);
});

test('consent ที่ถูกเพิกถอนปิดกั้น reservation ที่ canonical database boundary', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  const decisionId = randomUUID();

  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      purpose: 'MARKETING',
      channel: 'EMAIL',
      status: 'REVOKED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      revokedAt: new Date('2026-09-06T00:00:00.000Z'),
    },
  });

  const service = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-07T07:00:00.000Z'),
    id: () => decisionId,
  });
  const result = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'EMAIL',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-003',
    actionKey: 'enrollment-003:1:step-001',
    policyVersion: 1,
  });

  assert.equal(result.decision, 'BLOCK');
  assert.equal(result.reasonCode, 'CONSENT_REVOKED');
  assert.equal(result.reservationId, undefined);
  assert.equal(await owner.cgDecisionLog.count({ where: { tenantId } }), 1);
  assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 0);
});

test('reservation transition ที่ persist แล้วเป็น idempotent และย้อน state ไม่ได้', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  const now = new Date('2026-09-07T08:00:00.000Z');

  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      purpose: 'MARKETING',
      channel: 'EMAIL',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });
  const service = new ContactGovernanceService(application, {
    now: () => now,
  });
  const authorization = await service.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'EMAIL',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-004',
    actionKey: 'enrollment-004:1:step-001',
    policyVersion: 1,
  });
  assert.ok(authorization.reservationId);

  const confirmed = await service.changeReservationState(
    tenantId,
    authorization.reservationId,
    'CONFIRM',
  );
  const confirmedRetry = await service.changeReservationState(
    tenantId,
    authorization.reservationId,
    'CONFIRM',
  );
  assert.equal(confirmed.state, 'CONFIRMED');
  assert.deepEqual(confirmedRetry, confirmed);
  await assert.rejects(
    () => service.changeReservationState(tenantId, authorization.reservationId!, 'RELEASE'),
    InvalidReservationTransitionError,
  );

  const refunded = await service.changeReservationState(tenantId, authorization.reservationId, {
    type: 'REFUND',
    outcome: 'DELIVERY_FAILED',
  });
  const refundedRetry = await service.changeReservationState(
    tenantId,
    authorization.reservationId,
    { type: 'REFUND', outcome: 'DELIVERY_FAILED' },
  );
  assert.equal(refunded.state, 'REFUNDED');
  assert.deepEqual(refundedRetry, refunded);
  assert.equal(await owner.cgReservation.count({ where: { tenantId, state: 'REFUNDED' } }), 1);
});

test('delivery validation เป็น fail-closed หลังหมดอายุและ sweeper คืน quota ครั้งเดียว', async (t) => {
  const { owner, application, tenantId, contactId } = await createTenantFixture(t);
  await owner.cgConsent.create({
    data: {
      tenantId,
      contactId,
      purpose: 'MARKETING',
      channel: 'EMAIL',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
    },
  });

  const activeService = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-07T09:00:00.000Z'),
  });
  const authorization = await activeService.authorizeAndReserve(tenantId, {
    contactId,
    channel: 'EMAIL',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-005',
    actionKey: 'enrollment-005:1:step-001',
    policyVersion: 1,
  });
  assert.ok(authorization.reservationId);
  assert.equal(
    (await activeService.validateReservationForDelivery(tenantId, authorization.reservationId))
      .state,
    'RESERVED',
  );

  const expiredService = new ContactGovernanceService(application, {
    now: () => new Date('2026-09-07T09:16:00.000Z'),
  });
  await assert.rejects(
    () => expiredService.validateReservationForDelivery(tenantId, authorization.reservationId!),
    (error: unknown) => {
      assert.ok(error instanceof ReservationNotUsableError);
      assert.equal(error.code, 'RESERVATION_EXPIRED');
      return true;
    },
  );

  assert.equal(await expiredService.releaseExpiredReservations(tenantId), 1);
  assert.equal(await expiredService.releaseExpiredReservations(tenantId), 0);
  assert.equal(await owner.cgReservation.count({ where: { tenantId, state: 'RELEASED' } }), 1);
});
