import assert from 'node:assert/strict';
import test from 'node:test';
import type { JourneyRun } from './journey-authoring/api.js';
import { runResult } from './journey-authoring/run-result.js';

const run = (overrides: Partial<JourneyRun> = {}): JourneyRun => ({
  enrollmentId: 'e',
  journeyVersion: 1,
  contactId: null,
  state: 'AUTHORIZED',
  runState: 'WAITING',
  terminalReason: null,
  startedAt: '2026-11-28T01:00:00.000Z',
  updatedAt: '2026-11-28T01:00:00.000Z',
  trigger: null,
  actions: [],
  ...overrides,
});
const action = (state: string) => ({
  stepId: 'ensure-case',
  kind: 'ENSURE_CASE',
  state,
  ownerAggregateId: null,
  acknowledgedAt: null,
});

test('a run reads as one result: the owner answer decides, a blocked or withdrawn enrollment wins', () => {
  assert.equal(runResult(run()), 'waiting');
  assert.equal(runResult(run({ actions: [action('PENDING')] })), 'waiting');
  assert.equal(runResult(run({ actions: [action('DISPATCHED')] })), 'waiting');
  assert.equal(runResult(run({ actions: [action('ACK_UNKNOWN')] })), 'waiting');
  assert.equal(runResult(run({ actions: [action('ACKNOWLEDGED')] })), 'done');
  assert.equal(runResult(run({ actions: [action('REJECTED')] })), 'rejected');
  assert.equal(runResult(run({ actions: [action('CANCELLED')] })), 'cancelled');
  assert.equal(runResult(run({ state: 'BLOCKED', runState: 'TERMINAL' })), 'blocked');
  assert.equal(
    runResult(
      run({ state: 'BLOCKED', terminalReason: 'CANCELLED', actions: [action('ACKNOWLEDGED')] }),
    ),
    'cancelled',
  );
});
