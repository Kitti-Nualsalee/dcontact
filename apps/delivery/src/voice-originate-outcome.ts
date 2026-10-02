/** Durable outcome path ของ E1.18: Telephony ส่ง fact ที่ normalize แล้วเท่านั้น. */
import type { PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactGovernancePort,
} from '@d-contact/cxa-contracts';
import {
  VoiceOriginateRepository,
  type VoiceOriginateDelivery,
} from './voice-originate-repository.js';

export interface VoiceOriginateOutcomeInput {
  tenantId: string;
  deliveryId: string;
  correlationId: string;
  outcomeRef: string;
  occurredAt: string;
  outcome: 'PROVIDER_ACCEPTED' | 'DELIVERED' | 'DELIVERY_FAILED';
}

export type VoiceOriginateOutcomeResult = 'APPLIED' | 'REPLAY' | 'NOT_FOUND' | 'INVALID_STATE';

export class VoiceOriginateOutcomeProcessor {
  private readonly repository: VoiceOriginateRepository;

  constructor(
    database: PrismaClient,
    private readonly governance: ContactGovernancePort,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.repository = new VoiceOriginateRepository(database);
  }

  async record(input: VoiceOriginateOutcomeInput): Promise<VoiceOriginateOutcomeResult> {
    const delivery = await this.repository.findByDeliveryId(input.tenantId, input.deliveryId);
    if (!delivery) return 'NOT_FOUND';
    if (delivery.outbox.state === 'SETTLED') return 'REPLAY';
    if (delivery.outbox.state === 'QUEUED') return 'INVALID_STATE';

    if (input.outcome === 'PROVIDER_ACCEPTED') return this.accept(delivery, input);
    await this.governance.settleDelivery({
      ...this.binding(delivery, input.correlationId),
      providerRequestKey: toProviderRequestKey(delivery.outbox.providerRequestKey),
      outcomeRef: toOutcomeRef(input.outcomeRef),
      outcome: input.outcome,
      occurredAt: input.occurredAt,
    });
    await this.repository.settle(delivery, {
      outcome: input.outcome,
      outcomeRef: input.outcomeRef,
      settledAt: this.now(),
    });
    return 'APPLIED';
  }

  private async accept(
    delivery: VoiceOriginateDelivery,
    input: VoiceOriginateOutcomeInput,
  ): Promise<VoiceOriginateOutcomeResult> {
    await this.governance.confirmProviderAcceptance({
      ...this.binding(delivery, input.correlationId),
      providerRequestKey: toProviderRequestKey(delivery.outbox.providerRequestKey),
    });
    const accepted = await this.repository.advanceOutbox(
      delivery.outbox.tenantId,
      delivery.outbox.deliveryId,
      ['SUBMITTING'],
      { state: 'SUBMITTED' },
    );
    return accepted ? 'APPLIED' : 'REPLAY';
  }

  private binding(delivery: VoiceOriginateDelivery, correlationId: string) {
    return {
      tenantId: toTenantId(delivery.outbox.tenantId),
      correlationId,
      reservationId: toReservationId(delivery.outbox.reservationId),
      actionKey: toActionKey(delivery.outbox.actionKey),
      deliveryId: toDeliveryId(delivery.outbox.deliveryId),
    };
  }
}
