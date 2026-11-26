import type { DcProducer, KafkaEventEnvelopeV2 } from '@d-contact/kafka';
import { KAFKA_TOPICS, type InboundBusinessEvent } from '@d-contact/shared';
import type { JourneyEventPublisher } from './event-inbox.js';

export function createJourneyKafkaPublisher(producer: DcProducer): JourneyEventPublisher {
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
        // receiptId exists before the contact is resolved, so it is safe to use as the ingress ordering key.
        orderingKey: receiptId,
        aggregateType: 'journey_event_receipt',
        aggregateId: receiptId,
        aggregateVersion: 0,
        payload: { event },
      };
      await producer.send(KAFKA_TOPICS.JOURNEY_EVENTS, envelope);
    },
  };
}
