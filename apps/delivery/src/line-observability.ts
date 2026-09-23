/**
 * Owner: Delivery/Channels — metrics/alerts ของ LINE pilot (S2.6 #366, `S2-LINE-OB01`)
 *
 * Authority: #360 §B (OB01), #362 §5/§6/§7/§9
 *
 * snapshot อ่านจาก canonical tables ของ Delivery ใน transaction เดียวของ tenant จึงไม่หายตอน restart
 * ยกเว้น signature ที่ไม่ผ่าน ซึ่ง ingress ห้าม persist อะไรเลย (#362 §7) — ตัวนับนั้นจึงมาจาก process
 * ที่ถือ ingress แนบเข้ามา เหมือน cache counter ของ CG4
 *
 * label มีเพียง `tenant_id` (opaque) — ห้าม recipient/fingerprint/delivery/message/event ID ใน label
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { LineKillReason } from '@d-contact/cxa-contracts';
import { LINE_CONTROL_SIGNALS } from './line-control-policy.js';

export interface LineIngressCounters {
  /** request ที่ signature ไม่ผ่านในหน้าต่างล่าสุด — ไม่มีแถวใน DB ตาม #362 §7 */
  signatureInvalid: number;
  durabilityUnavailable: number;
}

export interface LineObservabilitySnapshot {
  tenantId: string;
  observedAt: string;
  windowSeconds: number;
  settlement: {
    /** LINE outbox ที่ข้าม barrier แล้วแต่ยังไม่ SETTLED */
    inFlight: number;
    reconciling: number;
    oldestInFlightAgeSeconds: number | null;
  };
  provider: {
    authInvalid: number;
    quotaExhausted: number;
    rateLimited: number;
    unavailable: number;
    retryWindowExpired: number;
  };
  webhook: {
    pending: number;
    oldestPendingAgeSeconds: number | null;
    quarantined: number;
    ingress: LineIngressCounters | null;
  };
  correlation: { pending: number; quarantined: number };
  control: {
    killedScopes: number;
    automaticKills: number;
    technicalSwitchOn: number;
    runDenials: number;
    capReservationsHeld: number;
  };
  events: { pending: number; oldestPendingAgeSeconds: number | null; failed: number };
}

const ageSeconds = (from: Date | null | undefined, now: Date): number | null =>
  from ? Math.max(0, Math.round((now.getTime() - from.getTime()) / 1_000)) : null;

const IN_FLIGHT_STATES = ['SUBMITTING', 'SUBMITTED', 'RECONCILING'] as const;
const AUTOMATIC_KILL_REASONS: readonly LineKillReason[] = LINE_CONTROL_SIGNALS;

/** หน้าต่างของตัวนับเหตุการณ์ (provider outcome/run denial) — gauge ของสถานะค้างไม่ใช้หน้าต่าง */
export const LINE_OBSERVABILITY_WINDOW_SECONDS = 60 * 60;

