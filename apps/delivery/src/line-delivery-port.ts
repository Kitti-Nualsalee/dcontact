/**
 * Owner: Delivery/Channels — LINE in-memory `DeliveryPort` simulation (S1.6, decision #100/#102)
 *
 * No LINE account, credential, SDK, HTTP/webhook, DNS/socket or any provider I/O
 * Everything is an in-memory state machine driven only by `ManualClock` and explicit control
 * (`claim`/`submit`/`scheduleCallback`/`runNext`/`deliverCallback`)
 *
 * Order that must not be swapped (same as C1.3):
 *   1. the rollout gate must be open (not DISABLED/KILLED) before ever touching Governance
 *   2. claim through Governance first, then persist the store before answering QUEUED
 *   3. beginProviderSubmission (barrier) always before touching the "transport" (callback queue)
 *   4. after the barrier never release/resend — timeout/cancel must go only to reconcile
 *
 * Every method takes `deliveryId`/`tenantId` and then "loads" all other values from the store itself —
 * a caller has no way to pass in a reservationId/providerRequestKey/senderIdentityId that does not match the binding
 * to impersonate, so every governance call always carries the record's original binding
 */
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
import { assertOpaqueContentRef, canonicalInputHash } from './evidence.js';
import { LineCapExceededError, type LineCapsTracker } from './line-caps-tracker.js';
import type { LineCg3FactsRegistry } from './line-cg3-facts.js';
import { mintLineId } from './line-id-factory.js';
import type { ManualClock } from './line-manual-clock.js';
import {
  type LineCallbackEnvelope,
  type LineCallbackOutcome,
  type LineDeliveryRecord,
  type LineDeliveryState,
  type LineSimulationStore,
} from './line-delivery-store.js';
import {
  LINE_CHANNEL,
  LINE_CONTACT_KIND,
  isAllowlistedScope,
  scopeKey,
  type LineScopeTuple,
} from './line-simulation-fixture.js';
import { LineRolloutGate } from './line-rollout-gate.js';

export class LineDeliveryNotFoundError extends Error {
  readonly code = 'LINE_DELIVERY_NOT_FOUND';
  constructor(readonly deliveryId: string) {
    super(`LINE simulated delivery not found: ${deliveryId}`);
    this.name = 'LineDeliveryNotFoundError';
  }
}

/**
 * This S1 simulation has no real provider so it never emits `PROVIDER_ACCEPTED` (#361) — that outcome
 * belongs to the real LINE adapter in S2.4 (#370), which writes `dl_provider_submission_attempts` itself
 */
type LineSimulationSettleOutcome = Exclude<NormalizedDeliveryOutcome, 'PROVIDER_ACCEPTED'>;

export class LineInvalidTransitionError extends Error {
  readonly code = 'LINE_INVALID_TRANSITION';
  constructor(
    readonly from: LineDeliveryState,
    readonly attempted: string,
  ) {
    super(`unsupported transition from ${from} with ${attempted}`);
    this.name = 'LineInvalidTransitionError';
  }
}

const TERMINAL_STATES: ReadonlySet<LineDeliveryState> = new Set([
  'SETTLED',
  'CANCELLED',
  'RELEASED',
]);

export interface LineDeliveryEvidence {
  tenantId: string;
  deliveryId: string;
  providerRequestKey: string;
  reservationId: string;
  actionKey: string;
  channel: 'LINE';
  state: LineDeliveryState;
  outcome: string | null;
  outcomeRef: string | null;
  dryRun: boolean;
  createdAt: string;
  claimedAt: string | null;
  submittedAt: string | null;
  settledAt: string | null;
  correlationId: string;
}

function evidenceFromRecord(record: LineDeliveryRecord): LineDeliveryEvidence {
  return {
    tenantId: record.tenantId,
    deliveryId: record.deliveryId,
    providerRequestKey: record.providerRequestKey,
    reservationId: record.reservationId,
    actionKey: record.actionKey,
    channel: 'LINE',
    state: record.state,
    outcome: record.outcome ?? null,
    outcomeRef: record.outcomeRef ?? null,
    dryRun: record.dryRun,
    createdAt: new Date(record.createdAtMs).toISOString(),
    claimedAt: record.claimedAtMs ? new Date(record.claimedAtMs).toISOString() : null,
    submittedAt: record.submittedAtMs ? new Date(record.submittedAtMs).toISOString() : null,
    settledAt: record.settledAtMs ? new Date(record.settledAtMs).toISOString() : null,
    correlationId: record.correlationId,
  };
}

