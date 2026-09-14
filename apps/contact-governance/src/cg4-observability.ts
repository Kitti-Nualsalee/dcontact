import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { Cg4QueryContext } from './cg4-query.js';

/**
 * CG4.11 (#194): observability ของ Contact Governance ตาม #179 §7 และ `CG4-OB01`
 *
 * snapshot อ่านจาก canonical tables ใน transaction เดียวของ tenant (ไม่ใช่ counter ใน memory ที่หาย
 * ตอน restart) แล้วแปลงเป็น metric samples และ alerts. label มีเพียง `tenant_id` ซึ่งเป็น opaque id:
 * ห้าม contact/identity/actor/evidence หรือ label ที่ cardinality สูงตาม customer (#179 §7, `CG4-OB02`)
 */

export interface Cg4ObservabilitySnapshot {
  tenantId: string;
  observedAt: string;
  rollout: {
    stage: string;
    mutationFrozen: boolean;
    shadowMismatchesInWindow: number;
    shadowMismatchesTotal: number;
  };
  quorum: {
    pendingExceptions: number;
    oldestPendingExceptionAgeSeconds: number | null;
    policiesInReview: number;
    oldestPolicyInReviewAgeSeconds: number | null;
    /** APPROVED version ที่ head ขยับไปแล้ว — publish จะชน POLICY_HEAD_CONFLICT */
    staleApprovals: number;
  };
  activation: {
    dueBacklog: number;
    oldestDueLagSeconds: number | null;
    failedJobs: number;
  };
  exceptions: { approved: number; expired: number; revoked: number };
  killSwitches: { active: number };
  events: {
    pendingOutbox: number;
    oldestPendingOutboxAgeSeconds: number | null;
    quarantinedOutbox: number;
  };
  consumers: {
    gapHeld: number;
    outOfOrder: number;
    quarantined: number;
    unsupported: number;
    activeScopePauses: number;
    oldestActivePauseAgeSeconds: number | null;
  };
  acknowledgements: {
    failed: number;
    quarantined: number;
    oldestUnacknowledgedEventAgeSeconds: number | null;
  };
  /** cache เป็น availability ไม่ใช่ truth จึงรับ counter จาก process ที่ถือ cache มาแนบเท่านั้น */
  cache?: Readonly<Record<string, number>>;
}

const ageSeconds = (from: Date | null | undefined, now: Date): number | null =>
  from ? Math.max(0, Math.round((now.getTime() - from.getTime()) / 1_000)) : null;

function countBy<T extends string>(
  rows: ReadonlyArray<{ key: T | string; count: number }>,
  key: string,
): number {
  return rows.find((row) => String(row.key) === key)?.count ?? 0;
}

