import type { PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  reservationId as toReservationId,
  tenantId as toTenantId,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  type ContactGovernancePort,
} from '@d-contact/cxa-contracts';
import {
  VoiceOriginateDispatcher,
  type VoiceOriginateDispatcherOptions,
  type VoiceOriginateCommandPublisher,
} from './voice-originate-dispatcher.js';
import {
  VoiceOriginateEnqueuer,
  type VoiceOriginateEnqueueInput,
  type VoiceOriginateEnqueuerOptions,
} from './voice-originate-enqueue.js';
import { VoiceOriginateRepository } from './voice-originate-repository.js';

export type VoiceDeliveryResult =
  | { status: 'QUEUED' }
  | {
      status: 'UNAVAILABLE';
      reasonCode: string;
      reservationReleased?: true;
      reservationFinalized?: true;
    };

export interface VoiceCancellationInput {
  tenantId: string;
  userId: string;
  leaseId: string;
  actionKey: string;
  correlationId: string;
}

export type VoiceCancellationResult =
  | { status: 'CANCELLED' }
  | { status: 'RECONCILING' }
  | { status: 'FINAL' }
  | { status: 'NOT_FOUND' };

export class VoiceOriginateDeliveryService {
  private readonly enqueuer: VoiceOriginateEnqueuer;
  private readonly dispatcher: VoiceOriginateDispatcher;
  private readonly repository: VoiceOriginateRepository;
  private readonly now: () => Date;

  constructor(
    database: PrismaClient,
    private readonly governance: ContactGovernancePort,
    private readonly publisher: VoiceOriginateCommandPublisher,
    options: VoiceOriginateEnqueuerOptions & VoiceOriginateDispatcherOptions,
  ) {
    this.enqueuer = new VoiceOriginateEnqueuer(database, governance, options);
    this.dispatcher = new VoiceOriginateDispatcher(database, governance, publisher, options);
    this.repository = new VoiceOriginateRepository(database);
    this.now = options.now ?? (() => new Date());
  }

  async enqueue(input: VoiceOriginateEnqueueInput): Promise<VoiceDeliveryResult> {
    const queued = await this.enqueuer.enqueue(input);
    if (queued.status === 'UNAVAILABLE') return queued;
    const dispatched = await this.dispatcher.dispatch({
      tenantId: input.tenantId,
      deliveryId: queued.deliveryId,
      correlationId: input.correlationId,
    });
    if (dispatched.status === 'PUBLISHED') return { status: 'QUEUED' };
    if (dispatched.status === 'RECONCILE_REQUIRED') {
      return {
        status: 'UNAVAILABLE',
        reasonCode: 'VOICE_DELIVERY_RECONCILING',
        reservationFinalized: true,
      };
    }
    if (dispatched.status === 'BLOCKED') {
      const released = await this.release(input, queued.deliveryId);
      await this.repository.cancelBeforeSubmit(input.tenantId, queued.deliveryId);
      return released
        ? { status: 'UNAVAILABLE', reasonCode: dispatched.reasonCode, reservationReleased: true }
        : { status: 'UNAVAILABLE', reasonCode: dispatched.reasonCode };
    }
    return { status: 'UNAVAILABLE', reasonCode: 'VOICE_DELIVERY_NOT_FOUND' };
  }

  async cancel(input: VoiceCancellationInput): Promise<VoiceCancellationResult> {
    const delivery = await this.repository.findVoiceByActionKey(input.tenantId, input.actionKey);
    if (
      !delivery ||
      delivery.voice.agentUserId !== input.userId ||
      delivery.voice.workSessionLeaseId !== input.leaseId
    ) {
      return { status: 'NOT_FOUND' };
    }
    if (delivery.outbox.state === 'SETTLED' || delivery.voice.state === 'SETTLED') {
      return { status: 'FINAL' };
    }
    if (delivery.outbox.state === 'QUEUED') {
      const released = await this.release(
        {
          tenantId: input.tenantId,
          userId: input.userId,
          leaseId: input.leaseId,
          actionKey: input.actionKey,
          reservationId: delivery.outbox.reservationId,
          contactId: delivery.outbox.contactId,
          identityId: delivery.outbox.identityId!,
          correlationId: input.correlationId,
        },
        delivery.outbox.deliveryId,
      );
      if (!released) return { status: 'RECONCILING' };
      await this.repository.cancelBeforeSubmit(input.tenantId, delivery.outbox.deliveryId);
      return { status: 'CANCELLED' };
    }
    if (delivery.voice.state === 'CANCEL_REQUESTED') return { status: 'RECONCILING' };

    await this.governance.settleDelivery({
      tenantId: toTenantId(input.tenantId),
      correlationId: input.correlationId,
      reservationId: toReservationId(delivery.outbox.reservationId),
      actionKey: toActionKey(delivery.outbox.actionKey),
      deliveryId: toDeliveryId(delivery.outbox.deliveryId),
      providerRequestKey: toProviderRequestKey(delivery.outbox.providerRequestKey),
      outcomeRef: toOutcomeRef(`cancel-${delivery.outbox.providerRequestKey}`),
      outcome: 'UNKNOWN_RECONCILING',
      occurredAt: this.now().toISOString(),
    });
    await this.repository.requestCancelAfterSubmit(input.tenantId, delivery.outbox.deliveryId);
    try {
      await this.publisher.publish({
        tenantId: input.tenantId,
        command: {
          type: 'call.cancel',
          vendor: 'freeswitch',
          telephonyNodeId: delivery.voice.telephonyNodeId,
          callUuid: delivery.voice.originationUuid,
          deliveryId: delivery.outbox.deliveryId,
          providerRequestKey: delivery.outbox.providerRequestKey,
        },
      });
    } catch {
      // Durable CANCEL_REQUESTED/RECONCILING is the authority; monitoring handles a stuck cancel.
    }
    return { status: 'RECONCILING' };
  }

  private async release(input: VoiceOriginateEnqueueInput, deliveryId: string): Promise<boolean> {
    try {
      await this.governance.releaseBeforeSubmit({
        tenantId: toTenantId(input.tenantId),
        correlationId: input.correlationId,
        reservationId: toReservationId(input.reservationId),
        actionKey: toActionKey(input.actionKey),
        deliveryId: toDeliveryId(deliveryId),
        reason: 'CANCELLED_BEFORE_SUBMIT',
      });
      return true;
    } catch {
      return false;
    }
  }
}
