/**
 * Owner: Delivery/Channels — create a LINE delivery from a reservation Governance approved (S2.6b #403)
 *
 * Authority: #357 §2 (providerRequestKey), #362 §4 (UUID key persisted before answering QUEUED), #57 (binding)
 *
 * - `providerRequestKey` is a hexadecimal UUID created once and persisted with the outbox row;
 *   replaying the same `actionKey` always returns the same delivery/key, never minting a new one (#357)
 * - binds to the reservation only through `claimReservationForDelivery` of Governance — Delivery
 *   never reads/writes `cg_*` itself
 * - content must be an approved S2 fixture (closed set) — free text is rejected at enqueue
 * - enqueue touches no network and does not cross the barrier; the real send is in `LineOutboundAdapter.submit`
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@d-contact/db';
import {
  ReservationBindingError,
  deliveryId as toDeliveryId,
  type ActionKey,
  type ContactGovernancePort,
  type ContactId,
  type IdentityId,
  type ReservationId,
  type TenantId,
} from '@d-contact/cxa-contracts';
import { isLineFixtureRef } from './line-push-request.js';
import { OutboxEntryAlreadyExistsError, OutboxRepository } from './outbox-repository.js';

export interface EnqueueLineDeliveryCommand {
  tenantId: TenantId;
  correlationId: string;
  causationId?: string;
  reservationId: ReservationId;
  actionKey: ActionKey;
  contactId: ContactId;
  identityId?: IdentityId;
  purpose: string;
  source: string;
  senderIdentityId: string;
  contentRef: string;
  leaseExpiresAt: string;
}

export type EnqueueLineDeliveryResult =
  | { status: 'QUEUED' | 'REPLAYED'; deliveryId: string; providerRequestKey: string }
  | {
      status: 'ERROR';
      code: 'CONTENT_NOT_APPROVED' | 'IDEMPOTENCY_CONFLICT' | ReservationBindingError['code'];
    };

export interface LineDeliveryEnqueueOptions {
  id?: () => string;
  /** Injectable to make tests deterministic; production uses `randomUUID` (lowercase hex UUID) */
  requestKey?: () => string;
  /** #567: accepted contentRef — unspecified = only the closed S2 fixture set */
  approvedContent?: (contentRef: string) => boolean;
}

/** The business identity of the command — correlation/causation are traces so they are not in the hash */
function lineInputHash(command: EnqueueLineDeliveryCommand): string {
  const canonical = [
    command.tenantId,
    command.reservationId,
    command.actionKey,
    command.contactId,
    command.identityId ?? '',
    command.purpose,
    command.source,
    command.senderIdentityId,
    command.contentRef,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function lineDeliveryId(tenantId: string, actionKey: string, inputHash: string): string {
  const digest = createHash('sha256')
    .update(`line-delivery|${tenantId}|${actionKey}|${inputHash}`)
    .digest('hex');
  return `dlv_line_${digest.slice(0, 32)}`;
}

export class LineDeliveryEnqueue {
  private readonly outbox: OutboxRepository;
  private readonly id: () => string;
  private readonly requestKey: () => string;
  private readonly approvedContent: ((contentRef: string) => boolean) | undefined;

  constructor(
    database: PrismaClient,
    private readonly governance: Pick<ContactGovernancePort, 'claimReservationForDelivery'>,
    options: LineDeliveryEnqueueOptions = {},
  ) {
    this.outbox = new OutboxRepository(database, 'LINE_MESSAGING_API');
    this.id = options.id ?? randomUUID;
    this.requestKey = options.requestKey ?? randomUUID;
    this.approvedContent = options.approvedContent;
  }

  async enqueue(command: EnqueueLineDeliveryCommand): Promise<EnqueueLineDeliveryResult> {
    if (!(this.approvedContent ?? isLineFixtureRef)(command.contentRef)) {
      return { status: 'ERROR', code: 'CONTENT_NOT_APPROVED' };
    }
    const inputHash = lineInputHash(command);
    const existing = await this.outbox.findByActionKey(command.tenantId, command.actionKey);
    if (existing) return this.replay(existing, inputHash);

    const deliveryId = lineDeliveryId(command.tenantId, command.actionKey, inputHash);
    let leaseVersion: number;
    try {
      const claimed = await this.governance.claimReservationForDelivery({
        tenantId: command.tenantId,
        correlationId: command.correlationId,
        reservationId: command.reservationId,
        actionKey: command.actionKey,
        deliveryId: toDeliveryId(deliveryId),
        contactId: command.contactId,
        ...(command.identityId ? { identityId: command.identityId } : {}),
        channel: 'LINE',
        purpose: command.purpose,
        senderIdentityId: command.senderIdentityId,
        leaseExpiresAt: command.leaseExpiresAt,
      });
      leaseVersion = claimed.leaseVersion ?? 1;
    } catch (error) {
      if (error instanceof ReservationBindingError) return { status: 'ERROR', code: error.code };
      throw error;
    }

    const providerRequestKey = this.requestKey();
    try {
      await this.outbox.create({
        id: this.id(),
        tenantId: command.tenantId,
        actionKey: command.actionKey,
        reservationId: command.reservationId,
        deliveryId,
        providerRequestKey,
        channel: 'LINE',
        contactId: command.contactId,
        ...(command.identityId ? { identityId: command.identityId } : {}),
        purpose: command.purpose,
        source: command.source,
        senderIdentityId: command.senderIdentityId,
        contentRef: command.contentRef,
        inputHash,
        leaseVersion,
        leaseExpiresAt: new Date(command.leaseExpiresAt),
        correlationId: command.correlationId,
        ...(command.causationId ? { causationId: command.causationId } : {}),
      });
    } catch (error) {
      if (!(error instanceof OutboxEntryAlreadyExistsError)) throw error;
      // The winner of a race on the same actionKey wrote first — return the winner's row, not our key
      const winner = await this.outbox.findByActionKey(command.tenantId, command.actionKey);
      return winner
        ? this.replay(winner, inputHash)
        : { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    }
    return { status: 'QUEUED', deliveryId, providerRequestKey };
  }

  private replay(
    existing: {
      adapter: string;
      inputHash: string;
      deliveryId: string;
      providerRequestKey: string;
    },
    inputHash: string,
  ): EnqueueLineDeliveryResult {
    if (existing.adapter !== 'LINE_MESSAGING_API' || existing.inputHash !== inputHash) {
      return { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    }
    return {
      status: 'REPLAYED',
      deliveryId: existing.deliveryId,
      providerRequestKey: existing.providerRequestKey,
    };
  }
}
