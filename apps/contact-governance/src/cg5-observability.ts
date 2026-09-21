import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { CG5_EVENT_METRICS_CONSUMER_GROUP } from './cg5-event-metrics-consumer.js';
import { PrismaCg5TenantConfigRepository } from './cg5-tenant-config-repository.js';

/**
 * CG5.12 (#349): telemetry ของ projection, alert และ export ตาม `CG5-OB01`
 *
 * ใช้แบบเดียวกับ CG4.11: snapshot อ่านจากตารางใน transaction เดียวของ tenant (ไม่ใช่ counter ใน
 * memory ที่หายตอน restart) แล้วแปลงเป็น metric samples และ operational alerts. label มีเพียง
 * `tenant_id` กับ `source`/`state` ซึ่งเป็นค่าปิดชุด — ห้ามใส่ actor, reason หรือ exportId (`CG5-OB02`)
 *
 * operational alert ของไฟล์นี้แยกจาก anomaly rule ของ CG5.6: ตัวนี้บอกว่าระบบ CG5 เองป่วย ส่วน anomaly
 * บอกว่าพฤติกรรมการติดต่อของ tenant ผิดปกติ จึงใช้ prefix `GOVERNANCE_CG5_` ไม่ชนกับ rule code
 */

const READINESS_SOURCE_KEY = 'cg5.projection.readiness';
const ALERT_STATES = ['OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED'] as const;
const EXPORT_STATES = ['QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED', 'REVOKED'] as const;

export interface Cg5ObservabilitySnapshot {
  tenantId: string;
  observedAt: string;
  projection: {
    readiness: string;
    lagSloSeconds: number;
    /** อายุนับจากรอบประมวลผลล่าสุดของแต่ละแหล่ง — null คือยังไม่เคยรัน */
    sources: ReadonlyArray<{ source: string; lastRunAgeSeconds: number | null }>;
    newestBucketAgeSeconds: number | null;
    activeScopePauses: number;
    oldestScopePauseAgeSeconds: number | null;
  };
  alerts: {
    byState: Readonly<Record<(typeof ALERT_STATES)[number], number>>;
    transitionsInWindow: number;
  };
  exports: {
    byState: Readonly<Record<(typeof EXPORT_STATES)[number], number>>;
    oldestInFlightAgeSeconds: number | null;
    auditEventsInWindow: number;
    downloadsInWindow: number;
  };
  /** counter ของ process ที่ไม่มีแถวใน DB (เช่น ack conflict, cache fallback) — ผู้เรียกแนบมาเอง */
  process?: Readonly<Record<string, number>>;
}

const ageSeconds = (from: Date | null | undefined, now: Date): number | null =>
  from ? Math.max(0, Math.round((now.getTime() - from.getTime()) / 1_000)) : null;

function tally<T extends string>(
  keys: readonly T[],
  rows: ReadonlyArray<{ key: string; count: number }>,
): Record<T, number> {
  return Object.fromEntries(
    keys.map((key) => [key, rows.find((row) => row.key === key)?.count ?? 0]),
  ) as Record<T, number>;
}

