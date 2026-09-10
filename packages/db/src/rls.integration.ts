import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(process.cwd(), '../..');

function queryAsApplicationRole(sql: string): string {
  const compactSql = sql.replace(/\s+/g, ' ').trim();
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker/docker-compose.dev.yml',
      'exec',
      '-T',
      'postgres',
      'sh',
      '-c',
      `PGPASSWORD=dcontact_app psql -h 127.0.0.1 -U dcontact_app -d dcontact -tAc ${JSON.stringify(compactSql)}`,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim();
}

function queryAsOwner(sql: string): string {
  return execFileSync(
    'docker',
    [
      'compose',
      '-f',
      'infra/docker/docker-compose.dev.yml',
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'dcontact',
      '-d',
      'dcontact',
      '-tAc',
      sql,
    ],
    { cwd: repositoryRoot, encoding: 'utf8' },
  ).trim();
}

test('dcontact_app RLS denies queue data without or with an incorrect tenant context', () => {
  assert.equal(queryAsApplicationRole('SELECT count(*) FROM queues;'), '0');
  assert.match(
    queryAsApplicationRole(
      "BEGIN; SELECT set_config('app.tenant_id', '00000000-0000-0000-0000-000000000000', true); SELECT count(*) FROM queues; COMMIT;",
    ),
    /\n0\nCOMMIT$/,
  );
});

test('dcontact_app RLS permits the seeded demo tenant only after its context is set', () => {
  const result = queryAsApplicationRole(
    "BEGIN; SELECT set_config('app.tenant_id', (SELECT id::text FROM tenants WHERE slug = 'demo'), true); SELECT count(*) FROM queues; COMMIT;",
  );

  assert.match(result, /\n[1-9]\d*\nCOMMIT$/);
});

