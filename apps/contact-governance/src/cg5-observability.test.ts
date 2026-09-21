import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cg5MetricSamples,
  evaluateCg5OperationalAlerts,
  type Cg5ObservabilitySnapshot,
} from './cg5-observability.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';

function snapshot(
  overrides: {
    projection?: Partial<Cg5ObservabilitySnapshot['projection']>;
    exports?: Partial<Cg5ObservabilitySnapshot['exports']>;
    process?: Record<string, number>;
  } = {},
): Cg5ObservabilitySnapshot {
  return {
    tenantId: TENANT,
    observedAt: '2026-09-21T00:00:00.000Z',
    projection: {
      readiness: 'READY',
      lagSloSeconds: 300,
      sources: [
        { source: 'cg5.incremental.decision', lastRunAgeSeconds: 30 },
        { source: 'cg5.incremental.attempt', lastRunAgeSeconds: 45 },
      ],
      newestBucketAgeSeconds: 30,
      activeScopePauses: 0,
      oldestScopePauseAgeSeconds: null,
      ...overrides.projection,
    },
    alerts: {
      byState: { OPEN: 1, ACKED: 2, RESOLVED: 3, SUPPRESSED: 4 },
      transitionsInWindow: 5,
    },
    exports: {
      byState: { QUEUED: 0, RUNNING: 0, READY: 2, FAILED: 0, EXPIRED: 1, REVOKED: 1 },
      oldestInFlightAgeSeconds: null,
      auditEventsInWindow: 7,
      downloadsInWindow: 2,
      ...overrides.exports,
    },
    ...(overrides.process ? { process: overrides.process } : {}),
  };
}

test('CG5-OB01 metric samples ครอบ projection, alert และ export ทุกสถานะ', () => {
  const samples = cg5MetricSamples(snapshot({ process: { 'ack.conflict': 3 } }));
  const value = (name: string, labels: Record<string, string> = {}) =>
    samples.find(
      (sample) =>
        sample.name === name &&
        Object.entries(labels).every(([key, expected]) => sample.labels[key] === expected),
    )?.value;

  assert.equal(value('cg5_projection_ready'), 1);
  assert.equal(value('cg5_projection_run_age_seconds', { source: 'cg5.incremental.attempt' }), 45);
  for (const state of ['OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED']) {
    assert.notEqual(value('cg5_alert_state_total', { state }), undefined, state);
  }
  assert.equal(value('cg5_alert_transition_window_total'), 5);
  for (const state of ['QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED', 'REVOKED']) {
    assert.notEqual(value('cg5_export_job_total', { state }), undefined, state);
  }
  assert.equal(value('cg5_export_audit_window_total'), 7);
  assert.equal(value('cg5_export_download_window_total'), 2);
  assert.equal(value('cg5_process_ack_conflict'), 3);
});

test('CG5-OB02 label ของ telemetry มีแค่ tenant และค่าปิดชุด ไม่มี actor/reason/export id', () => {
  const allowed = new Set(['tenant_id', 'source', 'state']);
  for (const sample of cg5MetricSamples(snapshot())) {
    assert.match(sample.name, /^cg5_[a-z0-9_]+$/);
    for (const key of Object.keys(sample.labels)) assert.ok(allowed.has(key), key);
    assert.equal(sample.labels.tenant_id, TENANT);
  }
});

test('CG5-OB01 ระบบปกติไม่มี operational alert', () => {
  assert.deepEqual(evaluateCg5OperationalAlerts(snapshot()), []);
});

test('CG5-OB01 lag เทียบ SLO ราย tenant และแหล่งที่ไม่เคยรันถือว่าเกิน', () => {
  const codes = (value: Cg5ObservabilitySnapshot) =>
    evaluateCg5OperationalAlerts(value).map(({ code, severity }) => `${code}:${severity}`);
  assert.deepEqual(
    codes(
      snapshot({
        projection: { sources: [{ source: 'cg5.incremental.decision', lastRunAgeSeconds: 301 }] },
      }),
    ),
    ['GOVERNANCE_CG5_PROJECTION_LAG:CRITICAL'],
  );
  assert.deepEqual(
    codes(
      snapshot({
        projection: {
          lagSloSeconds: 900,
          sources: [{ source: 'cg5.incremental.decision', lastRunAgeSeconds: 301 }],
        },
      }),
    ),
    [],
  );
  assert.deepEqual(
    codes(
      snapshot({
        projection: { sources: [{ source: 'cg5.incremental.touch', lastRunAgeSeconds: null }] },
      }),
    ),
    ['GOVERNANCE_CG5_PROJECTION_LAG:CRITICAL'],
  );
});

test('CG5-OB01 projection ล้ม, scope pause ค้าง และ export ล้ม/ค้าง ถูกเตือน', () => {
  const alerts = evaluateCg5OperationalAlerts(
    snapshot({
      projection: {
        readiness: 'FAILED',
        activeScopePauses: 1,
        oldestScopePauseAgeSeconds: 601,
      },
      exports: {
        byState: { QUEUED: 1, RUNNING: 0, READY: 0, FAILED: 2, EXPIRED: 0, REVOKED: 0 },
        oldestInFlightAgeSeconds: 1_801,
      },
    }),
  );
  assert.deepEqual(
    alerts.map(({ code }) => code),
    [
      'GOVERNANCE_CG5_PROJECTION_FAILED',
      'GOVERNANCE_CG5_SCOPE_PAUSE_AGE',
      'GOVERNANCE_CG5_EXPORT_FAILED',
      'GOVERNANCE_CG5_EXPORT_STUCK',
    ],
  );
  assert.equal(alerts[0]?.severity, 'CRITICAL');
});