export type LineSubmitResult =
  | { status: 'AWAITING_CALLBACK'; evidence: LineDeliveryEvidence }
  | { status: 'WOULD_SUBMIT'; evidence: LineDeliveryEvidence }
  | { status: 'BLOCKED'; code: string; evidence: LineDeliveryEvidence };

export interface LineDeliveryPortOptions {
  clock: ManualClock;
  governance: ContactGovernancePort;
  rolloutGate: LineRolloutGate;
  caps: LineCapsTracker;
  store: LineSimulationStore;
}

function canonical(value: object): string {
  return JSON.stringify(
    Object.entries(value)
      .filter(([key, v]) => key !== 'correlationId' && key !== 'causationId' && v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

/**
 * Owner: Delivery/Channels. Can be created as many instances as needed over the same `store`/`rolloutGate`/`caps`
 * to simulate a process restart — all state always lives outside this instance
 */
export class LineDeliveryPort implements DeliveryPort {
  private readonly clock: ManualClock;
  private readonly governance: ContactGovernancePort;
  private readonly rolloutGate: LineRolloutGate;
  private readonly caps: LineCapsTracker;
  private readonly store: LineSimulationStore;

  constructor(options: LineDeliveryPortOptions) {
    this.clock = options.clock;
    this.governance = options.governance;
    this.rolloutGate = options.rolloutGate;
    this.caps = options.caps;
    this.store = options.store;
  }

  private scopeOf(
    record: Pick<LineDeliveryRecord, 'tenantId' | 'senderIdentityId'>,
  ): LineScopeTuple {
    return {
      tenantId: record.tenantId,
      channel: LINE_CHANNEL,
      senderIdentityId: record.senderIdentityId,
    };
  }

  private require(tenantId: string, deliveryId: string): LineDeliveryRecord {
    const record = this.store.get(tenantId, deliveryId);
    if (!record) throw new LineDeliveryNotFoundError(deliveryId);
    return record;
  }

  private governanceCommand(record: LineDeliveryRecord, correlationId: string) {
    return {
      tenantId: toTenantId(record.tenantId),
      correlationId,
      reservationId: toReservationId(record.reservationId),
      actionKey: toActionKey(record.actionKey),
      deliveryId: toDeliveryId(record.deliveryId),
    };
  }

  async enqueue(command: EnqueueDeliveryCommand): Promise<EnqueueDeliveryResult> {
    if (command.channel !== LINE_CHANNEL) {
      throw new TypeError('LineDeliveryPort accepts only the LINE channel');
    }
    const scope: LineScopeTuple = {
      tenantId: command.tenantId,
      channel: LINE_CHANNEL,
      senderIdentityId: command.senderIdentityId,
    };

    const existing = this.store.findByActionKey(command.tenantId, command.actionKey);
    const inputHash = canonicalInputHash({ ...command });
    if (existing) {
      if (existing.inputHash !== inputHash)
        return { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
      return {
        status: 'QUEUED',
        deliveryId: toDeliveryId(existing.deliveryId),
        providerRequestKey: toProviderRequestKey(existing.providerRequestKey),
      };
    }

    const gateState = this.rolloutGate.currentState(scope);
    if (gateState === 'DISABLED' || gateState === 'KILLED') {
      // A scope outside the pilot tuple is always DISABLED — does not reveal whether a reservation really exists
      return { status: 'ERROR', code: 'RESERVATION_NOT_FOUND' };
    }

    assertOpaqueContentRef(command.contentRef);

    const mintedDeliveryId = mintLineId('delivery', command.tenantId, command.actionKey, inputHash);
    const mintedProviderRequestKey = mintLineId(
      'provider-request',
      command.tenantId,
      command.actionKey,
      inputHash,
    );

    let leaseVersion = 1;
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
      return { status: 'ERROR', code: error.code as DeliveryEnqueueErrorCode };
    }

    const record: LineDeliveryRecord = {
      tenantId: command.tenantId,
      deliveryId: mintedDeliveryId,
      providerRequestKey: mintedProviderRequestKey,
      actionKey: command.actionKey,
      reservationId: command.reservationId,
      contactId: command.contactId,
      ...(command.identityId ? { identityId: command.identityId } : {}),
      senderIdentityId: command.senderIdentityId,
      purpose: command.purpose,
      contactKind: LINE_CONTACT_KIND,
      contentRef: command.contentRef,
      correlationId: command.correlationId,
      ...(command.causationId ? { causationId: command.causationId } : {}),
      inputHash,
      leaseVersion,
      state: 'QUEUED',
      dryRun: gateState === 'DRY_RUN',
      createdAtMs: this.clock.nowMs(),
    };
    this.store.create(record);

    return {
      status: 'QUEUED',
      deliveryId: toDeliveryId(mintedDeliveryId),
      providerRequestKey: toProviderRequestKey(mintedProviderRequestKey),
    };
  }

  /** worker-level dequeue lock — does not touch Governance; a lease separate from the reservation lease */
  claim(tenantId: string, deliveryId: string): LineDeliveryEvidence {
    const record = this.require(tenantId, deliveryId);
    if (TERMINAL_STATES.has(record.state) || record.state === 'CLAIMED') {
      return evidenceFromRecord(record);
    }
    const scope = this.scopeOf(record);
    if (this.rolloutGate.currentState(scope) === 'KILLED') {
      return evidenceFromRecord(record);
    }
    if (record.state !== 'QUEUED') throw new LineInvalidTransitionError(record.state, 'claim');
    const updated = this.store.update(
      tenantId,
      deliveryId,
      { state: 'CLAIMED', claimedAtMs: this.clock.nowMs() },
      'CLAIMED',
      this.clock.nowMs(),
    );
    return evidenceFromRecord(updated);
  }

  /** pre-barrier: release; post-barrier: reconcile — no other way (see #102 §4) */
  async cancel(
    tenantId: string,
    deliveryId: string,
    correlationId: string,
  ): Promise<LineDeliveryEvidence> {
    const record = this.require(tenantId, deliveryId);
    if (TERMINAL_STATES.has(record.state) || record.state === 'UNKNOWN_RECONCILING') {
      return evidenceFromRecord(record);
    }
    if (record.state === 'QUEUED' || record.state === 'CLAIMED') {
      await this.governance.releaseBeforeSubmit({
        ...this.governanceCommand(record, correlationId),
        deliveryId: toDeliveryId(record.deliveryId),
        reason: 'CANCELLED_BEFORE_SUBMIT',
      });
      const updated = this.store.update(
        tenantId,
        deliveryId,
        { state: 'CANCELLED' },
        'CANCELLED',
        this.clock.nowMs(),
      );
      return evidenceFromRecord(updated);
    }
    return this.forceReconcile(record, correlationId, 'CANCEL_REQUESTED_AFTER_BARRIER');
  }

  private async forceReconcile(
    record: LineDeliveryRecord,
    correlationId: string,
    reasonSalt: string,
  ): Promise<LineDeliveryEvidence> {
    const outcomeRef = mintLineId('outcome', record.tenantId, record.actionKey, reasonSalt);
    await this.governance.settleDelivery({
      ...this.governanceCommand(record, correlationId),
      providerRequestKey: toProviderRequestKey(record.providerRequestKey),
      outcomeRef: toOutcomeRef(outcomeRef),
      outcome: 'UNKNOWN_RECONCILING',
      occurredAt: this.clock.nowIso(),
    });
    this.caps.enterUnknownReconciling(this.scopeOf(record), record.deliveryId, this.clock.nowMs());
    const updated = this.store.update(
      record.tenantId,
      record.deliveryId,
      { state: 'UNKNOWN_RECONCILING', reconcilingFromAccepted: record.state === 'ACCEPTED' },
      reasonSalt,
      this.clock.nowMs(),
    );
    return evidenceFromRecord(updated);
  }

  /** re-run CG3 for this delivery; restrictive mutation → cancel (release or reconcile depending on state) */
  async applyCg3Mutation(
    tenantId: string,
    deliveryId: string,
    correlationId: string,
    cg3: LineCg3FactsRegistry,
  ): Promise<LineDeliveryEvidence> {
    const record = this.require(tenantId, deliveryId);
    if (TERMINAL_STATES.has(record.state)) return evidenceFromRecord(record);
    const outcome = cg3.evaluate(tenantId, record.identityId, new Date(this.clock.nowMs()));
    const restrictive =
      outcome.decision === 'BLOCK' || outcome.decision === 'DEFER' || outcome.decision === 'REVIEW';
    if (!restrictive) return evidenceFromRecord(record);
    return this.cancel(tenantId, deliveryId, correlationId);
  }

  async submit(
    tenantId: string,
    deliveryId: string,
    correlationId: string,
  ): Promise<LineSubmitResult> {
    const record = this.require(tenantId, deliveryId);
    if (TERMINAL_STATES.has(record.state)) {
      return { status: 'BLOCKED', code: record.state, evidence: evidenceFromRecord(record) };
    }
    if (record.state === 'SUBMISSION_INTENT_RECORDED' || record.state === 'UNKNOWN_RECONCILING') {
      return { status: 'AWAITING_CALLBACK', evidence: evidenceFromRecord(record) };
    }
    if (record.state !== 'CLAIMED') {
      throw new LineInvalidTransitionError(record.state, 'submit');
    }

    const scope = this.scopeOf(record);
    const gateState = this.rolloutGate.currentState(scope);

    if (gateState === 'KILLED') {
      const cancelled = await this.cancel(tenantId, deliveryId, correlationId);
      return { status: 'BLOCKED', code: 'KILLED', evidence: cancelled };
    }

    if (gateState === 'DRY_RUN') {
      await this.governance.releaseBeforeSubmit({
        ...this.governanceCommand(record, correlationId),
        deliveryId: toDeliveryId(record.deliveryId),
        reason: 'CANCELLED_BEFORE_SUBMIT',
      });
      const updated = this.store.update(
        tenantId,
        deliveryId,
        { state: 'RELEASED', settledAtMs: this.clock.nowMs() },
        'DRY_RUN_WOULD_SUBMIT',
        this.clock.nowMs(),
      );
      return { status: 'WOULD_SUBMIT', evidence: evidenceFromRecord(updated) };
    }

    // gateState === 'SIMULATED_CAPPED_PILOT'
    try {
      this.caps.reserveSubmission(scope, record.contactId, this.clock.nowMs());
    } catch (error) {
      if (!(error instanceof LineCapExceededError)) throw error;
      return { status: 'BLOCKED', code: error.code, evidence: evidenceFromRecord(record) };
    }

    try {
      await this.governance.beginProviderSubmission({
        ...this.governanceCommand(record, correlationId),
        expectedLeaseVersion: record.leaseVersion,
        providerRequestKey: toProviderRequestKey(record.providerRequestKey),
      });
    } catch (error) {
      this.caps.releaseSubmission(scope);
      if (!(error instanceof ReservationBindingError)) throw error;
      return { status: 'BLOCKED', code: error.code, evidence: evidenceFromRecord(record) };
    }

    const updated = this.store.update(
      tenantId,
      deliveryId,
      { state: 'SUBMISSION_INTENT_RECORDED', submittedAtMs: this.clock.nowMs() },
      'SUBMISSION_INTENT_RECORDED',
      this.clock.nowMs(),
    );
    return { status: 'AWAITING_CALLBACK', evidence: evidenceFromRecord(updated) };
  }

  /** enqueue a callback onto the central queue — always ordered by (atMs, sequence) regardless of enqueue order */
  scheduleCallback(
    tenantId: string,
    deliveryId: string,
    outcome: LineCallbackOutcome,
    atMs: number,
    salt = String(atMs),
  ): string {
    const record = this.require(tenantId, deliveryId);
    const outcomeRef = mintLineId(
      'outcome',
      record.tenantId,
      record.actionKey,
      `${outcome}:${salt}`,
    );
    this.store.enqueueCallback({
      tenantId,
      deliveryId,
      outcome,
      atMs,
      sequence: this.clock.nextSequence(),
      outcomeRef,
    });
    return outcomeRef;
  }

  async runNext(correlationId: string): Promise<LineDeliveryEvidence | undefined> {
    const envelope = this.store.popNextDueCallback(this.clock.nowMs());
    if (!envelope) return undefined;
    return this.applyCallback(envelope, correlationId);
  }

  /** drive a callback directly without going through the queue — for testing duplicate/conflict/out-of-order explicitly */
  async deliverCallback(
    tenantId: string,
    deliveryId: string,
    outcome: LineCallbackOutcome,
    outcomeRef: string,
    correlationId: string,
  ): Promise<LineDeliveryEvidence> {
    const envelope: LineCallbackEnvelope = {
      tenantId,
      deliveryId,
      outcome,
      atMs: this.clock.nowMs(),
      sequence: this.clock.nextSequence(),
      outcomeRef,
    };
    return this.applyCallback(envelope, correlationId);
  }

  private async applyCallback(
    envelope: LineCallbackEnvelope,
    correlationId: string,
  ): Promise<LineDeliveryEvidence> {
    const record = this.require(envelope.tenantId, envelope.deliveryId);
    const scope = this.scopeOf(record);
    // The same outcomeRef + same payload is always a no-op, a different payload is a conflict — checked before checking
    // terminal so that the terminal state does not hide the hash-conflict evidence that repeats the same ref
    const disposition = this.store.recordOutcomeRef(
      scopeKey(scope),
      envelope.outcomeRef,
      canonical({ deliveryId: envelope.deliveryId, outcome: envelope.outcome }),
    );
    if (disposition === 'DUPLICATE_NOOP') return evidenceFromRecord(record);

    if (TERMINAL_STATES.has(record.state)) {
      // The first terminal outcome always wins; a later one with a new ref (out-of-order/late) is a no-op
      return evidenceFromRecord(record);
    }

    if (record.state === 'SUBMISSION_INTENT_RECORDED') {
      if (envelope.outcome === 'ACCEPTED') {
        await this.governance.confirmProviderAcceptance({
          ...this.governanceCommand(record, correlationId),
          providerRequestKey: toProviderRequestKey(record.providerRequestKey),
        });
        const updated = this.store.update(
          record.tenantId,
          record.deliveryId,
          { state: 'ACCEPTED' },
          'ACCEPTED',
          this.clock.nowMs(),
        );
        return evidenceFromRecord(updated);
      }
      if (envelope.outcome === 'PROVIDER_REJECTED') {
        return this.settle(record, correlationId, envelope.outcomeRef, 'PROVIDER_REJECTED');
      }
      if (envelope.outcome === 'TIMEOUT') {
        return this.forceReconcile(record, correlationId, `timeout:${envelope.outcomeRef}`);
      }
      throw new LineInvalidTransitionError(record.state, envelope.outcome);
    }

    if (record.state === 'ACCEPTED') {
      if (envelope.outcome === 'DELIVERED') {
        return this.settle(record, correlationId, envelope.outcomeRef, 'DELIVERED');
      }
      if (envelope.outcome === 'DELIVERY_FAILED') {
        return this.settle(record, correlationId, envelope.outcomeRef, 'DELIVERY_FAILED');
      }
      if (envelope.outcome === 'UNKNOWN_RECONCILING') {
        return this.forceReconcile(record, correlationId, `unknown:${envelope.outcomeRef}`);
      }
      throw new LineInvalidTransitionError(record.state, envelope.outcome);
    }

    if (record.state === 'UNKNOWN_RECONCILING') {
      // A reconcile that previously passed ACCEPTED (Governance confirmed) can end only as DELIVERED/DELIVERY_FAILED;
      // a reconcile that timed out before reaching ACCEPTED can end only as PROVIDER_REJECTED — matching the reservation
      // state CONFIRMED/RESERVED which ContactGovernancePort.settleDelivery treats as the authority
      const resolvable = record.reconcilingFromAccepted
        ? envelope.outcome === 'DELIVERED' || envelope.outcome === 'DELIVERY_FAILED'
        : envelope.outcome === 'PROVIDER_REJECTED';
      if (resolvable) {
        this.caps.exitUnknownReconciling(scope, record.deliveryId);
        return this.settle(
          record,
          correlationId,
          envelope.outcomeRef,
          envelope.outcome as LineSimulationSettleOutcome,
        );
      }
      throw new LineInvalidTransitionError(record.state, envelope.outcome);
    }

    throw new LineInvalidTransitionError(record.state, envelope.outcome);
  }

  private async settle(
    record: LineDeliveryRecord,
    correlationId: string,
    outcomeRef: string,
    outcome: LineSimulationSettleOutcome,
  ): Promise<LineDeliveryEvidence> {
    await this.governance.settleDelivery({
      ...this.governanceCommand(record, correlationId),
      providerRequestKey: toProviderRequestKey(record.providerRequestKey),
      outcomeRef: toOutcomeRef(outcomeRef),
      outcome,
      occurredAt: this.clock.nowIso(),
    });
    this.caps.releaseSubmission(this.scopeOf(record));
    const updated = this.store.update(
      record.tenantId,
      record.deliveryId,
      { state: 'SETTLED', outcome, outcomeRef, settledAtMs: this.clock.nowMs() },
      'SETTLED',
      this.clock.nowMs(),
    );
    return evidenceFromRecord(updated);
  }

  /** unknown stuck beyond the scope's threshold → system kill (see #102 §6) */
  checkUnknownReconcilingTimeouts(scope: LineScopeTuple): string[] {
    const timedOut = this.caps.findTimedOutUnknownReconciling(scope, this.clock.nowMs());
    if (timedOut.length > 0 && isAllowlistedScope(scope)) {
      this.rolloutGate.systemKill(scope, 'UNKNOWN_RECONCILING_TIMEOUT');
    }
    return timedOut;
  }

  evidenceFor(tenantId: string, deliveryId: string): LineDeliveryEvidence {
    return evidenceFromRecord(this.require(tenantId, deliveryId));
  }
}
