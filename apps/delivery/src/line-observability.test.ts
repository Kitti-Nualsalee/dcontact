import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateLineAlerts,
  lineMetricSamples,
  type LineObservabilitySnapshot,
} from './line-observability.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';

function snapshot(overrides: Partial<LineObservabilitySnapshot> = {}): LineObservabilitySnapshot {
  return {
    tenantId: TENANT,
    observedAt: '2026-09-23T00:00:00.000Z',
    windowSeconds: 3_600,
    settlement: { inFlight: 0, reconciling: 0, oldestInFlightAgeSeconds: null },
    provider: {
      authInvalid: 0,
      quotaExhausted: 0,
      rateLimited: 0,
      unavailable: 0,
      retryWindowExpired: 0,
    },
    webhook: {
      pending: 0,
      oldestPendingAgeSeconds: null,
      quarantined: 0,
      ingress: { signatureInvalid: 0, durabilityUnavailable: 0 },
    },
    correlation: { pending: 0, quarantined: 0 },
    control: {
      killedScopes: 0,
      automaticKills: 0,
      technicalSwitchOn: 0,
      runDenials: 0,
      capReservationsHeld: 0,
    },
    events: { pending: 0, oldestPendingAgeSeconds: null, failed: 0 },
    ...overrides,
  };
}

test('S2-LINE-OB01: สถานะปกติไม่มี alert', () => {
  assert.deepEqual(evaluateLineAlerts(snapshot()), []);
});

test('S2-LINE-OB01: stuck settlement, signature, cap, quota, auth และ kill มี alert ของตัวเอง', () => {
  const alerts = evaluateLineAlerts(
    snapshot({
      settlement: { inFlight: 1, reconciling: 1, oldestInFlightAgeSeconds: 1_900 },
      provider: {
        authInvalid: 1,
        quotaExhausted: 1,
        rateLimited: 1,
        unavailable: 2,
        retryWindowExpired: 1,
      },
      webhook: {
        pending: 1,
        oldestPendingAgeSeconds: 400,
        quarantined: 1,
        ingress: { signatureInvalid: 3, durabilityUnavailable: 1 },
      },
      correlation: { pending: 1, quarantined: 1 },
      control: {
        killedScopes: 2,
        automaticKills: 1,
        technicalSwitchOn: 0,
        runDenials: 2,
        capReservationsHeld: 1,
      },
      events: { pending: 1, oldestPendingAgeSeconds: 400, failed: 1 },
    }),
  );
  const bySeverity = Object.fromEntries(alerts.map((alert) => [alert.code, alert.severity]));
  assert.deepEqual(bySeverity, {
    LINE_SETTLEMENT_STUCK: 'CRITICAL',
    LINE_UNKNOWN_RECONCILING: 'WARNING',
    LINE_RETRY_WINDOW_EXPIRED: 'CRITICAL',
    LINE_AUTH_FAILURE: 'CRITICAL',
    LINE_QUOTA_EXHAUSTED: 'CRITICAL',
    LINE_RATE_LIMITED: 'WARNING',
    LINE_WEBHOOK_SIGNATURE_INVALID: 'WARNING',
    LINE_WEBHOOK_DURABILITY_UNAVAILABLE: 'CRITICAL',
    LINE_WEBHOOK_BACKLOG: 'WARNING',
    LINE_WEBHOOK_QUARANTINED: 'WARNING',
    LINE_TOUCH_CORRELATION_QUARANTINED: 'WARNING',
    LINE_CAP_OR_RUN_DENIED: 'WARNING',
    LINE_AUTOMATIC_KILL: 'CRITICAL',
    LINE_SCOPE_KILLED: 'WARNING',
    LINE_EVENT_OUTBOX_LAG: 'WARNING',
    LINE_EVENT_OUTBOX_FAILED: 'CRITICAL',
  });
});

test('S2-LINE-OB01: settlement ที่ยังอยู่ใน backoff ไม่ถือว่าค้าง และไม่มี ingress counter = ไม่ alert', () => {
  const alerts = evaluateLineAlerts(
    snapshot({
      settlement: { inFlight: 1, reconciling: 0, oldestInFlightAgeSeconds: 900 },
      webhook: { pending: 0, oldestPendingAgeSeconds: null, quarantined: 0, ingress: null },
    }),
  );
  assert.deepEqual(alerts, []);
});

test('S2-LINE-OB01: metric มี label แค่ tenant_id และชื่อขึ้นต้น line_', () => {
  const samples = lineMetricSamples(snapshot());
  assert.ok(samples.length > 20);
  for (const sample of samples) {
    assert.match(sample.name, /^line_[a-z0-9_]+$/);
    assert.deepEqual(Object.keys(sample.labels), ['tenant_id']);
    assert.equal(typeof sample.value, 'number');
  }
  assert.equal(new Set(samples.map(({ name }) => name)).size, samples.length);
});
