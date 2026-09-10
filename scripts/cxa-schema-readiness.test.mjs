import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_CXA_TABLES, parseCanonicalSchemaEvidence } from './cxa-schema-readiness.mjs';

test('schema readiness ล็อก canonical Contact Governance/Journey/Delivery รวม command receipts และ facts', () => {
  assert.deepEqual(CANONICAL_CXA_TABLES, [
    'cg_attempts',
    'cg_consents',
    'cg_decision_logs',
    'cg_reservations',
    'cg_reservation_command_receipts',
    'cg_restrictions',
    'cg_touches',
    'dl_outbox_entries',
    'jr_actions',
    'jr_enrollments',
    'jr_event_inbox',
  ]);
});

test('schema evidence ผ่านเมื่อมี table, RLS และ tenant policy ครบทุกตารางเท่านั้น', () => {
  assert.deepEqual(parseCanonicalSchemaEvidence('11|11|11'), {
    tables: 11,
    rlsEnabled: 11,
    tenantPolicies: 11,
    status: 'PASS',
  });
  assert.deepEqual(parseCanonicalSchemaEvidence('11|10|11'), {
    tables: 11,
    rlsEnabled: 10,
    tenantPolicies: 11,
    status: 'FAIL',
  });
  assert.throws(() => parseCanonicalSchemaEvidence('unexpected'), /schema evidence/i);
});
