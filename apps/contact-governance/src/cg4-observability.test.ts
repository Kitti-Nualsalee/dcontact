import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cg4MetricSamples,
  evaluateCg4Alerts,
  type Cg4ObservabilitySnapshot,
} from './cg4-observability.js';

const TENANT = '00000000-0000-0000-0000-00000000000a';

function snapshot(overrides: Partial<Cg4ObservabilitySnapshot> = {}): Cg4ObservabilitySnapshot {
  return {
    tenantId: TENANT,
    observedAt: '2026-09-15T00:00:00.000Z',
    rollout: {
      stage: 'DISABLED',
      mutationFrozen: false,
      shadowMismatchesInWindow: 0,
      shadowMismatchesTotal: 0,
    },
    quorum: {
      pendingExceptions: 0,
      oldestPendingExceptionAgeSeconds: null,
      policiesInReview: 0,
      oldestPolicyInReviewAgeSeconds: null,
      staleApprovals: 0,
    },
    activation: { dueBacklog: 0, oldestDueLagSeconds: null, failedJobs: 0 },
    exceptions: { approved: 0, expired: 0, revoked: 0 },
    killSwitches: { active: 0 },
    events: { pendingOutbox: 0, oldestPendingOutboxAgeSeconds: null, quarantinedOutbox: 0 },
    consumers: {
      gapHeld: 0,
      outOfOrder: 0,
      quarantined: 0,
      unsupported: 0,
      activeScopePauses: 0,
      oldestActivePauseAgeSeconds: null,
    },
    acknowledgements: { failed: 0, quarantined: 0, oldestUnacknowledgedEventAgeSeconds: null },
    ...overrides,
  };
}

test('CG4-OB01: สถานะปกติไม่มี alert', () => {
  assert.deepEqual(evaluateCg4Alerts(snapshot()), []);
});

test('CG4-OB01: alert ครอบ conflict/quorum/activation/cache gap/ack/DLQ/kill/migration ตาม #179 §7', () => {
  const alerts = evaluateCg4Alerts(
    snapshot({
      rollout: {
        stage: 'SHADOW_EVALUATION',
        mutationFrozen: true,
        shadowMismatchesInWindow: 2,
        shadowMismatchesTotal: 3,
      },
      quorum: {
        pendingExceptions: 1,
        oldestPendingExceptionAgeSeconds: 90_000,
        policiesInReview: 0,
        oldestPolicyInReviewAgeSeconds: null,
        staleApprovals: 1,
      },
      activation: { dueBacklog: 1, oldestDueLagSeconds: 600, failedJobs: 1 },
      exceptions: { approved: 1, expired: 1, revoked: 1 },
      killSwitches: { active: 1 },
      events: { pendingOutbox: 3, oldestPendingOutboxAgeSeconds: 900, quarantinedOutbox: 1 },
      consumers: {
        gapHeld: 1,
        outOfOrder: 0,
        quarantined: 0,
        unsupported: 0,
        activeScopePauses: 1,
        oldestActivePauseAgeSeconds: 1_200,
      },
      acknowledgements: { failed: 1, quarantined: 0, oldestUnacknowledgedEventAgeSeconds: 1_200 },
    }),
  );
  assert.deepEqual(alerts.map((alert) => alert.code).sort(), [
    'GOVERNANCE_ACK_FAILED',
    'GOVERNANCE_ACK_LAG',
    'GOVERNANCE_ACTIVATION_FAILED',
    'GOVERNANCE_ACTIVATION_LAG',
    'GOVERNANCE_CONSUMER_GAP_OR_DLQ',
    'GOVERNANCE_EVENT_QUARANTINED',
    'GOVERNANCE_KILL_SWITCH_ACTIVE',
    'GOVERNANCE_MIGRATION_MISMATCH',
    'GOVERNANCE_MUTATION_FROZEN',
    'GOVERNANCE_OUTBOX_LAG',
    'GOVERNANCE_QUORUM_WAIT_AGE',
    'GOVERNANCE_SCOPE_PAUSE_AGE',
    'GOVERNANCE_STALE_APPROVAL',
  ]);
  assert.equal(
    alerts.find((alert) => alert.code === 'GOVERNANCE_ACTIVATION_LAG')?.severity,
    'CRITICAL',
  );
  assert.equal(alerts.find((alert) => alert.code === 'GOVERNANCE_MIGRATION_MISMATCH')?.value, 2);
});

test('CG4-OB02: metric samples มีชื่อไม่ซ้ำและ label เป็น tenant_id อย่างเดียว', () => {
  const samples = cg4MetricSamples(snapshot({ cache: { headMiss: 2, 'canonical-fallback': 1 } }));
  assert.equal(new Set(samples.map((sample) => sample.name)).size, samples.length);
  for (const sample of samples) {
    assert.match(sample.name, /^cg4_[a-z0-9_]+$/);
    assert.deepEqual(Object.keys(sample.labels), ['tenant_id']);
    assert.equal(sample.labels.tenant_id, TENANT);
    assert.equal(Number.isFinite(sample.value), true);
  }
  assert.ok(samples.some((sample) => sample.name === 'cg4_cache_canonical_fallback'));
});
