/**
 * Owner: Channels/Dialer — durable test adapter for DeliveryPort (C1.3)
 *
 * C1 scope: no provider credential, no network I/O and no real traffic.
 * The adapter owns a durable outbox of its own, while the reservation, Attempt and Touch remain
 * entirely Governance's — this code never writes that state itself and does not import
 * contact-governance directly; it only has the injected `ContactGovernancePort`.
 *
 * Order that must not be swapped:
 *   1. claim through Governance first, then persist the outbox before answering QUEUED
 *   2. beginProviderSubmission (durable barrier) always before touching the transport
 *   3. after the barrier never release/refund/blind retry — a timeout must go to reconcile
 */
import { randomUUID, createHash } from 'node:crypto';
import type { DlOutboxEntry, PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  tenantId as toTenantId,
  ReservationBindingError,
  type ContactGovernancePort,
  type DeliveryEnqueueErrorCode,
  type DeliveryPort,
  type EnqueueDeliveryCommand,
  type EnqueueDeliveryResult,
  type NormalizedDeliveryOutcome,
} from '@d-contact/cxa-contracts';
import {
  assertOpaqueContentRef,
  canonicalInputHash,
  deliveryEvidence,
  mintOpaqueKey,
  type DeliveryEvidence,
} from './evidence.js';
import {
  OutboxEntryAlreadyExistsError,
  OutboxRepository,
  type CreateOutboxEntryInput,
} from './outbox-repository.js';
import { TEST_ADAPTER, ScriptedTestTransport, type DeliveryTransport } from './test-transport.js';

/** Codes `enqueue` must never return — if one appears, Governance changed the contract and we must fail closed */
const ENQUEUE_FORBIDDEN_CODES = new Set([
  'STALE_RESERVATION_LEASE',
  'DELIVERY_RECONCILIATION_REQUIRED',
  'INVALID_RESERVATION_TRANSITION',
]);

export interface DeliveryTestAdapterOptions {
  now?: () => Date;
  id?: () => string;
  transport?: DeliveryTransport;
}

export interface DeliveryWorkItem {
  tenantId: string;
  deliveryId: string;
  correlationId: string;
}

export type DeliverySubmissionResult =
  | { status: 'SUBMITTED'; evidence: DeliveryEvidence }
  | { status: 'SETTLED'; evidence: DeliveryEvidence }
  | { status: 'RECONCILE_REQUIRED'; evidence: DeliveryEvidence }
  | { status: 'BLOCKED'; code: string; evidence: DeliveryEvidence };

export interface RecordOutcomeInput extends DeliveryWorkItem {
  outcome: Exclude<NormalizedDeliveryOutcome, 'UNKNOWN_RECONCILING'>;
  outcomeRef: string;
  occurredAt: string;
}

export class DeliveryNotFoundError extends Error {
  readonly code = 'DELIVERY_NOT_FOUND';

  constructor(readonly deliveryId: string) {
    super(`delivery ${deliveryId} not found in the outbox`);
    this.name = 'DeliveryNotFoundError';
  }
}

function outcomeRefFor(providerRequestKey: string, reason: string): string {
  const digest = createHash('sha256').update([providerRequestKey, reason].join('|')).digest('hex');
  return `ocr_${digest.slice(0, 32)}`;
}

export class DeliveryTestAdapter implements DeliveryPort {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly transport: DeliveryTransport;
  private readonly outbox: OutboxRepository;

  constructor(
    database: PrismaClient,
    private readonly governance: ContactGovernancePort,
    options: DeliveryTestAdapterOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.transport = options.transport ?? new ScriptedTestTransport();
    this.outbox = new OutboxRepository(database, TEST_ADAPTER);
  }

