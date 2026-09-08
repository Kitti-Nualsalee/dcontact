import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_CXA_TABLES, parseCanonicalSchemaEvidence } from './cxa-schema-readiness.mjs';

test('schema readiness ล็อก canonical Contact Governance และ Journey tables ครบเจ็ดตาราง', () => {
  assert.deepEqual(CANONICAL_CXA_TABLES, [
    'cg_consents',
    'cg_decision_logs',
    'cg_reservations',
    'cg_restrictions',
    'jr_actions',
    'jr_enrollments',
    'jr_event_inbox',
  ]);
});

test('schema evidence ผ่านเมื่อมี table, RLS และ tenant policy ครบทุกตารางเท่านั้น', () => {
  assert.deepEqual(parseCanonicalSchemaEvidence('7|7|7'), {
    tables: 7,
    rlsEnabled: 7,
    tenantPolicies: 7,
    status: 'PASS',
  });
  assert.deepEqual(parseCanonicalSchemaEvidence('7|6|7'), {
    tables: 7,
    rlsEnabled: 6,
    tenantPolicies: 7,
    status: 'FAIL',
  });
  assert.throws(() => parseCanonicalSchemaEvidence('unexpected'), /schema evidence/i);
});
