/**
 * Fixture ที่ใช้ร่วมกันระหว่าง integration test ของ C1.3 กับ conformance suite ของ #67
 *
 * เป็น test support ล้วน ๆ: production path ไม่มีอะไร import ไฟล์นี้ และมันเป็นที่เดียว
 * ที่ประกอบ `ContactGovernanceService` ตัวจริงเข้ากับ `DeliveryTestAdapter`
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@d-contact/db';
import {
  actionKey,
  contactId,
  identityId,
  reservationId,
  tenantId,
  type EnqueueDeliveryCommand,
} from '@d-contact/cxa-contracts';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import { DeliveryTestAdapter } from './delivery-test-adapter.js';
import { ScriptedTestTransport, type TransportResponse } from './test-transport.js';

export const RESERVED_AT = '2026-09-10T09:00:00.000Z';
/** ตรงกับ RESERVATION_TTL_MS 15 นาทีของ Governance เพื่อให้ conformance advance แล้วหมดอายุจริง */
export const RESERVATION_EXPIRY = '2026-09-10T09:15:00.000Z';
export const LEASE_EXPIRY = '2026-09-10T09:10:00.000Z';

const APPLICATION_DATABASE_URL =
  process.env.APPLICATION_DATABASE_URL ??
  'postgresql://dcontact_app:dcontact_app@localhost:5433/dcontact?schema=public';

export type DeliveryFixture = Awaited<ReturnType<typeof createDeliveryFixture>>;

export async function createDeliveryFixture(script: TransportResponse[] = []) {
  const owner = new PrismaClient();
  const application = new PrismaClient({ datasources: { db: { url: APPLICATION_DATABASE_URL } } });
  const rawTenantId = randomUUID();
  const otherRawTenantId = randomUUID();
  const rawContactId = randomUUID();
  const rawIdentityId = randomUUID();
  const suffix = rawTenantId.slice(0, 8);
  let currentTime = new Date(RESERVED_AT);

  for (const [index, scope] of [rawTenantId, otherRawTenantId].entries()) {
    await owner.tenant.create({
      data: {
        id: scope,
        name: `Delivery ${suffix}-${index}`,
        slug: `delivery-${suffix}-${index}`,
        sipDomain: `${suffix}-${index}.delivery.test`,
      },
    });
  }
  await owner.contact.create({
    data: { id: rawContactId, tenantId: rawTenantId, displayName: 'Delivery contact' },
  });
  await owner.contactIdentity.create({
    data: {
      id: rawIdentityId,
      tenantId: rawTenantId,
      contactId: rawContactId,
      type: 'EMAIL',
      value: `delivery-${suffix}@example.test`,
    },
  });

  async function createReservation(label: string) {
    const rawId = randomUUID();
    const rawActionKey = `action-${suffix}-${label}`;
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
        actionKey: rawActionKey,
        inputHash: `hash-${suffix}-${label}`,
        expiresAt: new Date(RESERVATION_EXPIRY),
        settlementStatus: 'UNCLAIMED',
      },
    });
    return { rawId, rawActionKey };
  }

  const primary = await createReservation('primary');
  const transport = new ScriptedTestTransport(script);
  const governance = new ContactGovernanceService(application, { now: () => currentTime });
  const delivery = new DeliveryTestAdapter(application, governance, {
    now: () => currentTime,
    transport,
  });

  const command: EnqueueDeliveryCommand = {
    tenantId: tenantId(rawTenantId),
    source: 'JOURNEY',
    actionKey: actionKey(primary.rawActionKey),
    reservationId: reservationId(primary.rawId),
    channel: 'EMAIL',
    contactId: contactId(rawContactId),
    identityId: identityId(rawIdentityId),
    contentRef: 'template:welcome/v3',
    correlationId: `corr-${suffix}`,
    purpose: 'MARKETING',
    senderIdentityId: `sender-${suffix}`,
    leaseExpiresAt: LEASE_EXPIRY,
  };

  return {
    owner,
    application,
    governance,
    delivery,
    transport,
    command,
    rawTenantId,
    otherTenantId: tenantId(otherRawTenantId),
    createReservation,
    advance(ms: number) {
      currentTime = new Date(currentTime.getTime() + ms);
    },
    outboxRow(deliveryId: string) {
      return owner.dlOutboxEntry.findFirst({ where: { tenantId: rawTenantId, deliveryId } });
    },
    outboxCount() {
      return owner.dlOutboxEntry.count({ where: { tenantId: rawTenantId } });
    },
    reservationRow(id: string) {
      return owner.cgReservation.findFirst({ where: { id, tenantId: rawTenantId } });
    },
    attemptCount() {
      return owner.cgAttempt.count({ where: { tenantId: rawTenantId } });
    },
    touchCount() {
      return owner.cgTouch.count({ where: { tenantId: rawTenantId } });
    },
    async dispose() {
      for (const scope of [rawTenantId, otherRawTenantId]) {
        await owner.dlOutboxEntry.deleteMany({ where: { tenantId: scope } });
        await owner.cgReservationCommandReceipt.deleteMany({ where: { tenantId: scope } });
        await owner.cgTouch.deleteMany({ where: { tenantId: scope } });
        await owner.cgAttempt.deleteMany({ where: { tenantId: scope } });
        await owner.cgReservation.deleteMany({ where: { tenantId: scope } });
        await owner.contactIdentity.deleteMany({ where: { tenantId: scope } });
        await owner.contact.deleteMany({ where: { tenantId: scope } });
        await owner.tenant.deleteMany({ where: { id: scope } });
      }
      await Promise.all([owner.$disconnect(), application.$disconnect()]);
    },
  };
}
