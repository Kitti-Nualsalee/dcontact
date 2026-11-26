/**
 * J2.8 (#136) — `ACK_UNKNOWN` escalation policy and bounded reconciliation deadlines
 *
 * `JourneyOwnerResultReconciler` documents itself with "ACK_UNKNOWN escalation is the
 * caller's own decision, not made here" — but no caller ever did that job. As a result an action
 * the owner does not answer would sit at `DISPATCHED` forever with nothing chasing it and nobody knowing
 *
 * The intended order, as stated in #136 ("ACK_UNKNOWN queries the owner before retry, bounded retry
 * and reconciliation deadlines"):
 *
 *   1. past `ackDeadlineMs` counted from dispatch with no result -> move to `ACK_UNKNOWN`
 *      not an immediate retry, because we do not know whether the owner already did it, and a blind resend
 *      could create a duplicate Case/Callback
 *   2. **always ask the owner first** through the reconciler; if a result exists, apply it and finish
 *   3. no result yet -> count another attempt, then wait for the next round
 *   4. at `maxAttempts` -> stop chasing on its own, record `JrRecoveryAudit` as evidence and
 *      hand over to a person to decide through the admin recovery API (#235) — this is the spec's "bounded":
 *      the system does not call the owner forever and does not just go silent
 *
 * an escalated action stays in `ACK_UNKNOWN`, which is an open state — if the result arrives late
 * (through the result consumer) it can still be applied as normal; escalating does not close that door
 */
import type { PrismaClient } from '@d-contact/db';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyRecoveryAuditLog } from './journey-recovery-audit.js';
import type { JourneyOwnerResultReconciler } from './journey-owner-result-reconciler.js';
import { noOpJourneyOwnerMetrics, type JourneyOwnerMetrics } from './journey-owner-metrics.js';

export type AckEscalationOutcome =
  /** the owner was asked and a real result was applied */
  | 'RECONCILED'
  /** no result yet; count an attempt and wait for the next round */
  | 'WAITING'
  /** the retry ceiling was reached; handed over to a person through the admin recovery API */
  | 'ESCALATED'
  /** lost the race to a result that had just arrived — let that side win */
  | 'SUPERSEDED';

export interface JourneyOwnerAckEscalatorOptions {
  now?: () => Date;
  /** silent for longer than this counted from dispatch is treated as an unknown outcome */
  ackDeadlineMs?: number;
  /** how many rounds the owner may be asked before handing over to a person */
  maxAttempts?: number;
  actorId?: string;
  metrics?: JourneyOwnerMetrics;
}

const DEFAULT_ACK_DEADLINE_MS = 60_000;
const DEFAULT_MAX_ATTEMPTS = 5;
/**
 * `jr_recovery_audit.actor_id` is a UUID because it is normally a real user — escalation is a
 * system decision, so this fixed UUID is used instead, so queries can clearly separate "done by the system" from
 * "ordered by a person" without changing the column type
 */
export const ACK_ESCALATOR_ACTOR_ID = '00000000-0000-4000-8000-000000000a28';

export class JourneyOwnerAckEscalator {
  private readonly actions: JourneyOwnerActionRepository;
  private readonly audit: JourneyRecoveryAuditLog;
  private readonly now: () => Date;
  private readonly ackDeadlineMs: number;
  private readonly maxAttempts: number;
  private readonly actorId: string;
  private readonly metrics: JourneyOwnerMetrics;

  constructor(
    database: PrismaClient,
    private readonly reconciler: JourneyOwnerResultReconciler,
    options: JourneyOwnerAckEscalatorOptions = {},
  ) {
    this.actions = new JourneyOwnerActionRepository(database);
    this.audit = new JourneyRecoveryAuditLog(database);
    this.now = options.now ?? (() => new Date());
    this.ackDeadlineMs = options.ackDeadlineMs ?? DEFAULT_ACK_DEADLINE_MS;
    this.maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    this.actorId = options.actorId ?? ACK_ESCALATOR_ACTOR_ID;
    this.metrics = options.metrics ?? noOpJourneyOwnerMetrics;
  }

  /** handles one action per call; returns undefined when nothing is left pending */
  async escalateNext(tenantId: string): Promise<AckEscalationOutcome | undefined> {
    const deadline = new Date(this.now().getTime() - this.ackDeadlineMs);
    const [stale] = await this.actions.findStaleDispatched(tenantId, deadline, this.maxAttempts, 1);
    if (!stale) return this.escalateNextCancel(tenantId, deadline);

    const marked = await this.actions.markAckUnknown(tenantId, stale.actionKey, stale.version);
    // lost the race to a result that had just arrived — that side is more correct, nothing more to do
    if (!marked) return 'SUPERSEDED';

    this.metrics.increment('journey_owner_ack_unknown_total');
    this.metrics.observe('journey_owner_ack_attempts', marked.attempts);

    // always ask the owner first; never retry blindly
    const reconciled = await this.reconciler.reconcile(tenantId, stale.actionKey);
    if (reconciled !== 'NO_RESULT_YET') {
      this.metrics.increment('journey_owner_ack_reconciled_total');
      return 'RECONCILED';
    }

    if (marked.attempts < this.maxAttempts) return 'WAITING';

    await this.audit.record({
      tenantId,
      operation: 'RECONCILE',
      targetKind: 'ACTION',
      targetRef: stale.actionKey,
      reasonCode: 'ACK_UNKNOWN_DEADLINE_EXCEEDED',
      actorId: this.actorId,
    });
    this.metrics.increment('journey_owner_ack_escalated_total');
    return 'ESCALATED';
  }

  /**
   * a cancel/supersede the owner has not confirmed — the same order as ACK_UNKNOWN (always ask first, count attempts,
   * hand over to a person at the ceiling) but it keeps the CANCEL_REQUESTED state and asks with the requestHash of the cancel command
   * rather than the original command, otherwise the original ADMITTED/SCHEDULED result would come back instead of the cancellation result
   */
  private async escalateNextCancel(
    tenantId: string,
    deadline: Date,
  ): Promise<AckEscalationOutcome | undefined> {
    const [stale] = await this.actions.findStaleCancelRequested(
      tenantId,
      deadline,
      this.maxAttempts,
      1,
    );
    if (!stale) return undefined;

    const marked = await this.actions.markCancelUnconfirmed(
      tenantId,
      stale.actionKey,
      stale.version,
    );
    if (!marked) return 'SUPERSEDED';
    this.metrics.increment('journey_owner_ack_unknown_total');
    this.metrics.observe('journey_owner_ack_attempts', marked.action.attempts);

    const reconciled = await this.reconciler.reconcile(
      tenantId,
      stale.actionKey,
      marked.cancelRequestHash,
    );
    if (reconciled !== 'NO_RESULT_YET') {
      this.metrics.increment('journey_owner_ack_reconciled_total');
      return 'RECONCILED';
    }
    if (marked.action.attempts < this.maxAttempts) return 'WAITING';

    await this.audit.record({
      tenantId,
      operation: 'RECONCILE',
      targetKind: 'ACTION',
      targetRef: stale.actionKey,
      reasonCode: 'CANCEL_UNCONFIRMED_DEADLINE_EXCEEDED',
      actorId: this.actorId,
    });
    this.metrics.increment('journey_owner_ack_escalated_total');
    return 'ESCALATED';
  }
}
