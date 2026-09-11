import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import { createJourneyFoundationPorts } from '@d-contact/journey-composition';
import { createProducer } from '@d-contact/kafka';
import type { InboundBusinessEvent } from '@d-contact/shared';
import { EventInboxService } from './event-inbox.js';
import { createJourneyEventConsumer } from './journey-event-consumer.js';
import { createJourneyKafkaPublisher } from './journey-kafka-publisher.js';
import { JourneyProcessor } from './journey-processor.js';

async function eventually(check: () => Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('ไม่พบ Journey action จาก runtime consumer ภายในเวลาที่กำหนด');
}

test(
  'runtime consumer รับ event จาก Redpanda และสร้าง durable action ผ่าน Contact Governance หนึ่งครั้ง',
  { timeout: 30_000 },
  async (t) => {
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
    const identityId = randomUUID();
    const receiptId = randomUUID();
    const suffix = randomUUID();
    await owner.tenant.create({
      data: {
        id: tenantId,
        name: `Journey runtime ${tenantId}`,
        slug: `journey-runtime-${tenantId}`,
        sipDomain: `${tenantId}.journey-runtime.test`,
      },
    });
    await owner.contact.create({
      data: {
        id: contactId,
        tenantId,
        identities: {
          create: {
            id: identityId,
            tenantId,
            type: 'EMAIL',
            value: 'runtime@example.test',
          },
        },
        cgConsents: {
          create: {
            identityId,
            purpose: 'MARKETING',
            channel: 'EMAIL',
            status: 'GRANTED',
            lawfulBasis: 'CONSENT',
            evidence: { source: 'journey-runtime-integration' },
          },
        },
      },
    });

    const processor = new JourneyProcessor(application, createJourneyFoundationPorts(application));
    const consumer = await createJourneyEventConsumer({
      database: application,
      processor,
      clientId: `journey-runtime-${suffix}`,
      groupId: `journey-runtime-${suffix}`,
      brokers: ['localhost:9092'],
      definition: {
        journeyVersion: 1,
        stepId: 'notify-payment-failed',
        channel: 'EMAIL',
        purpose: 'MARKETING',
        policyVersion: 1,
      },
    });
    const producer = await createProducer(`journey-runtime-producer-${suffix}`, {
      brokers: ['localhost:9092'],
    });
    t.after(async () => {
      await producer.disconnect();
      await consumer.disconnect();
      await owner.jrKafkaConsumerInbox.deleteMany({ where: { tenantId } });
      await owner.jrAction.deleteMany({ where: { tenantId } });
      await owner.jrEnrollment.deleteMany({ where: { tenantId } });
      await owner.cgReservation.updateMany({
        where: { tenantId },
        data: { authorizationDecisionId: null },
      });
      await owner.cgDecisionLog.deleteMany({ where: { tenantId } });
      await owner.cgReservation.deleteMany({ where: { tenantId } });
      await owner.cgConsent.deleteMany({ where: { tenantId } });
      await owner.jrEventInbox.deleteMany({ where: { tenantId } });
      await owner.contactIdentity.deleteMany({ where: { tenantId } });
      await owner.contact.deleteMany({ where: { tenantId } });
      await owner.tenant.deleteMany({ where: { id: tenantId } });
      await Promise.all([owner.$disconnect(), application.$disconnect()]);
    });

    const event: InboundBusinessEvent = {
      source: 'billing',
      eventId: 'runtime-payment-failed-001',
      type: 'payment.failed',
      occurredAt: '2026-09-08T04:00:00.000Z',
      schemaVersion: 1,
      contactRef: { kind: 'EMAIL', value: 'runtime@example.test' },
      payload: { invoiceId: 'runtime-invoice-001' },
    };
    const inbox = new EventInboxService(application, { id: () => receiptId });
    const publisher = createJourneyKafkaPublisher(producer);
    await inbox.accept(tenantId, event);
    await inbox.publishNext(tenantId, publisher);
    await publisher.publish({ tenantId, receiptId, event });

    await eventually(async () => (await owner.jrAction.count({ where: { tenantId } })) === 1);

    const action = await owner.jrAction.findFirstOrThrow({ where: { tenantId } });
    assert.equal(action.enrollmentId, receiptId);
    assert.equal(action.actionKey, `${receiptId}:1:notify-payment-failed`);
    assert.ok(action.decisionId);
    assert.ok(action.reservationId);
    assert.equal(await owner.jrEnrollment.count({ where: { tenantId } }), 1);
    assert.equal(await owner.cgDecisionLog.count({ where: { tenantId } }), 1);
    assert.equal(await owner.cgReservation.count({ where: { tenantId } }), 1);
    assert.equal(
      (await owner.jrEventInbox.findUniqueOrThrow({ where: { id: receiptId } })).state,
      'PROCESSED',
    );
  },
);
