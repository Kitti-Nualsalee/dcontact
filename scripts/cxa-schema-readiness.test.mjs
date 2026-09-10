import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_CXA_TABLES, parseCanonicalSchemaEvidence } from './cxa-schema-readiness.mjs';

test('schema readiness ล็อก canonical Contact Governance/Journey/Delivery รวม command receipts, facts และ durable execution', () => {
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
    'jr_schedule_occurrences',
    'jr_step_runs',
  ]);
});

test('schema evidence ผ่านเมื่อมี table, RLS และ tenant policy ครบทุกตารางเท่านั้น', () => {
  assert.deepEqual(parseCanonicalSchemaEvidence('13|13|13'), {
    tables: 13,
    rlsEnabled: 13,
    tenantPolicies: 13,
    status: 'PASS',
  });
  assert.deepEqual(parseCanonicalSchemaEvidence('13|12|13'), {
    tables: 13,
    rlsEnabled: 12,
    tenantPolicies: 13,
    status: 'FAIL',
  });
  assert.throws(() => parseCanonicalSchemaEvidence('unexpected'), /schema evidence/i);
});
