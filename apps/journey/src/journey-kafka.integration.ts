import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { PrismaClient } from '@d-contact/db';
import {
  createConsumer,
  createInMemoryIdempotencyStore,
  createProducer,
  type KafkaEventEnvelopeV2,
} from '@d-contact/kafka';
import { KAFKA_TOPICS, type InboundBusinessEvent } from '@d-contact/shared';
import { EventInboxService } from './event-inbox.js';
import {
  createJourneyContactOrderingKey,
  createJourneyKafkaPublisher,
} from './journey-kafka-publisher.js';

test('durable Journey inbox ส่ง event ที่รับแล้วผ่าน Redpanda', { timeout: 30_000 }, async (t) => {
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
  const receiptId = randomUUID();
  const suffix = randomUUID();
  const received: KafkaEventEnvelopeV2[] = [];
  let resolveReceived!: () => void;
  const eventObserved = new Promise<void>((resolve) => {
    resolveReceived = resolve;
  });

  await owner.tenant.create({
    data: {
      id: tenantId,
      name: `Journey Kafka ${tenantId}`,
      slug: `journey-kafka-${tenantId}`,
      sipDomain: `${tenantId}.journey-kafka.test`,
    },
  });
  const consumer = await createConsumer({
    clientId: `journey-${suffix}-consumer`,
    groupId: `journey-${suffix}`,
    topics: [KAFKA_TOPICS.JOURNEY_EVENTS],
    brokers: ['localhost:9092'],
    idempotency: createInMemoryIdempotencyStore(),
    handler: (message) => {
      if (message.event.eventId !== receiptId) return;
      received.push(message.event as KafkaEventEnvelopeV2);
      resolveReceived();
    },
  });
  const producer = await createProducer(`journey-${suffix}-producer`, {
    brokers: ['localhost:9092'],
  });
  t.after(async () => {
    await producer.disconnect();
    await consumer.disconnect();
    await owner.jrEventInbox.deleteMany({ where: { tenantId } });
    await owner.tenant.deleteMany({ where: { id: tenantId } });
    await Promise.all([owner.$disconnect(), application.$disconnect()]);
  });

  const service = new EventInboxService(application, {
    now: () => new Date('2026-09-07T12:00:00.000Z'),
    id: () => receiptId,
  });
  const event: InboundBusinessEvent = {
    source: 'billing',
    eventId: 'invoice-due-001',
    type: 'invoice.due',
    occurredAt: '2026-09-07T11:59:00.000Z',
    schemaVersion: 1,
    contactRef: { kind: 'EMAIL', value: 'customer@example.test' },
    payload: { invoiceId: 'invoice-001' },
  };
  await service.accept(tenantId, event);
  const orderingKeySecret = 'journey-kafka-integration-secret';
  const result = await service.publishNext(
    tenantId,
    createJourneyKafkaPublisher(producer, { orderingKeySecret }),
  );

  let timeout: NodeJS.Timeout | undefined;
  await Promise.race([
    eventObserved,
    new Promise<never>((_, reject) => {
      timeout = setTimeout(
        () => reject(new Error('ไม่พบ Journey event จาก Redpanda ภายในเวลา')),
        10_000,
      );
    }),
  ]);
  if (timeout) clearTimeout(timeout);

  assert.equal(result?.state, 'PUBLISHED');
  assert.deepEqual(received, [
    {
      schemaVersion: 2,
      eventKind: 'INGRESS',
      eventId: receiptId,
      type: 'journey.business_event.received',
      tenantId,
      occurredAt: event.occurredAt,
      correlationId: receiptId,
      orderingKey: createJourneyContactOrderingKey(tenantId, event.contactRef, orderingKeySecret),
      aggregateType: 'journey_event_receipt',
      aggregateId: receiptId,
      aggregateVersion: 0,
      payload: { event },
    },
  ]);
});
