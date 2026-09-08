import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_CXA_TABLES, parseCanonicalSchemaEvidence } from './cxa-schema-readiness.mjs';

test('schema readiness ล็อก canonical Contact Governance และ Journey tables ครบห้าตาราง', () => {
  assert.deepEqual(CANONICAL_CXA_TABLES, [
    'cg_consents',
    'cg_decision_logs',
    'cg_reservations',
    'cg_restrictions',
    'jr_event_inbox',
  ]);
});

test('schema evidence ผ่านเมื่อมี table, RLS และ tenant policy ครบทุกตารางเท่านั้น', () => {
  assert.deepEqual(parseCanonicalSchemaEvidence('5|5|5'), {
    tables: 5,
    rlsEnabled: 5,
    tenantPolicies: 5,
    status: 'PASS',
  });
  assert.deepEqual(parseCanonicalSchemaEvidence('5|4|5'), {
    tables: 5,
    rlsEnabled: 4,
    tenantPolicies: 5,
    status: 'FAIL',
  });
  assert.throws(() => parseCanonicalSchemaEvidence('unexpected'), /schema evidence/i);
});
