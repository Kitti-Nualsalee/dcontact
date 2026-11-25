import assert from 'node:assert/strict';
import test from 'node:test';
import { CANONICAL_CXA_TABLES, parseCanonicalSchemaEvidence } from './cxa-schema-readiness.mjs';

test('schema readiness locks canonical Contact Governance/Journey/Delivery including command receipts, facts and durable execution', () => {
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
    'jr_journey_definitions',
    'jr_schedule_occurrences',
    'jr_step_runs',
  ]);
});

test('schema evidence passes only when every table has its table, RLS and tenant policy', () => {
  assert.deepEqual(parseCanonicalSchemaEvidence('14|14|14'), {
    tables: 14,
    rlsEnabled: 14,
    tenantPolicies: 14,
    status: 'PASS',
  });
  assert.deepEqual(parseCanonicalSchemaEvidence('14|12|14'), {
    tables: 14,
    rlsEnabled: 12,
    tenantPolicies: 14,
    status: 'FAIL',
  });
  assert.throws(() => parseCanonicalSchemaEvidence('unexpected'), /schema evidence/i);
});
