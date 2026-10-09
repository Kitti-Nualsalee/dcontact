import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  VoiceOriginateOutcomeProcessor,
  VoiceTelephonyOutcomeHandler,
  type VoiceOutcomeRecorder,
} from '@d-contact/delivery';
import { ContactGovernanceService } from '@d-contact/contact-governance';
import type { KafkaEventEnvelope } from '@d-contact/kafka';
import type { TelephonyCallEvent } from '@d-contact/shared';

export class E1VoiceOutcomes {
  private readonly processor: VoiceOutcomeRecorder;
  private readonly handler: VoiceTelephonyOutcomeHandler;

  constructor(
    private readonly database: PrismaClient,
    private readonly tenantId: string,
    private readonly nodeId: string,
    recorder?: VoiceOutcomeRecorder,
  ) {
    this.processor =
      recorder ??
      new VoiceOriginateOutcomeProcessor(database, new ContactGovernanceService(database));
    this.handler = new VoiceTelephonyOutcomeHandler(this.processor);
  }

  binding(callUuid: string) {
    return withTenantDatabaseTransaction(this.database, this.tenantId, async (transaction) => {
      const voice = await transaction.dlVoiceOriginate.findFirst({
        where: {
          tenantId: this.tenantId,
          originationUuid: callUuid,
          telephonyNodeId: this.nodeId,
        },
      });
      if (!voice) return null;
      const [outbox, claim] = await Promise.all([
        transaction.dlOutboxEntry.findFirst({
          where: {
            tenantId: this.tenantId,
            deliveryId: voice.deliveryId,
            adapter: 'FREESWITCH_ORIGINATE',
            state: { not: 'QUEUED' },
          },
        }),
        transaction.dlVoiceAuditEvent.findFirst({
          where: {
            tenantId: this.tenantId,
            eventId: `e1-sandbox:call.originate:${voice.deliveryId}`,
            code: 'E1_SANDBOX_COMMAND_CLAIMED',
          },
        }),
      ]);
      return outbox && claim
        ? {
            tenantId: this.tenantId,
            deliveryId: voice.deliveryId,
            providerRequestKey: outbox.providerRequestKey,
          }
        : null;
    });
  }

  async handle(event: KafkaEventEnvelope<TelephonyCallEvent>) {
    const binding = await this.binding(event.payload.callUuid);
    if (
      !binding ||
      event.tenantId !== binding.tenantId ||
      event.payload.telephonyNodeId !== this.nodeId ||
      event.payload.deliveryId !== binding.deliveryId ||
      event.payload.providerRequestKey !== binding.providerRequestKey
    )
      return 'IGNORED';
    return this.handler.handle(event);
  }

  async backgroundFailure(jobUuid: string, callUuid: string) {
    const binding = await this.binding(callUuid);
    if (!binding) return 'IGNORED';
    const result = await this.processor.record({
      ...binding,
      correlationId: callUuid,
      outcomeRef: `esl-job:${jobUuid}`,
      occurredAt: new Date().toISOString(),
      outcome: 'DELIVERY_FAILED',
    });
    if (result === 'APPLIED' || result === 'REPLAY') {
      await withTenantDatabaseTransaction(this.database, this.tenantId, async (transaction) => {
        const interaction = await transaction.interaction.findFirst({
          where: {
            tenantId: this.tenantId,
            externalId: callUuid,
            channel: 'VOICE',
            direction: 'OUTBOUND',
            state: 'ASSIGNED',
          },
          select: { id: true },
        });
        if (!interaction) return;
        const abandoned = await transaction.interaction.updateMany({
          where: { tenantId: this.tenantId, id: interaction.id, state: 'ASSIGNED' },
          data: {
            state: 'ABANDONED',
            endedAt: new Date(),
            offerExpiresAt: null,
            requeueAt: null,
          },
        });
        if (abandoned.count === 0) return;
        await transaction.interactionEvent.create({
          data: {
            tenantId: this.tenantId,
            interactionId: interaction.id,
            type: 'interaction.abandoned',
            payload: { reason: 'provider_originate_failed', deliveryId: binding.deliveryId },
          },
        });
      });
    }
    return result;
  }
}
