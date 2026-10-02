/**
 * Owner: Channels/Dialer — durable enqueue ของ server originate (E1.18 #520).
 *
 * Provider I/O อยู่คนละ slice: class นี้ claim reservation แล้ว commit interaction,
 * generic outbox และ voice extension ให้ครบก่อนตอบ QUEUED เท่านั้น.
 */
import { createHash, randomUUID } from 'node:crypto';
import { type Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  actionKey as toActionKey,
  contactId as toContactId,
  deliveryId as toDeliveryId,
  identityId as toIdentityId,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactGovernancePort,
  ReservationBindingError,
} from '@d-contact/cxa-contracts';
import { canonicalInputHash, mintOpaqueKey } from './evidence.js';
import { OutboxEntryAlreadyExistsError, type CreateOutboxEntryInput } from './outbox-repository.js';
import { VoiceOriginateRepository } from './voice-originate-repository.js';
import type { VoiceRolloutAuthority } from './voice-rollout-control.js';

export interface VoiceOriginateEnqueueInput {
  tenantId: string;
  userId: string;
  leaseId: string;
  actionKey: string;
  reservationId: string;
  contactId: string;
  identityId: string;
  correlationId: string;
}

export type VoiceOriginateEnqueueResult =
  | { status: 'QUEUED'; deliveryId: string }
  | { status: 'UNAVAILABLE'; reasonCode: string; reservationReleased?: true };

export interface VoiceOriginateEnqueuerOptions {
  /** kill switch ของ queue; default-off จนกว่าจะมี rollout control plane ที่อนุมัติแล้ว */
  enabled?: boolean;
  now?: () => Date;
  id?: () => string;
  rollout?: VoiceRolloutAuthority;
}

interface AgentAssignment {
  extension: string;
  telephonyNodeId: string;
  expiresAt: Date;
}

const LEASE_WINDOW_MS = 60_000;

export class VoiceOriginateEnqueuer {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly enabled: boolean;
  private readonly repository: VoiceOriginateRepository;
  private readonly rollout?: VoiceRolloutAuthority;

  constructor(
    private readonly database: PrismaClient,
    private readonly governance: ContactGovernancePort,
    options: VoiceOriginateEnqueuerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.enabled = options.enabled ?? false;
    this.repository = new VoiceOriginateRepository(database, this.id);
    this.rollout = options.rollout;
  }

  async enqueue(input: VoiceOriginateEnqueueInput): Promise<VoiceOriginateEnqueueResult> {
    if (!this.enabled) return unavailable('OUTBOUND_VOICE_DISABLED');
    const inputHash = canonicalInputHash({
      tenantId: input.tenantId,
      userId: input.userId,
      leaseId: input.leaseId,
      actionKey: input.actionKey,
      reservationId: input.reservationId,
      contactId: input.contactId,
      identityId: input.identityId,
    });
    const existing = await this.repository.findByActionKey(input.tenantId, input.actionKey);
    if (existing)
      return this.replay(existing.adapter, existing.inputHash, inputHash, existing.deliveryId);

    const assignment = await this.assignment(input);
    if (!assignment) return unavailable('VOICE_AGENT_UNAVAILABLE');
    if (!this.rollout) return unavailable('VOICE_ROLLOUT_NOT_CONFIGURED');
    const rollout = await this.rollout.evaluate({
      tenantId: input.tenantId,
      telephonyNodeId: assignment.telephonyNodeId,
      agentUserId: input.userId,
      targetIdentityId: input.identityId,
      at: this.now(),
    });
    if (rollout.status === 'DENIED') return unavailable(rollout.reasonCode);

    const deliveryId = mintOpaqueKey('delivery', input.tenantId, input.actionKey, inputHash);
    const providerRequestKey = mintOpaqueKey(
      'provider-request',
      input.tenantId,
      input.actionKey,
      inputHash,
    );
    const leaseExpiresAt = new Date(
      Math.min(assignment.expiresAt.getTime(), this.now().getTime() + LEASE_WINDOW_MS),
    );
    let leaseVersion: number;
    try {
      const claimed = await this.governance.claimReservationForDelivery({
        tenantId: toTenantId(input.tenantId),
        correlationId: input.correlationId,
        reservationId: toReservationId(input.reservationId),
        actionKey: toActionKey(input.actionKey),
        deliveryId: toDeliveryId(deliveryId),
        contactId: toContactId(input.contactId),
        identityId: toIdentityId(input.identityId),
        channel: 'VOICE',
        purpose: 'SERVICE',
        senderIdentityId: senderIdentity(input.userId),
        leaseExpiresAt: leaseExpiresAt.toISOString(),
      });
      leaseVersion = claimed.leaseVersion ?? 1;
    } catch (error) {
      if (error instanceof ReservationBindingError)
        return unavailable('VOICE_RESERVATION_UNAVAILABLE');
      throw error;
    }

    const interactionId = opaqueUuid('interaction', inputHash);
    const outbox: CreateOutboxEntryInput = {
      id: this.id(),
      tenantId: input.tenantId,
      actionKey: input.actionKey,
      reservationId: input.reservationId,
      deliveryId,
      providerRequestKey,
      channel: 'VOICE',
      contactId: input.contactId,
      identityId: input.identityId,
      purpose: 'SERVICE',
      source: 'DPHONE_CLICK_TO_CALL',
      senderIdentityId: senderIdentity(input.userId),
      contentRef: `voice-target:${input.identityId}`,
      inputHash,
      leaseVersion,
      leaseExpiresAt,
      correlationId: input.correlationId,
    };

    try {
      await this.repository.createWith(
        {
          outbox,
          interactionId,
          workSessionLeaseId: input.leaseId,
          agentUserId: input.userId,
          agentExtension: assignment.extension,
          telephonyNodeId: assignment.telephonyNodeId,
          targetIdentityId: input.identityId,
          originationUuid: opaqueUuid('origination', inputHash),
        },
        async (transaction) => {
          const current = await this.assignment(input, transaction);
          if (
            !current ||
            current.extension !== assignment.extension ||
            current.telephonyNodeId !== assignment.telephonyNodeId
          ) {
            throw new VoiceAgentUnavailableError();
          }
          await transaction.interaction.create({
            data: {
              id: interactionId,
              tenantId: input.tenantId,
              channel: 'VOICE',
              direction: 'OUTBOUND',
              state: 'ASSIGNED',
              agentId: input.userId,
              contactId: input.contactId,
              externalId: opaqueUuid('origination', inputHash),
              assignedAt: this.now(),
              metadata: {
                source: 'DPHONE_CLICK_TO_CALL',
                deliveryId,
                telephonyNodeId: assignment.telephonyNodeId,
              },
            },
          });
          await transaction.interactionEvent.createMany({
            data: [
              {
                tenantId: input.tenantId,
                interactionId,
                type: 'interaction.created',
                payload: {},
              },
              {
                tenantId: input.tenantId,
                interactionId,
                type: 'interaction.assigned',
                payload: {},
              },
            ],
          });
        },
      );
    } catch (error) {
      if (error instanceof OutboxEntryAlreadyExistsError) {
        const concurrent = await this.repository.findByActionKey(input.tenantId, input.actionKey);
        if (concurrent)
          return this.replay(
            concurrent.adapter,
            concurrent.inputHash,
            inputHash,
            concurrent.deliveryId,
          );
      }
      const released = await this.release(input, deliveryId);
      return released
        ? {
            status: 'UNAVAILABLE',
            reasonCode: 'VOICE_DELIVERY_UNAVAILABLE',
            reservationReleased: true,
          }
        : unavailable('VOICE_DELIVERY_UNAVAILABLE');
    }

    return { status: 'QUEUED', deliveryId };
  }

