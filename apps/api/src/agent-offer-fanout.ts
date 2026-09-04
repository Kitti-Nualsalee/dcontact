import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { WorkspaceRoutingEvent } from '@d-contact/workspace-session';

export interface RoutingEventDelivery {
  deliverRoutingEvent(event: WorkspaceRoutingEvent): Promise<number>;
}

interface RoutingOfferPayload extends Record<string, unknown> {
  interactionId: string;
  userId: string;
  tenantId?: string;
}

export async function fanoutAgentOffer(
  delivery: RoutingEventDelivery,
  event: KafkaEventEnvelope<RoutingOfferPayload>,
): Promise<number> {
  if (event.type !== 'routing.offered') throw new Error('agent event is not routing.offered');
  if (event.payload.tenantId && event.payload.tenantId !== event.tenantId) {
    throw new Error('routing offer tenantId does not match envelope');
  }
  if (!event.payload.interactionId || !event.payload.userId) {
    throw new Error('routing offer requires interactionId and userId');
  }
  return delivery.deliverRoutingEvent({
    type: 'routing.offered',
    tenantId: event.tenantId,
    interactionId: event.payload.interactionId,
    userId: event.payload.userId,
  });
}