test('dcontact_app cannot read or mutate a second tenant queue', (t) => {
  const tenantId = randomUUID();
  const queueId = randomUUID();
  const suffix = tenantId.slice(0, 8);
  queryAsOwner(
    `INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'RLS test ${suffix}', 'rls-${suffix}', 'rls-${suffix}.test'); INSERT INTO queues (id, tenant_id, name, channels) VALUES ('${queueId}', '${tenantId}', 'RLS queue', ARRAY['VOICE']::"ChannelType"[]);`,
  );
  t.after(() =>
    queryAsOwner(
      `DELETE FROM queues WHERE tenant_id = '${tenantId}'; DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );
  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");

  const hiddenAndProtected = queryAsApplicationRole(
    `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM queues WHERE id = '${queueId}'; UPDATE queues SET name = 'cross-tenant mutation' WHERE id = '${queueId}'; COMMIT;`,
  );
  const visibleToOwnerTenant = queryAsApplicationRole(
    `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); SELECT count(*) FROM queues WHERE id = '${queueId}'; COMMIT;`,
  );

  assert.match(hiddenAndProtected, /\n0\nUPDATE 0\nCOMMIT$/);
  assert.match(visibleToOwnerTenant, /\n1\nCOMMIT$/);
});

test('dcontact_app แยก Contact Governance และ Journey rows ระหว่าง tenant', (t) => {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const identityId = randomUUID();
  const restrictionId = randomUUID();
  const consentId = randomUUID();
  const decisionId = randomUUID();
  const reservationId = randomUUID();
  const inboxId = randomUUID();
  const enrollmentId = randomUUID();
  const actionId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'CXA RLS ${suffix}', 'cxa-rls-${suffix}', 'cxa-rls-${suffix}.test');
     INSERT INTO contacts (id, tenant_id, display_name) VALUES ('${contactId}', '${tenantId}', 'CXA RLS contact');
     INSERT INTO contact_identities (id, tenant_id, contact_id, type, value) VALUES ('${identityId}', '${tenantId}', '${contactId}', 'EMAIL', 'cxa-rls-${suffix}@example.test');
     INSERT INTO cg_restrictions (id, tenant_id, contact_id, type, scope, overridable, reason_code, source, starts_at, created_by) VALUES ('${restrictionId}', '${tenantId}', '${contactId}', 'DNC', 'CONTACT', false, 'DNC_GLOBAL', 'TEST', now(), 'integration-test');
     INSERT INTO cg_consents (id, tenant_id, contact_id, purpose, channel, status, lawful_basis, evidence, updated_at) VALUES ('${consentId}', '${tenantId}', '${contactId}', 'MARKETING', 'EMAIL', 'REVOKED', 'CONSENT', '{}', now());
     INSERT INTO cg_reservations (id, tenant_id, contact_id, channel, purpose, source, source_id, action_key, input_hash, state, expires_at, updated_at) VALUES ('${reservationId}', '${tenantId}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'journey-001', 'enrollment-001:1:step-001', 'hash-001', 'RESERVED', now() + interval '15 minutes', now());
     INSERT INTO cg_decision_logs (id, tenant_id, contact_id, channel, purpose, source, source_id, action_key, decision, reason_code, policy_version, gate, trace, reservation_id) VALUES ('${decisionId}', '${tenantId}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'journey-001', 'enrollment-001:1:step-001', 'ALLOW', 'POLICY_PASSED', 1, 'CONSENT', '[]', '${reservationId}');
     INSERT INTO jr_event_inbox (id, tenant_id, source, event_id, event_type, occurred_at, payload, payload_hash, state, updated_at) VALUES ('${inboxId}', '${tenantId}', 'billing', 'event-001', 'PAYMENT_DUE', now(), '{}', 'payload-hash-001', 'PENDING', now());
     INSERT INTO jr_enrollments (id, tenant_id, event_inbox_id, journey_version, contact_id, decision_id, state, updated_at) VALUES ('${enrollmentId}', '${tenantId}', '${inboxId}', 1, '${contactId}', '${decisionId}', 'AUTHORIZED', now());
     INSERT INTO jr_actions (id, tenant_id, enrollment_id, action_key, contact_id, identity_id, channel, purpose, decision_id, reservation_id) VALUES ('${actionId}', '${tenantId}', '${enrollmentId}', 'enrollment-001:1:step-001', '${contactId}', '${identityId}', 'EMAIL', 'MARKETING', '${decisionId}', '${reservationId}');
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM jr_actions WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_enrollments WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_event_inbox WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_decision_logs WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_reservations WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_consents WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_restrictions WHERE tenant_id = '${tenantId}';
       DELETE FROM contact_identities WHERE tenant_id = '${tenantId}';
       DELETE FROM contacts WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  const hiddenAndProtected = queryAsApplicationRole(
    `BEGIN;
     SELECT set_config('app.tenant_id', '${demoTenantId}', true);
     SELECT (SELECT count(*) FROM cg_restrictions WHERE id = '${restrictionId}'),
            (SELECT count(*) FROM cg_consents WHERE id = '${consentId}'),
            (SELECT count(*) FROM cg_decision_logs WHERE id = '${decisionId}'),
            (SELECT count(*) FROM cg_reservations WHERE id = '${reservationId}'),
            (SELECT count(*) FROM jr_event_inbox WHERE id = '${inboxId}'),
            (SELECT count(*) FROM jr_enrollments WHERE id = '${enrollmentId}'),
            (SELECT count(*) FROM jr_actions WHERE id = '${actionId}');
     UPDATE cg_restrictions SET reason_code = 'CROSS_TENANT' WHERE id = '${restrictionId}';
     UPDATE cg_consents SET lawful_basis = 'CROSS_TENANT' WHERE id = '${consentId}';
     UPDATE cg_reservations SET state = 'RELEASED' WHERE id = '${reservationId}';
     UPDATE jr_event_inbox SET state = 'FAILED' WHERE id = '${inboxId}';
     UPDATE jr_enrollments SET state = 'BLOCKED' WHERE id = '${enrollmentId}';
     UPDATE jr_actions SET purpose = 'CROSS_TENANT' WHERE id = '${actionId}';
     COMMIT;`,
  );
  const visibleToOwnerTenant = queryAsApplicationRole(
    `BEGIN;
     SELECT set_config('app.tenant_id', '${tenantId}', true);
     SELECT (SELECT count(*) FROM cg_restrictions),
            (SELECT count(*) FROM cg_consents),
            (SELECT count(*) FROM cg_decision_logs),
            (SELECT count(*) FROM cg_reservations),
            (SELECT count(*) FROM jr_event_inbox),
            (SELECT count(*) FROM jr_enrollments),
            (SELECT count(*) FROM jr_actions);
     COMMIT;`,
  );

  assert.match(
    hiddenAndProtected,
    /\n0\|0\|0\|0\|0\|0\|0\nUPDATE 0\nUPDATE 0\nUPDATE 0\nUPDATE 0\nUPDATE 0\nUPDATE 0\nCOMMIT$/,
  );
  assert.match(visibleToOwnerTenant, /\n1\|1\|1\|1\|1\|1\|1\nCOMMIT$/);
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE cg_decision_logs SET reason_code = 'MUTATED' WHERE id = '${decisionId}'; COMMIT;`,
      ),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(
        String((error as Error & { stderr?: string | Buffer }).stderr ?? error.message),
        /permission denied/i,
      );
      return true;
    },
  );
});

