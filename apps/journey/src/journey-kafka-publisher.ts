import type { DcProducer, KafkaEventEnvelope } from '@d-contact/kafka';
import { KAFKA_TOPICS, type InboundBusinessEvent } from '@d-contact/shared';
import type { JourneyEventPublisher } from './event-inbox.js';

export function createJourneyKafkaPublisher(producer: DcProducer): JourneyEventPublisher {
  return {
    async publish({ tenantId, receiptId, event }) {
      const envelope: KafkaEventEnvelope<{ event: InboundBusinessEvent }> = {
        eventId: receiptId,
        type: 'journey.business_event.received',
        tenantId,
        occurredAt: event.occurredAt,
        correlationId: receiptId,
        orderingKey: `${event.contactRef.kind}:${event.contactRef.value}`,
        payload: { event },
      };
      await producer.send(KAFKA_TOPICS.JOURNEY_EVENTS, envelope);
    },
  };
}
