import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test, { after } from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import {
  actionKey,
  contactId,
  identityId,
  reservationId,
  tenantId,
  type EnqueueDeliveryCommand,
} from '@d-contact/cxa-contracts';
import {
  runDeliveryPortConformanceSuite,
  type DeliveryConformanceHarness,
} from '@d-contact/cxa-contracts/testing';
import { DeliveryTestAdapter } from './delivery-test-adapter.js';

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
const createdTenantIds: string[] = [];

after(async () => {
  for (const rawTenantId of createdTenantIds) {
    await owner.dvOutbox.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgTouch.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgAttempt.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgDecisionLog.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgReservation.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.cgConsent.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contactIdentity.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.contact.deleteMany({ where: { tenantId: rawTenantId } });
    await owner.tenant.deleteMany({ where: { id: rawTenantId } });
  }
  await Promise.all([owner.$disconnect(), application.$disconnect()]);
});

interface Harness extends Omit<DeliveryConformanceHarness, 'delivery'> {
  delivery: DeliveryTestAdapter;
  governance: ContactGovernanceService;
  rawTenantId: string;
  rawContactId: string;
  rawReservationId: string;
}

async function makeHarness(): Promise<Harness> {
  const rawTenantId = randomUUID();
  const rawContactId = randomUUID();
  const rawIdentityId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);
  const enrollmentActionKey = `enrollment-c1-3:1:${suffix}`;
  createdTenantIds.push(rawTenantId);

  await owner.tenant.create({
    data: {
      id: rawTenantId,
      name: `Delivery test adapter ${suffix}`,
      slug: `dv-outbox-${suffix}`,
      sipDomain: `${suffix}.dv-outbox.test`,
    },
  });
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'Delivery contact' },
  });
  await owner.contactIdentity.create({
    data: {
      id: rawIdentityId,
      tenantId: rawTenantId,
      contactId: rawContactId,
      type: 'EMAIL',
      value: `dv-${suffix}@example.test`,
    },
  });
  await owner.cgConsent.create({
    data: {
      tenantId: rawTenantId,
      contactId: rawContactId,
      identityId: rawIdentityId,
      purpose: 'MARKETING',
      channel: 'EMAIL',
      status: 'GRANTED',
      lawfulBasis: 'CONSENT',
      evidence: { source: 'integration-test' },
      grantedAt: new Date('2026-09-01T00:00:00.000Z'),
      expiresAt: new Date('2026-12-01T00:00:00.000Z'),
    },
  });

  let now = new Date('2026-09-10T09:00:00.000Z');
  const governance = new ContactGovernanceService(application, { now: () => now });
  const authorization = await governance.authorizeAndReserve(rawTenantId, {
    contactId: rawContactId,
    identityId: rawIdentityId,
    channel: 'EMAIL',
    purpose: 'MARKETING',
    source: 'JOURNEY',
    sourceId: 'journey-c1-3',
    actionKey: enrollmentActionKey,
    policyVersion: 1,
  });
  assert.equal(authorization.decision, 'ALLOW');
  assert.ok(authorization.reservationId);
  const actualReservationId = authorization.reservationId as string;

  const delivery = new DeliveryTestAdapter(application, governance);
  const command: EnqueueDeliveryCommand = {
    tenantId: tenantId(rawTenantId),
    source: 'JOURNEY',
    actionKey: actionKey(enrollmentActionKey),
    reservationId: reservationId(actualReservationId),
    channel: 'EMAIL',
    contactId: contactId(rawContactId),
    identityId: identityId(rawIdentityId),
    contentRef: 'template-c1-3',
    correlationId: 'correlation-c1-3',
    purpose: 'MARKETING',
    senderIdentityId: 'sender-c1-3',
    leaseExpiresAt: new Date(now.getTime() + 5 * 60_000).toISOString(),
  };

  return {
    delivery,
    governance,
    command,
    rawTenantId,
    rawContactId,
    rawReservationId: actualReservationId,
    unknownReservationId: reservationId(randomUUID()),
    mismatchedActionKey: actionKey('mismatched-action-key'),
    otherTenantId: tenantId(randomUUID()),
    advance: (ms: number) => {
      now = new Date(now.getTime() + ms);
    },
  };
}

runDeliveryPortConformanceSuite('DurableDeliveryTestAdapter', makeHarness);

test('adapterProfile ยืนยัน TEST_ADAPTER และ outbox row ไม่มี raw PII', async () => {
  const { delivery, command, rawTenantId } = await makeHarness();
  assert.equal(delivery.adapterProfile, 'TEST_ADAPTER');
  const queued = await delivery.enqueue(command);
  assert.equal(queued.status, 'QUEUED');

  const row = await owner.dvOutbox.findFirstOrThrow({ where: { tenantId: rawTenantId } });
  const serialized = JSON.stringify(row);
  assert.equal(serialized.includes('@example.test'), false);
  assert.equal(serialized.includes('sender-c1-3'), true);
  assert.equal(row.contentRef, 'template-c1-3');
});