export async function lineObservabilitySnapshot(
  database: PrismaClient,
  input: {
    tenantId: string;
    now?: Date;
    windowSeconds?: number;
    ingress?: LineIngressCounters;
  },
): Promise<LineObservabilitySnapshot> {
  const now = input.now ?? new Date();
  const tenantId = input.tenantId;
  const windowSeconds = input.windowSeconds ?? LINE_OBSERVABILITY_WINDOW_SECONDS;
  const since = new Date(now.getTime() - windowSeconds * 1_000);
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const lineOutbox = { tenantId, adapter: 'LINE_MESSAGING_API' as const };
    const [
      inFlight,
      reconciling,
      oldestInFlight,
      outcomes,
      webhookPending,
      oldestWebhookPending,
      webhookQuarantined,
      correlationStates,
      gates,
      runDenials,
      capHeld,
      eventsPending,
      oldestEventPending,
      eventsFailed,
    ] = await Promise.all([
      transaction.dlOutboxEntry.count({
        where: { ...lineOutbox, state: { in: [...IN_FLIGHT_STATES] } },
      }),
      transaction.dlOutboxEntry.count({ where: { ...lineOutbox, state: 'RECONCILING' } }),
      transaction.dlOutboxEntry.findFirst({
        where: { ...lineOutbox, state: { in: [...IN_FLIGHT_STATES] } },
        orderBy: { submittedAt: 'asc' },
        select: { submittedAt: true, updatedAt: true },
      }),
      transaction.dlProviderSubmissionAttempt.groupBy({
        by: ['outcomeCode'],
        where: { tenantId, finishedAt: { gte: since } },
        _count: { _all: true },
      }),
      transaction.dlLineWebhookInboxEntry.count({
        where: { tenantId, state: { in: ['PENDING', 'PROCESSING'] } },
      }),
      transaction.dlLineWebhookInboxEntry.findFirst({
        where: { tenantId, state: { in: ['PENDING', 'PROCESSING'] } },
        orderBy: { receivedAt: 'asc' },
        select: { receivedAt: true },
      }),
      transaction.dlLineWebhookInboxEntry.count({ where: { tenantId, state: 'QUARANTINED' } }),
      transaction.dlLineTouchCorrelation.groupBy({
        by: ['state'],
        where: { tenantId, state: { in: ['PENDING', 'QUARANTINED'] } },
        _count: { _all: true },
      }),
      transaction.dlLineScopeGate.findMany({
        where: { tenantId },
        select: { killed: true, killReason: true, technicalSwitchOn: true },
      }),
      transaction.dlLineAuditEvent.count({
        where: {
          tenantId,
          category: 'RUN_AUTHORIZATION',
          code: 'RUN_DENIED',
          occurredAt: { gte: since },
        },
      }),
      transaction.dlLineCapLedgerEntry.count({ where: { tenantId, state: 'RESERVED' } }),
      transaction.dlLineEventOutboxEntry.count({
        where: { tenantId, state: { in: ['PENDING', 'PUBLISHING'] } },
      }),
      transaction.dlLineEventOutboxEntry.findFirst({
        where: { tenantId, state: { in: ['PENDING', 'PUBLISHING'] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      transaction.dlLineEventOutboxEntry.count({ where: { tenantId, state: 'FAILED' } }),
    ]);
    const outcome = (code: string) =>
      outcomes.find((row) => row.outcomeCode === code)?._count._all ?? 0;
    const correlation = (state: string) =>
      correlationStates.find((row) => row.state === state)?._count._all ?? 0;
    return {
      tenantId,
      observedAt: now.toISOString(),
      windowSeconds,
      settlement: {
        inFlight,
        reconciling,
        oldestInFlightAgeSeconds: ageSeconds(
          oldestInFlight?.submittedAt ?? oldestInFlight?.updatedAt,
          now,
        ),
      },
      provider: {
        authInvalid: outcome('LINE_AUTH_INVALID'),
        quotaExhausted: outcome('LINE_MONTHLY_QUOTA_EXHAUSTED'),
        rateLimited: outcome('LINE_RATE_LIMITED'),
        unavailable: outcome('LINE_PROVIDER_UNAVAILABLE') + outcome('LINE_UNKNOWN_OUTCOME'),
        retryWindowExpired: outcome('LINE_RETRY_WINDOW_EXPIRED'),
      },
      webhook: {
        pending: webhookPending,
        oldestPendingAgeSeconds: ageSeconds(oldestWebhookPending?.receivedAt, now),
        quarantined: webhookQuarantined,
        ingress: input.ingress ? { ...input.ingress } : null,
      },
      correlation: { pending: correlation('PENDING'), quarantined: correlation('QUARANTINED') },
      control: {
        killedScopes: gates.filter((gate) => gate.killed).length,
        automaticKills: gates.filter(
          (gate) =>
            gate.killed && gate.killReason && AUTOMATIC_KILL_REASONS.includes(gate.killReason),
        ).length,
        technicalSwitchOn: gates.filter((gate) => gate.technicalSwitchOn).length,
        runDenials,
        capReservationsHeld: capHeld,
      },
      events: {
        pending: eventsPending,
        oldestPendingAgeSeconds: ageSeconds(oldestEventPending?.createdAt, now),
        failed: eventsFailed,
      },
    };
  });
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface LineMetricSample {
  name: string;
  value: number;
  labels: { tenant_id: string };
}

export function lineMetricSamples(snapshot: LineObservabilitySnapshot): LineMetricSample[] {
  const labels = { tenant_id: snapshot.tenantId };
  const gauge = (name: string, value: number | null): LineMetricSample => ({
    name: `line_${name}`,
    value: value ?? 0,
    labels,
  });
  return [
    gauge('settlement_in_flight_total', snapshot.settlement.inFlight),
    gauge('settlement_reconciling_total', snapshot.settlement.reconciling),
    gauge('settlement_oldest_in_flight_age_seconds', snapshot.settlement.oldestInFlightAgeSeconds),
    gauge('provider_auth_invalid_window_total', snapshot.provider.authInvalid),
    gauge('provider_quota_exhausted_window_total', snapshot.provider.quotaExhausted),
    gauge('provider_rate_limited_window_total', snapshot.provider.rateLimited),
    gauge('provider_unavailable_window_total', snapshot.provider.unavailable),
    gauge('provider_retry_window_expired_window_total', snapshot.provider.retryWindowExpired),
    gauge('webhook_pending_total', snapshot.webhook.pending),
    gauge('webhook_pending_age_seconds', snapshot.webhook.oldestPendingAgeSeconds),
    gauge('webhook_quarantined_total', snapshot.webhook.quarantined),
    gauge(
      'webhook_signature_invalid_window_total',
      snapshot.webhook.ingress?.signatureInvalid ?? null,
    ),
    gauge(
      'webhook_durability_unavailable_window_total',
      snapshot.webhook.ingress?.durabilityUnavailable ?? null,
    ),
    gauge('touch_correlation_pending_total', snapshot.correlation.pending),
    gauge('touch_correlation_quarantined_total', snapshot.correlation.quarantined),
    gauge('scope_killed_total', snapshot.control.killedScopes),
    gauge('scope_automatic_kill_total', snapshot.control.automaticKills),
    gauge('technical_switch_on_total', snapshot.control.technicalSwitchOn),
    gauge('run_denied_window_total', snapshot.control.runDenials),
    gauge('cap_reservation_held_total', snapshot.control.capReservationsHeld),
    gauge('event_outbox_pending_total', snapshot.events.pending),
    gauge('event_outbox_pending_age_seconds', snapshot.events.oldestPendingAgeSeconds),
    gauge('event_outbox_failed_total', snapshot.events.failed),
  ];
}

// ── Alerts ───────────────────────────────────────────────────────────────────

export interface LineAlertThresholds {
  /** backoff สูงสุด 15 นาที (#357 §3) — เกินสองรอบโดยยังไม่ settle ถือว่าค้าง */
  settlementStuckSeconds: number;
  webhookBacklogSeconds: number;
  eventOutboxAgeSeconds: number;
}

export const LINE_DEFAULT_ALERT_THRESHOLDS: Readonly<LineAlertThresholds> = Object.freeze({
  settlementStuckSeconds: 30 * 60,
  webhookBacklogSeconds: 5 * 60,
  eventOutboxAgeSeconds: 5 * 60,
});

export type LineAlertCode =
  | 'LINE_SETTLEMENT_STUCK'
  | 'LINE_UNKNOWN_RECONCILING'
  | 'LINE_RETRY_WINDOW_EXPIRED'
  | 'LINE_AUTH_FAILURE'
  | 'LINE_QUOTA_EXHAUSTED'
  | 'LINE_RATE_LIMITED'
  | 'LINE_WEBHOOK_SIGNATURE_INVALID'
  | 'LINE_WEBHOOK_DURABILITY_UNAVAILABLE'
  | 'LINE_WEBHOOK_BACKLOG'
  | 'LINE_WEBHOOK_QUARANTINED'
  | 'LINE_TOUCH_CORRELATION_QUARANTINED'
  | 'LINE_CAP_OR_RUN_DENIED'
  | 'LINE_AUTOMATIC_KILL'
  | 'LINE_SCOPE_KILLED'
  | 'LINE_EVENT_OUTBOX_LAG'
  | 'LINE_EVENT_OUTBOX_FAILED';

export interface LineAlert {
  code: LineAlertCode;
  severity: 'WARNING' | 'CRITICAL';
  value: number;
  threshold: number;
}

export function evaluateLineAlerts(
  snapshot: LineObservabilitySnapshot,
  thresholds: LineAlertThresholds = LINE_DEFAULT_ALERT_THRESHOLDS,
): LineAlert[] {
  const alerts: LineAlert[] = [];
  const over = (
    code: LineAlertCode,
    severity: LineAlert['severity'],
    value: number | null,
    threshold: number,
  ) => {
    if (value !== null && value > threshold) alerts.push({ code, severity, value, threshold });
  };
  // settlement ที่ค้างคือ unknown ที่อาจกลายเป็นข้อความซ้ำ — CRITICAL เสมอ
  over(
    'LINE_SETTLEMENT_STUCK',
    'CRITICAL',
    snapshot.settlement.oldestInFlightAgeSeconds,
    thresholds.settlementStuckSeconds,
  );
  over('LINE_UNKNOWN_RECONCILING', 'WARNING', snapshot.settlement.reconciling, 0);
  over('LINE_RETRY_WINDOW_EXPIRED', 'CRITICAL', snapshot.provider.retryWindowExpired, 0);
  over('LINE_AUTH_FAILURE', 'CRITICAL', snapshot.provider.authInvalid, 0);
  over('LINE_QUOTA_EXHAUSTED', 'CRITICAL', snapshot.provider.quotaExhausted, 0);
  over('LINE_RATE_LIMITED', 'WARNING', snapshot.provider.rateLimited, 0);
  over(
    'LINE_WEBHOOK_SIGNATURE_INVALID',
    'WARNING',
    snapshot.webhook.ingress?.signatureInvalid ?? null,
    0,
  );
  over(
    'LINE_WEBHOOK_DURABILITY_UNAVAILABLE',
    'CRITICAL',
    snapshot.webhook.ingress?.durabilityUnavailable ?? null,
    0,
  );
  over(
    'LINE_WEBHOOK_BACKLOG',
    'WARNING',
    snapshot.webhook.oldestPendingAgeSeconds,
    thresholds.webhookBacklogSeconds,
  );
  over('LINE_WEBHOOK_QUARANTINED', 'WARNING', snapshot.webhook.quarantined, 0);
  over('LINE_TOUCH_CORRELATION_QUARANTINED', 'WARNING', snapshot.correlation.quarantined, 0);
  over('LINE_CAP_OR_RUN_DENIED', 'WARNING', snapshot.control.runDenials, 0);
  over('LINE_AUTOMATIC_KILL', 'CRITICAL', snapshot.control.automaticKills, 0);
  // kill ที่คนสั่ง (รวม rollback) เป็นสถานะที่ตั้งใจ แต่ยังต้องมองเห็น
  over(
    'LINE_SCOPE_KILLED',
    'WARNING',
    snapshot.control.killedScopes - snapshot.control.automaticKills,
    0,
  );
  over(
    'LINE_EVENT_OUTBOX_LAG',
    'WARNING',
    snapshot.events.oldestPendingAgeSeconds,
    thresholds.eventOutboxAgeSeconds,
  );
  over('LINE_EVENT_OUTBOX_FAILED', 'CRITICAL', snapshot.events.failed, 0);
  return alerts;
}