test('cg_attempts/cg_touches บังคับ tenant RLS, composite binding และ immutable application grants', (t) => {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const reservationId = randomUUID();
  const attemptId = randomUUID();
  const touchId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'CG fact RLS ${suffix}', 'cg-fact-rls-${suffix}', 'cg-fact-rls-${suffix}.test');
     INSERT INTO contacts (id, tenant_id, display_name) VALUES ('${contactId}', '${tenantId}', 'CG fact RLS contact');
     INSERT INTO cg_reservations (id, tenant_id, contact_id, channel, purpose, source, source_id, action_key, input_hash, state, expires_at, updated_at) VALUES ('${reservationId}', '${tenantId}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'journey-c1-1', 'action-${suffix}', 'hash-${suffix}', 'RESERVED', now() + interval '15 minutes', now());
     INSERT INTO cg_attempts (id, tenant_id, reservation_id, delivery_id, outcome_ref, contact_id, channel, purpose, source, outcome, occurred_at, correlation_id) VALUES ('${attemptId}', '${tenantId}', '${reservationId}', 'delivery-${suffix}', 'outcome-${suffix}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'DELIVERED', now(), 'correlation-${suffix}');
     INSERT INTO cg_touches (id, tenant_id, attempt_id, reservation_id, delivery_id, outcome_ref, contact_id, channel, purpose, source, outcome, occurred_at, correlation_id) VALUES ('${touchId}', '${tenantId}', '${attemptId}', '${reservationId}', 'delivery-${suffix}', 'outcome-${suffix}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'DELIVERED', now(), 'correlation-${suffix}');
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM cg_touches WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_attempts WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_reservations WHERE tenant_id = '${tenantId}';
       DELETE FROM contacts WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT (SELECT count(*) FROM cg_attempts WHERE id = '${attemptId}'), (SELECT count(*) FROM cg_touches WHERE id = '${touchId}'); COMMIT;`,
    ),
    /\n0\|0\nCOMMIT$/,
  );
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); SELECT (SELECT count(*) FROM cg_attempts WHERE id = '${attemptId}'), (SELECT count(*) FROM cg_touches WHERE id = '${touchId}'); COMMIT;`,
    ),
    /\n1\|1\nCOMMIT$/,
  );

  for (const mutation of [
    `UPDATE cg_attempts SET outcome = 'DELIVERY_FAILED' WHERE id = '${attemptId}'`,
    `DELETE FROM cg_touches WHERE id = '${touchId}'`,
  ]) {
    assert.throws(
      () =>
        queryAsApplicationRole(
          `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${mutation}; COMMIT;`,
        ),
      /permission denied/i,
    );
  }

  assert.throws(
    () =>
      queryAsOwner(
        `INSERT INTO cg_attempts (id, tenant_id, reservation_id, delivery_id, outcome_ref, contact_id, channel, purpose, source, outcome, occurred_at, correlation_id) VALUES ('${randomUUID()}', '${demoTenantId}', '${reservationId}', 'delivery-swap', 'outcome-swap', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'DELIVERED', now(), 'correlation-swap');`,
      ),
    /foreign key constraint/i,
  );

  assert.equal(
    queryAsOwner(
      "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('cg_attempts', 'cg_touches') AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;",
    ),
    '2',
  );
});

