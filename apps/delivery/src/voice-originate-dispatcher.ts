/**
 * Owner: Channels/Dialer — durable submission boundary of the server originate (E1.18 #520).
 *
 * The dispatcher does not touch Kafka or ESL directly: the injected port is the transport boundary
 * so that `beginProviderSubmission` and the outbox `SUBMITTING` always happen before publish.
 */
import type { PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactGovernancePort,
  ReservationBindingError,
} from '@d-contact/cxa-contracts';
import {
  VoiceOriginateRepository,
  type VoiceOriginateDelivery,
} from './voice-originate-repository.js';
import type { VoiceRolloutAuthority } from './voice-rollout-control.js';

/** Matches `TelephonyOriginateCommand`; Delivery has no runtime dependency on Kafka/Telephony. */
export interface VoiceOriginateCommand extends Record<string, unknown> {
  type: 'call.originate';
  vendor: 'freeswitch';
  telephonyNodeId: string;
  deliveryId: string;
  providerRequestKey: string;
  originationUuid: string;
  agentExtension: string;
  targetIdentityId: string;
}

export interface VoiceCancelCommand extends Record<string, unknown> {
  type: 'call.cancel';
  vendor: 'freeswitch';
  telephonyNodeId: string;
  callUuid: string;
  deliveryId: string;
  providerRequestKey: string;
}

export interface VoiceOriginateCommandPublisher {
  publish(input: {
    tenantId: string;
    command: VoiceOriginateCommand | VoiceCancelCommand;
  }): Promise<void>;
}

export interface VoiceOriginateDispatchInput {
  tenantId: string;
  deliveryId: string;
  correlationId: string;
}

export type VoiceOriginateDispatchResult =
  | { status: 'PUBLISHED' }
  | { status: 'RECONCILE_REQUIRED' }
  | { status: 'BLOCKED'; reasonCode: string }
  | { status: 'NOT_FOUND' };

export interface VoiceOriginateDispatcherOptions {
  /** default-off: a rollout control plane is needed before sending real commands is enabled */
  enabled?: boolean;
  now?: () => Date;
  rollout?: VoiceRolloutAuthority;
}

export class VoiceOriginateDispatcher {
  private readonly repository: VoiceOriginateRepository;
  private readonly enabled: boolean;
  private readonly now: () => Date;
  private readonly rollout?: VoiceRolloutAuthority;

  constructor(
    database: PrismaClient,
    private readonly governance: ContactGovernancePort,
    private readonly publisher: VoiceOriginateCommandPublisher,
    options: VoiceOriginateDispatcherOptions = {},
  ) {
    this.repository = new VoiceOriginateRepository(database);
    this.enabled = options.enabled ?? false;
    this.now = options.now ?? (() => new Date());
    this.rollout = options.rollout;
  }

  async dispatch(input: VoiceOriginateDispatchInput): Promise<VoiceOriginateDispatchResult> {
    if (!this.enabled) return { status: 'BLOCKED', reasonCode: 'OUTBOUND_VOICE_DISABLED' };
    const delivery = await this.repository.findByDeliveryId(input.tenantId, input.deliveryId);
    if (!delivery) return { status: 'NOT_FOUND' };
    if (delivery.outbox.state === 'SUBMITTING' || delivery.outbox.state === 'RECONCILING') {
      return { status: 'RECONCILE_REQUIRED' };
    }
    if (delivery.outbox.state !== 'QUEUED')
      return { status: 'BLOCKED', reasonCode: 'VOICE_DELIVERY_FINAL' };
    if (!this.rollout) return { status: 'BLOCKED', reasonCode: 'VOICE_ROLLOUT_NOT_CONFIGURED' };
    const rollout = await this.rollout.authorize({
      tenantId: input.tenantId,
      telephonyNodeId: delivery.voice.telephonyNodeId,
      deliveryId: delivery.outbox.deliveryId,
      agentUserId: delivery.voice.agentUserId,
      targetIdentityId: delivery.voice.targetIdentityId,
      at: this.now(),
    });
    if (rollout.status === 'DENIED') {
      return { status: 'BLOCKED', reasonCode: rollout.reasonCode };
    }

    try {
      await this.governance.beginProviderSubmission({
        tenantId: toTenantId(delivery.outbox.tenantId),
        correlationId: input.correlationId,
        reservationId: toReservationId(delivery.outbox.reservationId),
        actionKey: toActionKey(delivery.outbox.actionKey),
        deliveryId: toDeliveryId(delivery.outbox.deliveryId),
        expectedLeaseVersion: delivery.outbox.leaseVersion,
        providerRequestKey: toProviderRequestKey(delivery.outbox.providerRequestKey),
      });
    } catch (error) {
      if (!(error instanceof ReservationBindingError)) throw error;
      if (error.code === 'DELIVERY_RECONCILIATION_REQUIRED') {
        await this.reconcile(delivery, input.correlationId);
        return { status: 'RECONCILE_REQUIRED' };
      }
      return { status: 'BLOCKED', reasonCode: error.code };
    }

    const submitting = await this.repository.advanceOutbox(
      input.tenantId,
      input.deliveryId,
      ['QUEUED'],
      { state: 'SUBMITTING', submittedAt: this.now() },
    );
    if (!submitting) return { status: 'RECONCILE_REQUIRED' };

    try {
      await this.publisher.publish({
        tenantId: input.tenantId,
        command: {
          type: 'call.originate',
          vendor: 'freeswitch',
          telephonyNodeId: delivery.voice.telephonyNodeId,
          deliveryId: submitting.deliveryId,
          providerRequestKey: submitting.providerRequestKey,
          originationUuid: delivery.voice.originationUuid,
          agentExtension: delivery.voice.agentExtension,
          targetIdentityId: delivery.voice.targetIdentityId,
        },
      });
      return { status: 'PUBLISHED' };
    } catch {
      await this.reconcile(delivery, input.correlationId);
      return { status: 'RECONCILE_REQUIRED' };
    }
  }

  private async reconcile(delivery: VoiceOriginateDelivery, correlationId: string): Promise<void> {
    await this.governance.settleDelivery({
      tenantId: toTenantId(delivery.outbox.tenantId),
      correlationId,
      reservationId: toReservationId(delivery.outbox.reservationId),
      actionKey: toActionKey(delivery.outbox.actionKey),
      deliveryId: toDeliveryId(delivery.outbox.deliveryId),
      providerRequestKey: toProviderRequestKey(delivery.outbox.providerRequestKey),
      outcomeRef: toOutcomeRef(`reconcile-${delivery.outbox.providerRequestKey}`),
      outcome: 'UNKNOWN_RECONCILING',
      occurredAt: (delivery.outbox.submittedAt ?? delivery.outbox.leaseExpiresAt).toISOString(),
    });
    await this.repository.markReconciling(delivery.outbox.tenantId, delivery.outbox.deliveryId);
  }
}