test('submit persists submission barrier ก่อน แล้ว reportOutcome DELIVERED settle ผ่าน confirm', async () => {
  const { delivery, command, rawTenantId } = await makeHarness();
  const queued = await delivery.enqueue(command);
  assert.equal(queued.status, 'QUEUED');
  const { deliveryId } = queued as { deliveryId: import('@d-contact/cxa-contracts').DeliveryId };

  const submitted = await delivery.submit({
    tenantId: command.tenantId,
    deliveryId,
    correlationId: 'correlation-submit',
  });
  assert.equal(submitted.status, 'UNKNOWN_RECONCILING');
  assert.equal(
    (await owner.dvOutbox.findFirstOrThrow({ where: { tenantId: rawTenantId, deliveryId } })).state,
    'SUBMITTING',
  );

  const settled = await delivery.reportOutcome({
    tenantId: command.tenantId,
    deliveryId,
    outcome: 'DELIVERED',
    providerCallbackId: 'callback-1',
    occurredAt: '2026-09-10T09:01:00.000Z',
    correlationId: 'correlation-outcome',
  });
  assert.equal(settled.status, 'SETTLED');
  assert.equal(settled.state, 'CONFIRMED');
  const row = await owner.dvOutbox.findFirstOrThrow({
    where: { tenantId: rawTenantId, deliveryId },
  });
  assert.equal(row.state, 'SETTLED');
  assert.ok(row.outcomeRef);
});

test('reportOutcome ด้วย providerCallbackId ซ้ำไม่ settle ซ้ำ (idempotent)', async () => {
  const { delivery, command, rawTenantId } = await makeHarness();
  const queued = await delivery.enqueue(command);
  const { deliveryId } = queued as { deliveryId: import('@d-contact/cxa-contracts').DeliveryId };
  await delivery.submit({ tenantId: command.tenantId, deliveryId, correlationId: 'c1' });

  const outcomes = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      delivery.reportOutcome({
        tenantId: command.tenantId,
        deliveryId,
        outcome: 'DELIVERED',
        providerCallbackId: 'callback-dup',
        occurredAt: '2026-09-10T09:01:00.000Z',
        correlationId: `correlation-outcome-${index}`,
      }),
    ),
  );
  for (const outcome of outcomes) assert.deepEqual(outcome, outcomes[0]);
  assert.equal(await owner.cgAttempt.count({ where: { tenantId: rawTenantId } }), 1);
  assert.equal(await owner.cgTouch.count({ where: { tenantId: rawTenantId } }), 1);
});

test('out-of-order DELIVERY_FAILED หลัง DELIVERED terminal แล้วไม่ย้อน state', async () => {
  const { delivery, command, rawTenantId } = await makeHarness();
  const queued = await delivery.enqueue(command);
  const { deliveryId } = queued as { deliveryId: import('@d-contact/cxa-contracts').DeliveryId };
  await delivery.submit({ tenantId: command.tenantId, deliveryId, correlationId: 'c1' });

  const delivered = await delivery.reportOutcome({
    tenantId: command.tenantId,
    deliveryId,
    outcome: 'DELIVERED',
    providerCallbackId: 'callback-final',
    occurredAt: '2026-09-10T09:01:00.000Z',
    correlationId: 'c2',
  });
  assert.equal(delivered.status, 'SETTLED');

  const lateFailure = await delivery.reportOutcome({
    tenantId: command.tenantId,
    deliveryId,
    outcome: 'DELIVERY_FAILED',
    providerCallbackId: 'callback-late',
    occurredAt: '2026-09-10T09:02:00.000Z',
    correlationId: 'c3',
  });
  assert.deepEqual(lateFailure, delivered);
  assert.equal(await owner.cgAttempt.count({ where: { tenantId: rawTenantId } }), 1);
});

test('cancel ก่อน submit ปล่อย reservation ผ่าน deliveryId ที่ adapter mint ให้', async () => {
  const { delivery, governance, command } = await makeHarness();
  const queued = await delivery.enqueue(command);
  assert.equal(queued.status, 'QUEUED');
  const { deliveryId } = queued as { deliveryId: import('@d-contact/cxa-contracts').DeliveryId };

  const released = await governance.releaseBeforeSubmit({
    tenantId: command.tenantId,
    correlationId: 'correlation-cancel',
    reservationId: command.reservationId,
    actionKey: command.actionKey,
    deliveryId,
    reason: 'CANCELLED_BEFORE_SUBMIT',
  });
  assert.equal(released.state, 'RELEASED');
});