export async function cg5ObservabilitySnapshot(
  database: PrismaClient,
  input: {
    tenantId: string;
    now?: Date;
    windowSeconds?: number;
    process?: Readonly<Record<string, number>>;
  },
): Promise<Cg5ObservabilitySnapshot> {
  const now = input.now ?? new Date();
  const tenantId = input.tenantId;
  const since = new Date(now.getTime() - (input.windowSeconds ?? 3_600) * 1_000);
  const { config } = await new PrismaCg5TenantConfigRepository(database).read(tenantId);
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const [
      cursors,
      newestBucket,
      activePauses,
      oldestPause,
      alertStates,
      transitions,
      exportStates,
      oldestInFlight,
      exportAudit,
      downloads,
    ] = await Promise.all([
      transaction.cg5ProjectionCursor.findMany({
        where: { tenantId },
        select: { sourceKey: true, state: true, lastRunAt: true },
        orderBy: { sourceKey: 'asc' },
      }),
      transaction.cg5MetricBucket.findFirst({
        where: { tenantId },
        orderBy: { updatedAt: 'desc' },
        select: { updatedAt: true },
      }),
      transaction.cgScopePause.count({
        where: { tenantId, consumerGroup: CG5_EVENT_METRICS_CONSUMER_GROUP, state: 'ACTIVE' },
      }),
      transaction.cgScopePause.findFirst({
        where: { tenantId, consumerGroup: CG5_EVENT_METRICS_CONSUMER_GROUP, state: 'ACTIVE' },
        orderBy: { pausedAt: 'asc' },
        select: { pausedAt: true },
      }),
      transaction.cg5AlertState.groupBy({
        by: ['state'],
        where: { tenantId },
        _count: { _all: true },
      }),
      transaction.cg5AlertTransition.count({ where: { tenantId, occurredAt: { gte: since } } }),
      transaction.cg5ExportJob.groupBy({
        by: ['state'],
        where: { tenantId },
        _count: { _all: true },
      }),
      transaction.cg5ExportJob.findFirst({
        where: { tenantId, state: { in: ['QUEUED', 'RUNNING'] } },
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
      transaction.cgAuditLog.count({
        where: { tenantId, action: { startsWith: 'CG5_EXPORT_' }, occurredAt: { gte: since } },
      }),
      transaction.cgAuditLog.count({
        where: { tenantId, action: 'CG5_EXPORT_DOWNLOADED', occurredAt: { gte: since } },
      }),
    ]);
    const readiness = cursors.find((cursor) => cursor.sourceKey === READINESS_SOURCE_KEY);
    return {
      tenantId,
      observedAt: now.toISOString(),
      projection: {
        readiness: readiness?.state ?? 'NOT_READY',
        lagSloSeconds: config.lagSloSeconds,
        sources: cursors
          .filter((cursor) => cursor.sourceKey !== READINESS_SOURCE_KEY)
          .map((cursor) => ({
            source: cursor.sourceKey,
            lastRunAgeSeconds: ageSeconds(cursor.lastRunAt, now),
          })),
        newestBucketAgeSeconds: ageSeconds(newestBucket?.updatedAt, now),
        activeScopePauses: activePauses,
        oldestScopePauseAgeSeconds: ageSeconds(oldestPause?.pausedAt, now),
      },
      alerts: {
        byState: tally(
          ALERT_STATES,
          alertStates.map((row) => ({ key: row.state, count: row._count._all })),
        ),
        transitionsInWindow: transitions,
      },
      exports: {
        byState: tally(
          EXPORT_STATES,
          exportStates.map((row) => ({ key: row.state, count: row._count._all })),
        ),
        oldestInFlightAgeSeconds: ageSeconds(oldestInFlight?.createdAt, now),
        auditEventsInWindow: exportAudit,
        downloadsInWindow: downloads,
      },
      ...(input.process ? { process: { ...input.process } } : {}),
    };
  });
}

// ── Metrics ──────────────────────────────────────────────────────────────────

export interface Cg5MetricSample {
  name: string;
  value: number;
  labels: Readonly<Record<string, string>>;
}