test('cg reservation command receipts บังคับ tenant RLS และเป็น append-only สำหรับ application role', (t) => {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const reservationId = randomUUID();
  const receiptId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'CG receipt RLS ${suffix}', 'cg-receipt-rls-${suffix}', 'cg-receipt-rls-${suffix}.test');
     INSERT INTO contacts (id, tenant_id, display_name) VALUES ('${contactId}', '${tenantId}', 'CG receipt RLS contact');
     INSERT INTO cg_reservations (id, tenant_id, contact_id, channel, purpose, source, source_id, action_key, input_hash, state, expires_at, updated_at) VALUES ('${reservationId}', '${tenantId}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'journey-c1-2', 'action-${suffix}', 'hash-${suffix}', 'RESERVED', now() + interval '15 minutes', now());
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM cg_reservation_command_receipts WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_reservations WHERE tenant_id = '${tenantId}';
       DELETE FROM contacts WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO cg_reservation_command_receipts (id, tenant_id, reservation_id, operation, idempotency_key, input_hash, response) VALUES ('${receiptId}', '${tenantId}', '${reservationId}', 'CLAIM', 'claim-${suffix}', 'canonical-hash', '{}');
       SELECT count(*) FROM cg_reservation_command_receipts WHERE id = '${receiptId}';
       COMMIT;`,
    ),
    /\nINSERT 0 1\n1\nCOMMIT$/,
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM cg_reservation_command_receipts WHERE id = '${receiptId}'; COMMIT;`,
    ),
    /\n0\nCOMMIT$/,
  );

  for (const mutation of [
    `UPDATE cg_reservation_command_receipts SET input_hash = 'mutated' WHERE id = '${receiptId}'`,
    `DELETE FROM cg_reservation_command_receipts WHERE id = '${receiptId}'`,
  ]) {
    assert.throws(
      () =>
        queryAsApplicationRole(
          `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${mutation}; COMMIT;`,
        ),
      /permission denied/i,
    );
  }

  assert.equal(
    queryAsOwner(
      "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'cg_reservation_command_receipts' AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;",
    ),
    '1',
  );
});

test('jr schedule occurrences และ step runs บังคับ tenant RLS และเป็น durable evidence', (t) => {
  const tenantId = randomUUID();
  const journeyId = randomUUID();
  const occurrenceId = randomUUID();
  const enrollmentId = randomUUID();
  const stepRunId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'JR exec RLS ${suffix}', 'jr-exec-rls-${suffix}', 'jr-exec-rls-${suffix}.test');
     INSERT INTO jr_schedule_occurrences (id, tenant_id, journey_id, journey_version, occurrence_at, state, correlation_id) VALUES ('${occurrenceId}', '${tenantId}', '${journeyId}', 1, now(), 'CLAIMED', 'corr-${suffix}');
     INSERT INTO jr_enrollments (id, tenant_id, occurrence_id, journey_id, journey_version, state, run_state, current_step_id, step_sequence, updated_at) VALUES ('${enrollmentId}', '${tenantId}', '${occurrenceId}', '${journeyId}', 1, 'PENDING', 'RUNNING', 'entry', 0, now());
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM jr_step_runs WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_enrollments WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_schedule_occurrences WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO jr_step_runs (id, tenant_id, enrollment_id, step_sequence, step_id, step_type, state, correlation_id, started_at) VALUES ('${stepRunId}', '${tenantId}', '${enrollmentId}', 1, 'entry', 'BRANCH', 'COMPLETED', 'corr-${suffix}', now());
       SELECT count(*) FROM jr_step_runs WHERE id = '${stepRunId}';
       COMMIT;`,
    ),
    /\nINSERT 0 1\n1\nCOMMIT$/,
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  for (const table of ['jr_step_runs', 'jr_schedule_occurrences']) {
    assert.match(
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM ${table} WHERE tenant_id = '${tenantId}'; COMMIT;`,
      ),
      /\n0\nCOMMIT$/,
    );
  }

  // occurrence เดินสถานะได้ แต่ step run เป็น ledger ที่แก้ไม่ได้
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE jr_schedule_occurrences SET state = 'ENROLLED' WHERE id = '${occurrenceId}'; COMMIT;`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );
  for (const mutation of [
    `UPDATE jr_step_runs SET step_id = 'mutated' WHERE id = '${stepRunId}'`,
    `DELETE FROM jr_step_runs WHERE id = '${stepRunId}'`,
    `DELETE FROM jr_schedule_occurrences WHERE id = '${occurrenceId}'`,
  ]) {
    assert.throws(
      () =>
        queryAsApplicationRole(
          `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${mutation}; COMMIT;`,
        ),
      /permission denied/i,
    );
  }

  assert.equal(
    queryAsOwner(
      "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN ('jr_schedule_occurrences', 'jr_step_runs') AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;",
    ),
    '2',
  );
});
