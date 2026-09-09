import assert from 'node:assert/strict';
import test from 'node:test';
import type { DcProducer, KafkaEventEnvelope, KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import { KAFKA_TOPICS, type KafkaTopic } from '@d-contact/shared';
import { createJourneyKafkaPublisher } from './journey-kafka-publisher.js';

test('Journey producer ส่ง V2 ingress และไม่เผย contact reference ใน ordering key', async () => {
  let sent: { topic: KafkaTopic; event: KafkaEventEnvelope } | undefined;
  const producer: DcProducer = {
    async send(topic, event) {
      sent = { topic, event };
    },
    async disconnect() {},
  };
  const publisher = createJourneyKafkaPublisher(producer, {
    orderingKeySecret: 'journey-kafka-unit-secret',
  });
  const contactRef = { kind: 'EMAIL' as const, value: 'customer@example.test' };

  await publisher.publish({
    tenantId: 'tenant-a',
    receiptId: 'receipt-a',
    event: {
      source: 'billing',
      eventId: 'invoice-a',
      type: 'invoice.due',
      occurredAt: '2026-09-09T00:00:00.000Z',
      schemaVersion: 1,
      contactRef,
      payload: {},
    },
  });

  assert.ok(sent);
  assert.equal(sent.topic, KAFKA_TOPICS.JOURNEY_EVENTS);
  const event = sent.event as KafkaEventEnvelopeV2<{ event: { contactRef: typeof contactRef } }>;
  assert.equal(event.schemaVersion, 2);
  assert.equal(event.eventKind, 'INGRESS');
  assert.equal(event.aggregateType, 'journey_event_receipt');
  assert.equal(event.aggregateId, 'receipt-a');
  assert.equal(event.aggregateVersion, 0);
  assert.match(event.orderingKey, /^journey-contact:[A-Za-z0-9_-]+$/);
  assert.ok(!event.orderingKey.includes(contactRef.value));
});