export function cg5MetricSamples(snapshot: Cg5ObservabilitySnapshot): Cg5MetricSample[] {
  const tenant = { tenant_id: snapshot.tenantId };
  const gauge = (
    name: string,
    value: number | null,
    labels: Record<string, string> = {},
  ): Cg5MetricSample => ({
    name: `cg5_${name}`,
    value: value ?? 0,
    labels: { ...tenant, ...labels },
  });
  return [
    gauge('projection_ready', snapshot.projection.readiness === 'READY' ? 1 : 0),
    ...snapshot.projection.sources.map(({ source, lastRunAgeSeconds }) =>
      gauge('projection_run_age_seconds', lastRunAgeSeconds, { source }),
    ),
    gauge('projection_newest_bucket_age_seconds', snapshot.projection.newestBucketAgeSeconds),
    gauge('projection_scope_pause_active_total', snapshot.projection.activeScopePauses),
    gauge('projection_scope_pause_age_seconds', snapshot.projection.oldestScopePauseAgeSeconds),
    ...Object.entries(snapshot.alerts.byState).map(([state, value]) =>
      gauge('alert_state_total', value, { state }),
    ),
    gauge('alert_transition_window_total', snapshot.alerts.transitionsInWindow),
    ...Object.entries(snapshot.exports.byState).map(([state, value]) =>
      gauge('export_job_total', value, { state }),
    ),
    gauge('export_in_flight_age_seconds', snapshot.exports.oldestInFlightAgeSeconds),
    gauge('export_audit_window_total', snapshot.exports.auditEventsInWindow),
    gauge('export_download_window_total', snapshot.exports.downloadsInWindow),
    ...Object.entries(snapshot.process ?? {}).map(([name, value]) =>
      gauge(`process_${name.replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}`, value),
    ),
  ];
}

// ── Operational alerts ───────────────────────────────────────────────────────

export interface Cg5OperationalThresholds {
  exportInFlightSeconds: number;
  scopePauseAgeSeconds: number;
}

export const CG5_DEFAULT_OPERATIONAL_THRESHOLDS: Readonly<Cg5OperationalThresholds> = Object.freeze(
  { exportInFlightSeconds: 30 * 60, scopePauseAgeSeconds: 10 * 60 },
);

export type Cg5OperationalAlertCode =
  | 'GOVERNANCE_CG5_PROJECTION_FAILED'
  | 'GOVERNANCE_CG5_PROJECTION_LAG'
  | 'GOVERNANCE_CG5_SCOPE_PAUSE_AGE'
  | 'GOVERNANCE_CG5_EXPORT_FAILED'
  | 'GOVERNANCE_CG5_EXPORT_STUCK';

export interface Cg5OperationalAlert {
  code: Cg5OperationalAlertCode;
  severity: 'WARNING' | 'CRITICAL';
  value: number;
  threshold: number;
}

export function evaluateCg5OperationalAlerts(
  snapshot: Cg5ObservabilitySnapshot,
  thresholds: Cg5OperationalThresholds = CG5_DEFAULT_OPERATIONAL_THRESHOLDS,
): Cg5OperationalAlert[] {
  const alerts: Cg5OperationalAlert[] = [];
  const over = (
    code: Cg5OperationalAlertCode,
    severity: Cg5OperationalAlert['severity'],
    value: number | null,
    threshold: number,
  ) => {
    if (value !== null && value > threshold) alerts.push({ code, severity, value, threshold });
  };
  over(
    'GOVERNANCE_CG5_PROJECTION_FAILED',
    'CRITICAL',
    snapshot.projection.readiness === 'FAILED' ? 1 : 0,
    0,
  );
  // SLO ของ lag ตั้งราย tenant (`lagSloSeconds`) — แหล่งที่ไม่เคยรันเลยนับว่าเกินทันที
  const runAges = snapshot.projection.sources.map(
    ({ lastRunAgeSeconds }) => lastRunAgeSeconds ?? Number.POSITIVE_INFINITY,
  );
  if (runAges.length > 0) {
    over(
      'GOVERNANCE_CG5_PROJECTION_LAG',
      'CRITICAL',
      Math.max(...runAges),
      snapshot.projection.lagSloSeconds,
    );
  }
  over(
    'GOVERNANCE_CG5_SCOPE_PAUSE_AGE',
    'WARNING',
    snapshot.projection.oldestScopePauseAgeSeconds,
    thresholds.scopePauseAgeSeconds,
  );
  over('GOVERNANCE_CG5_EXPORT_FAILED', 'WARNING', snapshot.exports.byState.FAILED, 0);
  over(
    'GOVERNANCE_CG5_EXPORT_STUCK',
    'WARNING',
    snapshot.exports.oldestInFlightAgeSeconds,
    thresholds.exportInFlightSeconds,
  );
  return alerts;
}
