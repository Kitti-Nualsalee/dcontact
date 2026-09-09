import { createHmac } from 'node:crypto';
import type { DcProducer, KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import { KAFKA_TOPICS, type InboundBusinessEvent } from '@d-contact/shared';
import type { JourneyEventPublisher } from './event-inbox.js';

export interface JourneyKafkaPublisherOptions {
  /** HMAC ป้องกัน contact reference หลุดไปอยู่ใน Kafka key/header. */
  orderingKeySecret?: string;
}

function resolveOrderingKeySecret(options: JourneyKafkaPublisherOptions): string {
  const secret = options.orderingKeySecret ?? process.env.KAFKA_ORDERING_KEY_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') {
    throw new Error('production ต้องกำหนด KAFKA_ORDERING_KEY_SECRET');
  }
  return 'dcontact-local-journey-ordering-key';
}

export function createJourneyContactOrderingKey(
  tenantId: string,
  contactRef: InboundBusinessEvent['contactRef'],
  secret: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`${tenantId}\u0000${contactRef.kind}\u0000${contactRef.value}`)
    .digest('base64url');
  return `journey-contact:${digest}`;
}

export function createJourneyKafkaPublisher(
  producer: DcProducer,
  options: JourneyKafkaPublisherOptions = {},
): JourneyEventPublisher {
  const orderingKeySecret = resolveOrderingKeySecret(options);
  return {
    async publish({ tenantId, receiptId, event }) {
      const envelope: KafkaEventEnvelopeV2<{ event: InboundBusinessEvent }> = {
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
      };
      await producer.send(KAFKA_TOPICS.JOURNEY_EVENTS, envelope);
    },
  };
}