  private replay(
    adapter: string,
    storedHash: string,
    inputHash: string,
    deliveryId: string,
  ): VoiceOriginateEnqueueResult {
    if (adapter !== 'FREESWITCH_ORIGINATE' || storedHash !== inputHash) {
      return unavailable('VOICE_DELIVERY_CONFLICT');
    }
    return { status: 'QUEUED', deliveryId };
  }

  private assignment(input: VoiceOriginateEnqueueInput): Promise<AgentAssignment | null>;
  private assignment(
    input: VoiceOriginateEnqueueInput,
    transaction: Prisma.TransactionClient,
  ): Promise<AgentAssignment | null>;
  private assignment(
    input: VoiceOriginateEnqueueInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<AgentAssignment | null> {
    if (transaction) return this.findAssignment(transaction, input);
    return withTenantDatabaseTransaction(this.database, input.tenantId, (current) =>
      this.findAssignment(current, input),
    );
  }

  private async findAssignment(
    transaction: Prisma.TransactionClient,
    input: VoiceOriginateEnqueueInput,
  ): Promise<AgentAssignment | null> {
    const lease = await transaction.agentWorkSessionLease.findFirst({
      where: {
        id: input.leaseId,
        tenantId: toTenantId(input.tenantId),
        userId: input.userId,
        releasedAt: null,
        expiresAt: { gt: this.now() },
        user: { role: 'AGENT', isActive: true },
      },
      select: {
        expiresAt: true,
        sipCredential: {
          select: {
            tenantId: true,
            userId: true,
            extension: true,
            telephonyNodeId: true,
            revokedAt: true,
          },
        },
      },
    });
    const credential = lease?.sipCredential;
    if (
      !lease ||
      !credential ||
      credential.revokedAt ||
      credential.tenantId !== input.tenantId ||
      credential.userId !== input.userId
    ) {
      return null;
    }
    return {
      extension: credential.extension,
      telephonyNodeId: credential.telephonyNodeId,
      expiresAt: lease.expiresAt,
    };
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

class VoiceAgentUnavailableError extends Error {}

function unavailable(reasonCode: string): VoiceOriginateEnqueueResult {
  return { status: 'UNAVAILABLE', reasonCode };
}

function senderIdentity(userId: string): string {
  return `voice-agent:${userId}`;
}

function opaqueUuid(kind: string, inputHash: string): string {
  const digest = createHash('sha256').update(`${kind}|${inputHash}`).digest('hex');
  const bytes = Buffer.from(digest.slice(0, 32), 'hex');
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const uuid = bytes.toString('hex');
  return `${uuid.slice(0, 8)}-${uuid.slice(8, 12)}-${uuid.slice(12, 16)}-${uuid.slice(16, 20)}-${uuid.slice(20)}`;
}
