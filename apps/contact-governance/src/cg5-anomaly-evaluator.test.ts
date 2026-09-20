import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluateCg5Anomaly } from './cg5-anomaly-evaluator.js';

const config = { lagSloSeconds: 300, anomalyMinimumVolume: 50 };
const observation = (overrides = {}) => ({
  ruleCode: 'CG5_BLOCK_RATE_SHIFT' as const,
  value: 200,
  baseline: 100,
  volume: 100,
  projectionLagSeconds: 0,
  scopePaused: false,
  ...overrides,
});

test('CG5.6 baseline rule ถูกระงับเมื่อ data gap หรือข้อมูลฐานไม่พอ', () => {
  assert.equal(
    evaluateCg5Anomaly(observation({ scopePaused: true }), config, null).state,
    'SUPPRESSED',
  );
  assert.equal(
    evaluateCg5Anomaly(observation({ baseline: null }), config, null).state,
    'SUPPRESSED',
  );
  assert.equal(evaluateCg5Anomaly(observation({ volume: 49 }), config, null).state, 'SUPPRESSED');
});

test('CG5.6 hysteresis คง alert ที่เปิดไว้จนต่ำกว่า close threshold', () => {
  assert.equal(evaluateCg5Anomaly(observation({ value: 151 }), config, null).state, 'OPEN');
  assert.equal(
    evaluateCg5Anomaly(observation({ value: 130 }), config, { state: 'OPEN', consecutiveHits: 3 })
      .state,
    'OPEN',
  );
  assert.equal(
    evaluateCg5Anomaly(observation({ value: 119 }), config, { state: 'OPEN', consecutiveHits: 3 })
      .state,
    'RESOLVED',
  );
});

test('CG5.6 projection lag เป็น fixed rule และไม่ถูก suppress', () => {
  assert.equal(
    evaluateCg5Anomaly(
      observation({ ruleCode: 'CG5_PROJECTION_LAG', projectionLagSeconds: 301 }),
      config,
      null,
    ).state,
    'OPEN',
  );
});