export async function cg4ObservabilitySnapshot(
  database: PrismaClient,
  input: { tenantId: string; now?: Date; cache?: Readonly<Record<string, number>> },
): Promise<Cg4ObservabilitySnapshot> {
  const now = input.now ?? new Date();
  const tenantId = input.tenantId;
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const rollout = await transaction.cg4RolloutState.findUnique({ where: { tenantId } });
    const [
      mismatchesTotal,
      mismatchesInWindow,
      pendingExceptions,
      oldestPendingException,
      policiesInReview,
      oldestPolicyInReview,
      approvedPolicies,
      dueJobs,
      oldestDueJob,
      failedJobs,
      exceptionStatuses,
      activeKills,
      pendingOutbox,
      oldestPendingOutbox,
      outboxStates,
      inboxStates,
      activePauses,
      oldestPause,
      ackOutcomes,
    ] = await Promise.all([
      transaction.cg4ShadowMismatch.count({ where: { tenantId } }),
      transaction.cg4ShadowMismatch.count({
        where: { tenantId, detectedAt: { gte: rollout?.shadowStartedAt ?? new Date(0) } },
      }),
      transaction.cg4ExceptionHead.count({ where: { tenantId, status: 'PENDING' } }),
      transaction.cg4ExceptionHead.findFirst({
        where: { tenantId, status: 'PENDING' },
        orderBy: { updatedAt: 'asc' },
        select: { updatedAt: true },
      }),
      transaction.cg4Policy.count({ where: { tenantId, status: 'IN_REVIEW' } }),
      transaction.cg4Policy.findFirst({
        where: { tenantId, status: 'IN_REVIEW' },
        orderBy: { submittedAt: 'asc' },
        select: { submittedAt: true, createdAt: true },
      }),
      transaction.cg4Policy.findMany({
        where: { tenantId, status: 'APPROVED' },
        select: { scopeKey: true, baseHeadVersion: true, baseHeadDigest: true },
      }),
      transaction.cg4PolicyActivationJob.count({
        where: { tenantId, state: { in: ['PENDING', 'CLAIMED'] }, scheduledFor: { lte: now } },
      }),
      transaction.cg4PolicyActivationJob.findFirst({
        where: { tenantId, state: { in: ['PENDING', 'CLAIMED'] }, scheduledFor: { lte: now } },
        orderBy: { scheduledFor: 'asc' },
        select: { scheduledFor: true },
      }),
      transaction.cg4PolicyActivationJob.count({ where: { tenantId, state: 'FAILED' } }),
      transaction.cg4ExceptionHead.groupBy({
        by: ['status'],
        where: { tenantId },
        _count: { _all: true },
      }),
      transaction.cg4ScopeKillSwitch.count({ where: { tenantId, state: 'ACTIVE' } }),
      transaction.cgEventOutbox.count({ where: { tenantId, publishedAt: null } }),
      transaction.cgEventOutbox.findFirst({
        where: { tenantId, publishedAt: null },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      transaction.cgEventOutbox.groupBy({
        by: ['state'],
        where: { tenantId },
        _count: { _all: true },
      }),
      transaction.cgConsumerInbox.groupBy({
        by: ['state'],
        where: { tenantId },
        _count: { _all: true },
      }),
      transaction.cgScopePause.count({ where: { tenantId, state: 'ACTIVE' } }),
      transaction.cgScopePause.findFirst({
        where: { tenantId, state: 'ACTIVE' },
        orderBy: { pausedAt: 'asc' },
        select: { pausedAt: true },
      }),
      transaction.cgConsumerAcknowledgement.groupBy({
        by: ['outcome'],
        where: { tenantId },
        _count: { _all: true },
      }),
    ]);

    let staleApprovals = 0;
    if (approvedPolicies.length > 0) {
      const heads = await transaction.cg4PolicyScopeHead.findMany({
        where: {
          tenantId,
          scopeKey: { in: [...new Set(approvedPolicies.map((row) => row.scopeKey))] },
        },
        select: { scopeKey: true, headVersion: true, headDigest: true },
      });
      const headByScope = new Map(heads.map((head) => [head.scopeKey, head]));
      staleApprovals = approvedPolicies.filter((row) => {
        const head = headByScope.get(row.scopeKey);
        return (
          (head?.headVersion ?? 0) !== (row.baseHeadVersion ?? 0) ||
          (head !== undefined && head.headDigest !== row.baseHeadDigest)
        );
      }).length;
    }

    // ack lag: event ที่ publish แล้วแต่ยังไม่มี consumer ใด ack ถึง aggregate version นั้น
    const published = await transaction.cgEventOutbox.findMany({
      where: { tenantId, publishedAt: { not: null } },
      orderBy: { publishedAt: 'asc' },
      take: 500,
      select: { aggregateId: true, aggregateVersion: true, publishedAt: true },
    });
    let oldestUnacknowledged: Date | null = null;
    if (published.length > 0) {
      const applied = await transaction.cgConsumerAcknowledgement.groupBy({
        by: ['aggregateId'],
        where: {
          tenantId,
          aggregateId: { in: [...new Set(published.map((row) => row.aggregateId))] },
        },
        _max: { appliedVersion: true },
      });
      const maxApplied = new Map(
        applied.map((row) => [row.aggregateId, row._max.appliedVersion ?? 0]),
      );
      const lagging = published.find(
        (row) => row.aggregateVersion > (maxApplied.get(row.aggregateId) ?? 0),
      );
      oldestUnacknowledged = lagging?.publishedAt ?? null;
    }

    const outbox = outboxStates.map((row) => ({ key: row.state, count: row._count._all }));
    const inbox = inboxStates.map((row) => ({ key: row.state, count: row._count._all }));
    const acks = ackOutcomes.map((row) => ({ key: row.outcome, count: row._count._all }));
    const exceptions = exceptionStatuses.map((row) => ({
      key: row.status,
      count: row._count._all,
    }));

    return {
      tenantId,
      observedAt: now.toISOString(),
      rollout: {
        stage: rollout?.stage ?? 'DISABLED',
        mutationFrozen: rollout?.mutationFrozen ?? false,
        shadowMismatchesInWindow: rollout?.shadowStartedAt ? mismatchesInWindow : 0,
        shadowMismatchesTotal: mismatchesTotal,
      },
      quorum: {
        pendingExceptions,
        oldestPendingExceptionAgeSeconds: ageSeconds(oldestPendingException?.updatedAt, now),
        policiesInReview,
        oldestPolicyInReviewAgeSeconds: ageSeconds(
          oldestPolicyInReview?.submittedAt ?? oldestPolicyInReview?.createdAt,
          now,
        ),
        staleApprovals,
      },
      activation: {
        dueBacklog: dueJobs,
        oldestDueLagSeconds: ageSeconds(oldestDueJob?.scheduledFor, now),
        failedJobs,
      },
      exceptions: {
        approved: countBy(exceptions, 'APPROVED'),
        expired: countBy(exceptions, 'EXPIRED'),
        revoked: countBy(exceptions, 'REVOKED'),
      },
      killSwitches: { active: activeKills },
      events: {
        pendingOutbox,
        oldestPendingOutboxAgeSeconds: ageSeconds(oldestPendingOutbox?.createdAt, now),
        quarantinedOutbox: countBy(outbox, 'QUARANTINED'),
      },
      consumers: {
        gapHeld: countBy(inbox, 'GAP_HELD'),
        outOfOrder: countBy(inbox, 'OUT_OF_ORDER'),
        quarantined: countBy(inbox, 'QUARANTINED'),
        unsupported: countBy(inbox, 'UNSUPPORTED'),
        activeScopePauses: activePauses,
        oldestActivePauseAgeSeconds: ageSeconds(oldestPause?.pausedAt, now),
      },
      acknowledgements: {
        failed: countBy(acks, 'FAILED'),
        quarantined: countBy(acks, 'QUARANTINED'),
        oldestUnacknowledgedEventAgeSeconds: ageSeconds(oldestUnacknowledged, now),
      },
      ...(input.cache ? { cache: { ...input.cache } } : {}),
    };
  });
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface Cg4MetricSample {
  name: string;
  value: number;
  labels: { tenant_id: string };
}

export function cg4MetricSamples(snapshot: Cg4ObservabilitySnapshot): Cg4MetricSample[] {
  const labels = { tenant_id: snapshot.tenantId };
  const gauge = (name: string, value: number | null | boolean): Cg4MetricSample => ({
    name: `cg4_${name}`,
    value: typeof value === 'boolean' ? (value ? 1 : 0) : (value ?? 0),
    labels,
  });
  return [
    gauge('rollout_mutation_frozen', snapshot.rollout.mutationFrozen),
    gauge('migration_shadow_mismatch_window_total', snapshot.rollout.shadowMismatchesInWindow),
    gauge('migration_shadow_mismatch_total', snapshot.rollout.shadowMismatchesTotal),
    gauge('exception_pending_total', snapshot.quorum.pendingExceptions),
    gauge('exception_quorum_wait_age_seconds', snapshot.quorum.oldestPendingExceptionAgeSeconds),
    gauge('policy_in_review_total', snapshot.quorum.policiesInReview),
    gauge('policy_quorum_wait_age_seconds', snapshot.quorum.oldestPolicyInReviewAgeSeconds),
    gauge('policy_stale_approval_total', snapshot.quorum.staleApprovals),
    gauge('policy_activation_due_backlog_total', snapshot.activation.dueBacklog),
    gauge('policy_activation_lag_seconds', snapshot.activation.oldestDueLagSeconds),
    gauge('policy_activation_failed_total', snapshot.activation.failedJobs),
    gauge('exception_active_total', snapshot.exceptions.approved),
    gauge('exception_expired_total', snapshot.exceptions.expired),
    gauge('exception_revoked_total', snapshot.exceptions.revoked),
    gauge('kill_switch_active_total', snapshot.killSwitches.active),
    gauge('outbox_pending_total', snapshot.events.pendingOutbox),
    gauge('outbox_pending_age_seconds', snapshot.events.oldestPendingOutboxAgeSeconds),
    gauge('outbox_quarantined_total', snapshot.events.quarantinedOutbox),
    gauge('consumer_gap_held_total', snapshot.consumers.gapHeld),
    gauge('consumer_out_of_order_total', snapshot.consumers.outOfOrder),
    gauge('consumer_quarantined_total', snapshot.consumers.quarantined),
    gauge('consumer_unsupported_total', snapshot.consumers.unsupported),
    gauge('scope_pause_active_total', snapshot.consumers.activeScopePauses),
    gauge('scope_pause_age_seconds', snapshot.consumers.oldestActivePauseAgeSeconds),
    gauge('ack_failed_total', snapshot.acknowledgements.failed),
    gauge('ack_quarantined_total', snapshot.acknowledgements.quarantined),
    gauge('ack_lag_seconds', snapshot.acknowledgements.oldestUnacknowledgedEventAgeSeconds),
    ...Object.entries(snapshot.cache ?? {}).map(([name, value]) =>
      gauge(`cache_${name.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`, value),
    ),
  ];
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export interface Cg4AlertThresholds {
  quorumWaitSeconds: number;
  activationLagSeconds: number;
  outboxAgeSeconds: number;
  scopePauseAgeSeconds: number;
  ackLagSeconds: number;
}

export const CG4_DEFAULT_ALERT_THRESHOLDS: Readonly<Cg4AlertThresholds> = Object.freeze({
  quorumWaitSeconds: 24 * 60 * 60,
  activationLagSeconds: 5 * 60,
  outboxAgeSeconds: 5 * 60,
  scopePauseAgeSeconds: 10 * 60,
  ackLagSeconds: 10 * 60,
});

export type Cg4AlertCode =
  | 'GOVERNANCE_QUORUM_WAIT_AGE'
  | 'GOVERNANCE_STALE_APPROVAL'
  | 'GOVERNANCE_ACTIVATION_LAG'
  | 'GOVERNANCE_ACTIVATION_FAILED'
  | 'GOVERNANCE_OUTBOX_LAG'
  | 'GOVERNANCE_EVENT_QUARANTINED'
  | 'GOVERNANCE_CONSUMER_GAP_OR_DLQ'
  | 'GOVERNANCE_SCOPE_PAUSE_AGE'
  | 'GOVERNANCE_ACK_LAG'
  | 'GOVERNANCE_ACK_FAILED'
  | 'GOVERNANCE_KILL_SWITCH_ACTIVE'
  | 'GOVERNANCE_MIGRATION_MISMATCH'
  | 'GOVERNANCE_MUTATION_FROZEN';

export interface Cg4Alert {
  code: Cg4AlertCode;
  severity: 'WARNING' | 'CRITICAL';
  value: number;
  threshold: number;
}

export function evaluateCg4Alerts(
  snapshot: Cg4ObservabilitySnapshot,
  thresholds: Cg4AlertThresholds = CG4_DEFAULT_ALERT_THRESHOLDS,
): Cg4Alert[] {
  const alerts: Cg4Alert[] = [];
  const over = (
    code: Cg4AlertCode,
    severity: Cg4Alert['severity'],
    value: number | null,
    threshold: number,
  ) => {
    if (value !== null && value > threshold) alerts.push({ code, severity, value, threshold });
  };
  const quorumAge = Math.max(
    snapshot.quorum.oldestPendingExceptionAgeSeconds ?? -1,
    snapshot.quorum.oldestPolicyInReviewAgeSeconds ?? -1,
  );
  over(
    'GOVERNANCE_QUORUM_WAIT_AGE',
    'WARNING',
    quorumAge < 0 ? null : quorumAge,
    thresholds.quorumWaitSeconds,
  );
  over('GOVERNANCE_STALE_APPROVAL', 'WARNING', snapshot.quorum.staleApprovals, 0);
  // activation ที่ค้างทำให้ scope fail closed จึงเป็น CRITICAL เสมอ
  over(
    'GOVERNANCE_ACTIVATION_LAG',
    'CRITICAL',
    snapshot.activation.oldestDueLagSeconds,
    thresholds.activationLagSeconds,
  );
  over('GOVERNANCE_ACTIVATION_FAILED', 'CRITICAL', snapshot.activation.failedJobs, 0);
  over(
    'GOVERNANCE_OUTBOX_LAG',
    'WARNING',
    snapshot.events.oldestPendingOutboxAgeSeconds,
    thresholds.outboxAgeSeconds,
  );
  over('GOVERNANCE_EVENT_QUARANTINED', 'CRITICAL', snapshot.events.quarantinedOutbox, 0);
  over(
    'GOVERNANCE_CONSUMER_GAP_OR_DLQ',
    'CRITICAL',
    snapshot.consumers.gapHeld +
      snapshot.consumers.outOfOrder +
      snapshot.consumers.quarantined +
      snapshot.consumers.unsupported,
    0,
  );
  over(
    'GOVERNANCE_SCOPE_PAUSE_AGE',
    'WARNING',
    snapshot.consumers.oldestActivePauseAgeSeconds,
    thresholds.scopePauseAgeSeconds,
  );
  over(
    'GOVERNANCE_ACK_LAG',
    'WARNING',
    snapshot.acknowledgements.oldestUnacknowledgedEventAgeSeconds,
    thresholds.ackLagSeconds,
  );
  over(
    'GOVERNANCE_ACK_FAILED',
    'CRITICAL',
    snapshot.acknowledgements.failed + snapshot.acknowledgements.quarantined,
    0,
  );
  over('GOVERNANCE_KILL_SWITCH_ACTIVE', 'WARNING', snapshot.killSwitches.active, 0);
  over('GOVERNANCE_MIGRATION_MISMATCH', 'CRITICAL', snapshot.rollout.shadowMismatchesInWindow, 0);
  over('GOVERNANCE_MUTATION_FROZEN', 'WARNING', snapshot.rollout.mutationFrozen ? 1 : 0, 0);
  return alerts;
}

// ── Downstream acknowledgement query (additive, #179 §4) ─────────────────────

export interface Cg4AcknowledgementView {
  consumer: string;
  eventId: string;
  aggregateType: string;
  aggregateId: string;
  appliedVersion: number;
  outcome: string;
  affectedCount: number;
  appliedStateDigest?: string;
  appliedAt: string;
}

export async function cg4DownstreamAcknowledgements(
  database: PrismaClient,
  context: Cg4QueryContext,
  query: { aggregateType: 'POLICY' | 'CONTACT'; aggregateId: string; limit?: number },
): Promise<Cg4AcknowledgementView[]> {
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
  return withTenantDatabaseTransaction(database, context.tenantId, async (transaction) => {
    const rows = await transaction.cgConsumerAcknowledgement.findMany({
      where: {
        tenantId: context.tenantId,
        aggregateType: query.aggregateType,
        aggregateId: query.aggregateId,
      },
      orderBy: [{ appliedVersion: 'desc' }, { consumer: 'asc' }],
      take: limit,
    });
    return rows.map((row) => ({
      consumer: row.consumer,
      eventId: row.eventId,
      aggregateType: row.aggregateType,
      aggregateId: row.aggregateId,
      appliedVersion: row.appliedVersion,
      outcome: row.outcome,
      affectedCount: row.affectedCount,
      ...(row.appliedStateDigest ? { appliedStateDigest: row.appliedStateDigest } : {}),
      appliedAt: row.appliedAt.toISOString(),
    }));
  });
}
