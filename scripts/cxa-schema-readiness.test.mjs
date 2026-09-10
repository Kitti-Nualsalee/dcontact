import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_CXA_TABLES, parseCanonicalSchemaEvidence } from './cxa-schema-readiness.mjs';

test('schema readiness ล็อก canonical Contact Governance/Journey รวม command receipts และ facts', () => {
  assert.deepEqual(CANONICAL_CXA_TABLES, [
    'cg_attempts',
    'cg_consents',
    'cg_decision_logs',
    'cg_reservations',
    'cg_reservation_command_receipts',
    'cg_restrictions',
    'cg_touches',
    'jr_actions',
    'jr_enrollments',
    'jr_event_inbox',
  ]);
});

test('schema evidence ผ่านเมื่อมี table, RLS และ tenant policy ครบทุกตารางเท่านั้น', () => {
  assert.deepEqual(parseCanonicalSchemaEvidence('10|10|10'), {
    tables: 10,
    rlsEnabled: 10,
    tenantPolicies: 10,
    status: 'PASS',
  });
  assert.deepEqual(parseCanonicalSchemaEvidence('10|9|10'), {
    tables: 10,
    rlsEnabled: 9,
    tenantPolicies: 10,
    status: 'FAIL',
  });
  assert.throws(() => parseCanonicalSchemaEvidence('unexpected'), /schema evidence/i);
});