  /**
   * A committed duplicate replays the original delivery, while a duplicate still in flight at the same time
   * loses on the unique index and gets IDEMPOTENCY_CONFLICT per the #67 contract — a caller that retries
   * afterwards gets a normal replay
   */
  async enqueue(command: EnqueueDeliveryCommand): Promise<EnqueueDeliveryResult> {
    assertOpaqueContentRef(command.contentRef);
    const inputHash = canonicalInputHash({ ...command });

    const existing = await this.outbox.findByActionKey(command.tenantId, command.actionKey);
    if (existing) return this.replay(existing, inputHash);

    const mintedDeliveryId = mintOpaqueKey(
      'delivery',
      command.tenantId,
      command.actionKey,
      inputHash,
    );
    const mintedProviderRequestKey = mintOpaqueKey(
      'provider-request',
      command.tenantId,
      command.actionKey,
      inputHash,
    );

    let leaseVersion: number;
    try {
      const claimed = await this.governance.claimReservationForDelivery({
        tenantId: command.tenantId,
        correlationId: command.correlationId,
        reservationId: command.reservationId,
        actionKey: command.actionKey,
        deliveryId: toDeliveryId(mintedDeliveryId),
        contactId: command.contactId,
        ...(command.identityId ? { identityId: command.identityId } : {}),
        channel: command.channel,
        purpose: command.purpose,
        senderIdentityId: command.senderIdentityId,
        leaseExpiresAt: command.leaseExpiresAt,
      });
      leaseVersion = claimed.leaseVersion ?? 1;
    } catch (error) {
      if (!(error instanceof ReservationBindingError)) throw error;
      if (ENQUEUE_FORBIDDEN_CODES.has(error.code)) throw error;
      return { status: 'ERROR', code: error.code as DeliveryEnqueueErrorCode };
    }

    const entry: CreateOutboxEntryInput = {
      id: this.id(),
      tenantId: command.tenantId,
      actionKey: command.actionKey,
      reservationId: command.reservationId,
      deliveryId: mintedDeliveryId,
      providerRequestKey: mintedProviderRequestKey,
      channel: command.channel,
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
    };

    try {
      await this.outbox.create(entry);
    } catch (error) {
      if (!(error instanceof OutboxEntryAlreadyExistsError)) throw error;
      return { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    }

    return {
      status: 'QUEUED',
      deliveryId: toDeliveryId(mintedDeliveryId),
      providerRequestKey: toProviderRequestKey(mintedProviderRequestKey),
    };
  }

  private replay(entry: DlOutboxEntry, inputHash: string): EnqueueDeliveryResult {
    // An actionKey held by another adapter is not a replay of ours (mixed-version guard)
    if (entry.adapter !== TEST_ADAPTER || entry.inputHash !== inputHash) {
      return { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    }
    return {
      status: 'QUEUED',
      deliveryId: toDeliveryId(entry.deliveryId),
      providerRequestKey: toProviderRequestKey(entry.providerRequestKey),
    };
  }

  private async require(tenantId: string, deliveryId: string): Promise<DlOutboxEntry> {
    const entry = await this.outbox.findByDeliveryId(tenantId, deliveryId);
    if (!entry) throw new DeliveryNotFoundError(deliveryId);
    return entry;
  }

  private governanceCommand(entry: DlOutboxEntry, correlationId: string) {
    return {
      tenantId: toTenantId(entry.tenantId),
      correlationId,
      reservationId: toReservationId(entry.reservationId),
      actionKey: toActionKey(entry.actionKey),
      deliveryId: toDeliveryId(entry.deliveryId),
    };
  }

  /**
   * The only step that may touch the transport. A row in SUBMITTING has already passed the barrier
   * and may have been sent — it must never be sent again, only reconciled
   */
  async submit(work: DeliveryWorkItem): Promise<DeliverySubmissionResult> {
    const entry = await this.require(work.tenantId, work.deliveryId);
    if (entry.state === 'SUBMITTED')
      return { status: 'SUBMITTED', evidence: deliveryEvidence(entry) };
    if (entry.state === 'SETTLED') return { status: 'SETTLED', evidence: deliveryEvidence(entry) };
    if (entry.state === 'SUBMITTING' || entry.state === 'RECONCILING') {
      return { status: 'RECONCILE_REQUIRED', evidence: deliveryEvidence(entry) };
    }

    try {
      await this.governance.beginProviderSubmission({
        ...this.governanceCommand(entry, work.correlationId),
        expectedLeaseVersion: entry.leaseVersion,
        providerRequestKey: toProviderRequestKey(entry.providerRequestKey),
      });
    } catch (error) {
      if (!(error instanceof ReservationBindingError)) throw error;
      if (error.code === 'DELIVERY_RECONCILIATION_REQUIRED') {
        const reconciling = await this.markReconciling(entry, work.correlationId);
        return { status: 'RECONCILE_REQUIRED', evidence: deliveryEvidence(reconciling) };
      }
      return { status: 'BLOCKED', code: error.code, evidence: deliveryEvidence(entry) };
    }

    // Barrier passed: record before touching the transport so that a crash mid-send still reads back that
    // this job "may have been sent" instead of looking like a job that has not started
    const submitting = await this.outbox.advance(entry.tenantId, entry.deliveryId, ['QUEUED'], {
      state: 'SUBMITTING',
      submittedAt: this.now(),
    });
    if (!submitting) {
      const current = await this.require(work.tenantId, work.deliveryId);
      return { status: 'RECONCILE_REQUIRED', evidence: deliveryEvidence(current) };
    }

    const response = await this.transport.submit({
      adapter: TEST_ADAPTER,
      deliveryId: submitting.deliveryId,
      providerRequestKey: submitting.providerRequestKey,
      channel: submitting.channel,
      contentRef: submitting.contentRef,
    });

    if (response.status === 'ACCEPTED') {
      await this.governance.confirmProviderAcceptance({
        ...this.governanceCommand(submitting, work.correlationId),
        providerRequestKey: toProviderRequestKey(submitting.providerRequestKey),
      });
      const accepted = await this.outbox.advance(
        submitting.tenantId,
        submitting.deliveryId,
        ['SUBMITTING'],
        { state: 'SUBMITTED' },
      );
      return {
        status: 'SUBMITTED',
        evidence: deliveryEvidence(accepted ?? submitting),
      };
    }

    if (response.status === 'REJECTED') {
      const settled = await this.settle(submitting, work.correlationId, {
        outcome: 'PROVIDER_REJECTED',
        outcomeRef: outcomeRefFor(submitting.providerRequestKey, response.reasonCode),
        occurredAt: this.now().toISOString(),
      });
      return { status: 'SETTLED', evidence: deliveryEvidence(settled) };
    }

    const reconciling = await this.markReconciling(submitting, work.correlationId);
    return { status: 'RECONCILE_REQUIRED', evidence: deliveryEvidence(reconciling) };
  }

  /**
   * Normalized result from the provider, one per outcomeRef; the first terminal outcome
   * wins, and a later one returns the original snapshot without settling again or creating extra Attempt/Touch
   */
  async recordOutcome(input: RecordOutcomeInput): Promise<DeliveryEvidence> {
    const entry = await this.require(input.tenantId, input.deliveryId);
    if (entry.state === 'SETTLED') return deliveryEvidence(entry);
    if (entry.state === 'QUEUED') {
      throw new ReservationBindingError('INVALID_RESERVATION_TRANSITION');
    }
    const settled = await this.settle(entry, input.correlationId, {
      outcome: input.outcome,
      outcomeRef: input.outcomeRef,
      occurredAt: input.occurredAt,
    });
    return deliveryEvidence(settled);
  }

  private async settle(
    entry: DlOutboxEntry,
    correlationId: string,
    outcome: {
      outcome: Exclude<NormalizedDeliveryOutcome, 'UNKNOWN_RECONCILING'>;
      outcomeRef: string;
      occurredAt: string;
    },
  ): Promise<DlOutboxEntry> {
    await this.governance.settleDelivery({
      ...this.governanceCommand(entry, correlationId),
      providerRequestKey: toProviderRequestKey(entry.providerRequestKey),
      outcomeRef: toOutcomeRef(outcome.outcomeRef),
      outcome: outcome.outcome,
      occurredAt: outcome.occurredAt,
    });
    const settled = await this.outbox.advance(
      entry.tenantId,
      entry.deliveryId,
      ['SUBMITTING', 'SUBMITTED', 'RECONCILING'],
      {
        state: 'SETTLED',
        outcome: outcome.outcome,
        outcomeRef: outcome.outcomeRef,
        settledAt: this.now(),
      },
    );
    return settled ?? this.require(entry.tenantId, entry.deliveryId);
  }

  private async markReconciling(
    entry: DlOutboxEntry,
    correlationId: string,
  ): Promise<DlOutboxEntry> {
    // The outcomeRef and occurredAt of reconcile must stay constant per delivery: the sweeper can run any
    // number of times and it is still a replay of the same settle, not a new one with mismatched input
    await this.governance.settleDelivery({
      ...this.governanceCommand(entry, correlationId),
      providerRequestKey: toProviderRequestKey(entry.providerRequestKey),
      outcomeRef: toOutcomeRef(outcomeRefFor(entry.providerRequestKey, 'reconcile')),
      outcome: 'UNKNOWN_RECONCILING',
      occurredAt: (entry.submittedAt ?? entry.leaseExpiresAt).toISOString(),
    });
    const reconciling = await this.outbox.advance(
      entry.tenantId,
      entry.deliveryId,
      ['QUEUED', 'SUBMITTING', 'SUBMITTED'],
      { state: 'RECONCILING' },
    );
    return reconciling ?? this.require(entry.tenantId, entry.deliveryId);
  }

  /**
   * A job that passed the barrier but whose lease expired without a result — reports UNKNOWN_RECONCILING
   * to Governance; must not release, refund or resend
   */
  async reconcileExpired(tenantId: string, correlationId: string): Promise<DeliveryEvidence[]> {
    const stale = await this.outbox.findReconcilable(tenantId, this.now());
    const evidence: DeliveryEvidence[] = [];
    for (const entry of stale) {
      evidence.push(deliveryEvidence(await this.markReconciling(entry, correlationId)));
    }
    return evidence;
  }

  /** View for test/evidence — never returns contentRef or bindings, which are the PII boundary */
  async evidenceFor(tenantId: string, deliveryId: string): Promise<DeliveryEvidence> {
    return deliveryEvidence(await this.require(tenantId, deliveryId));
  }
}
