import assert from 'node:assert/strict';
import test from 'node:test';
import { PHASE_ONE_READINESS_CHECKS, phaseOneSummary } from './phase-one-readiness.mjs';

test('Phase 1 readiness plan covers every acceptance boundary without claiming a production SLA', () => {
  const serialized = JSON.stringify(PHASE_ONE_READINESS_CHECKS);
  for (const boundary of [
    'direct queue',
    'IVR',
    'routing policy',
    'no-answer',
    'wrap-up',
    'supervisor control',
    'recording-to-QM human publish',
    'Thai baseline',
    'FAILED/retry/audit',
    'Keycloak Organizations',
    'API/event/persistence/signed playback isolation',
  ]) {
    assert.match(serialized, new RegExp(boundary.replaceAll('/', '\\/'), 'i'));
  }
  assert.doesNotMatch(serialized, /production SLA/i);
});

test('readiness summary only declares Phase 1 ready when every check passes', () => {
  assert.equal(
    phaseOneSummary([{ status: 'PASS' }, { status: 'PASS' }]).entryCondition,
    'INBOUND_VOICE_PHASE_1_ACCEPTED',
  );
  assert.equal(
    phaseOneSummary([{ status: 'PASS' }, { status: 'FAIL' }]).entryCondition,
    'NOT_READY',
  );
});
