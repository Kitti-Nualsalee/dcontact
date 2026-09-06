import assert from 'node:assert/strict';
import test from 'node:test';
import { PHASE_TWO_READINESS_CHECKS, phaseTwoSummary } from './phase-two-readiness.mjs';

test('Phase 2 orchestrator ต้อง gate Phase 1, browser, Keycloak, QM และ control boundary', () => {
  const serialized = JSON.stringify(PHASE_TWO_READINESS_CHECKS);
  for (const boundary of [
    'INBOUND_VOICE_PHASE_1_ACCEPTED',
    'Keycloak Organizations',
    'opaque Console context',
    'idempotent command',
    'force-safe',
    'Playwright Chromium',
  ]) {
    assert.match(serialized, new RegExp(boundary, 'i'));
  }
  assert.doesNotMatch(serialized, /production SLA/i);
});

test('Phase 2 marker ปรากฏเฉพาะเมื่อทุก gate ผ่าน', () => {
  assert.equal(
    phaseTwoSummary([{ status: 'PASS' }, { status: 'PASS' }]).entryCondition,
    'INBOUND_VOICE_PHASE_2_PILOT_READY',
  );
  assert.equal(
    phaseTwoSummary([{ status: 'PASS' }, { status: 'FAIL' }]).entryCondition,
    'NOT_READY',
  );
});
