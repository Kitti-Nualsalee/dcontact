import assert from 'node:assert/strict';
import test from 'node:test';
import { CXA_PHASE_ONE_READINESS_CHECKS, cxaPhaseOneSummary } from './cxa-phase-one-readiness.mjs';

test('CX Automation Phase 1 gate ครบ regression, schema, governance, ingress, Kafka และ two-tenant journey', () => {
  assert.equal(CXA_PHASE_ONE_READINESS_CHECKS[0]?.id, 'phase-two-regression');
  const serialized = JSON.stringify(CXA_PHASE_ONE_READINESS_CHECKS);
  for (const boundary of [
    'INBOUND_VOICE_PHASE_2_PILOT_READY',
    'fresh database',
    'RLS',
    'authorizeAndReserve',
    'durable event inbox',
    'OAuth2 client_credentials',
    'Kafka recovery',
    'IDENTITY_AMBIGUOUS',
    'decision/reservation link',
    'two tenant',
  ]) {
    assert.match(serialized, new RegExp(boundary, 'i'));
  }
  assert.doesNotMatch(serialized, /production SLA/i);
});

test('CX Automation Phase 1 marker ปรากฏเฉพาะเมื่อทุก gate ผ่าน', () => {
  assert.equal(
    cxaPhaseOneSummary([{ status: 'PASS' }, { status: 'PASS' }]).entryCondition,
    'CX_AUTOMATION_PHASE_1_ACCEPTED',
  );
  assert.equal(
    cxaPhaseOneSummary([{ status: 'PASS' }, { status: 'FAIL' }]).entryCondition,
    'NOT_READY',
  );
});
