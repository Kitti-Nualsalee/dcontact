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

test('dl outbox entries บังคับ tenant RLS และห้าม application role ลบ delivery ที่ claim แล้ว', (t) => {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const reservationId = randomUUID();
  const entryId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'DL outbox RLS ${suffix}', 'dl-outbox-rls-${suffix}', 'dl-outbox-rls-${suffix}.test');
     INSERT INTO contacts (id, tenant_id, display_name) VALUES ('${contactId}', '${tenantId}', 'DL outbox RLS contact');
     INSERT INTO cg_reservations (id, tenant_id, contact_id, channel, purpose, source, source_id, action_key, input_hash, state, expires_at, updated_at) VALUES ('${reservationId}', '${tenantId}', '${contactId}', 'EMAIL', 'MARKETING', 'JOURNEY', 'journey-c1-3', 'action-${suffix}', 'hash-${suffix}', 'RESERVED', now() + interval '15 minutes', now());
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM dl_outbox_entries WHERE tenant_id = '${tenantId}';
       DELETE FROM cg_reservations WHERE tenant_id = '${tenantId}';
       DELETE FROM contacts WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO dl_outbox_entries (id, tenant_id, action_key, reservation_id, delivery_id, provider_request_key, channel, contact_id, purpose, source, sender_identity_id, content_ref, input_hash, lease_version, lease_expires_at, correlation_id, updated_at) VALUES ('${entryId}', '${tenantId}', 'action-${suffix}', '${reservationId}', 'dlv-${suffix}', 'prq-${suffix}', 'EMAIL', '${contactId}', 'MARKETING', 'JOURNEY', 'sender-${suffix}', 'template:welcome/v3', 'canonical-hash', 1, now() + interval '10 minutes', 'corr-${suffix}', now());
       SELECT count(*) FROM dl_outbox_entries WHERE id = '${entryId}';
       COMMIT;`,
    ),
    /\nINSERT 0 1\n1\nCOMMIT$/,
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM dl_outbox_entries WHERE id = '${entryId}'; COMMIT;`,
    ),
    /\n0\nCOMMIT$/,
  );

  // outbox เดินสถานะได้ (UPDATE ยังต้องผ่าน) แต่ห้ามหายไปทั้งแถว
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE dl_outbox_entries SET state = 'SUBMITTING' WHERE id = '${entryId}'; COMMIT;`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); DELETE FROM dl_outbox_entries WHERE id = '${entryId}'; COMMIT;`,
      ),
    /permission denied/i,
  );

  assert.equal(
    queryAsOwner(
      "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'dl_outbox_entries' AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;",
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

test('J2.3 outcome receipt/owner action บังคับ tenant RLS และห้าม application role ลบแถว', (t) => {
  const tenantId = randomUUID();
  const receiptId = randomUUID();
  const actionId = randomUUID();
  const enrollmentId = randomUUID();
  const outcomeId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'J2.3 RLS ${suffix}', 'j2-3-rls-${suffix}', 'j2-3-rls-${suffix}.test');
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM jr_owner_result_inbox WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_owner_command_outbox WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_owner_actions WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_outcome_heads WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_outcome_receipts WHERE tenant_id = '${tenantId}';
       DELETE FROM jr_recovery_audit WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO jr_outcome_receipts (id, tenant_id, source, event_id, outcome_type, outcome_id, outcome_version, payload_hash, payload, correlation_id) VALUES ('${receiptId}', '${tenantId}', 'INTERACTION', 'event-${suffix}', 'INTERACTION_ABANDONED', '${outcomeId}', 1, '${'a'.repeat(64)}', '{}', 'corr-${suffix}');
       INSERT INTO jr_owner_actions (id, tenant_id, action_key, enrollment_id, kind, request_hash, correlation_id) VALUES ('${actionId}', '${tenantId}', 'action-${suffix}', '${enrollmentId}', 'ENSURE_CASE', '${'b'.repeat(64)}', 'corr-${suffix}');
       SELECT count(*) FROM jr_outcome_receipts WHERE id = '${receiptId}';
       SELECT count(*) FROM jr_owner_actions WHERE id = '${actionId}';
       COMMIT;`,
    ),
    /\nINSERT 0 1\nINSERT 0 1\n1\n1\nCOMMIT$/,
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  for (const table of ['jr_outcome_receipts', 'jr_owner_actions']) {
    assert.match(
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM ${table} WHERE tenant_id = '${tenantId}'; COMMIT;`,
      ),
      /\n0\nCOMMIT$/,
    );
  }

  // receipt/action เดินสถานะได้ (UPDATE ผ่าน) แต่ห้ามหายไปทั้งแถว
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE jr_outcome_receipts SET state = 'APPLIED' WHERE id = '${receiptId}'; UPDATE jr_owner_actions SET state = 'DISPATCHED' WHERE id = '${actionId}'; COMMIT;`,
    ),
    /\nUPDATE 1\nUPDATE 1\nCOMMIT$/,
  );
  for (const mutation of [
    `DELETE FROM jr_outcome_receipts WHERE id = '${receiptId}'`,
    `DELETE FROM jr_owner_actions WHERE id = '${actionId}'`,
  ]) {
    assert.throws(
      () =>
        queryAsApplicationRole(
          `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${mutation}; COMMIT;`,
        ),
      /permission denied/i,
    );
  }

  // recovery audit เป็น append-only: INSERT ผ่าน แต่ UPDATE/DELETE ต้องถูกปฏิเสธ
  const auditId = randomUUID();
  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO jr_recovery_audit (id, tenant_id, operation, target_kind, target_ref, reason_code, actor_id) VALUES ('${auditId}', '${tenantId}', 'RECONCILE', 'ACTION', 'action-${suffix}', 'MANUAL_TEST', '${randomUUID()}');
       COMMIT;`,
    ),
    /\nINSERT 0 1\nCOMMIT$/,
  );
  for (const mutation of [
    `UPDATE jr_recovery_audit SET reason_code = 'MUTATED' WHERE id = '${auditId}'`,
    `DELETE FROM jr_recovery_audit WHERE id = '${auditId}'`,
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
      `SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN (
         'jr_outcome_receipts', 'jr_outcome_heads', 'jr_owner_actions',
         'jr_owner_command_outbox', 'jr_owner_result_inbox', 'jr_recovery_audit'
       ) AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;`,
    ),
    '6',
  );
});

test('J2.4 Cases cs_cases/cs_command_inbox บังคับ tenant RLS และห้าม application role ลบแถว', (t) => {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const caseId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'J2.4 RLS ${suffix}', 'j2-4-rls-${suffix}', 'j2-4-rls-${suffix}.test');
     INSERT INTO contacts (id, tenant_id, display_name) VALUES ('${contactId}', '${tenantId}', 'J2.4 RLS contact');
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM cs_command_inbox WHERE tenant_id = '${tenantId}';
       DELETE FROM cs_case_activities WHERE tenant_id = '${tenantId}';
       DELETE FROM cs_case_links WHERE tenant_id = '${tenantId}';
       DELETE FROM cs_cases WHERE tenant_id = '${tenantId}';
       DELETE FROM cs_routing_policies WHERE tenant_id = '${tenantId}';
       DELETE FROM cs_case_type_policies WHERE tenant_id = '${tenantId}';
       DELETE FROM contacts WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO cs_cases (id, tenant_id, contact_id, case_type_key, updated_at) VALUES ('${caseId}', '${tenantId}', '${contactId}', 'COLLECTIONS', now());
       INSERT INTO cs_command_inbox (id, tenant_id, command_id, action_key, request_hash, status, code, category, reason_code, failure_class, retry_disposition, correlation_id, observed_at) VALUES ('${randomUUID()}', '${tenantId}', 'command-${suffix}', 'action-${suffix}', '${'a'.repeat(64)}', 'CREATED', 'CREATED', 'BUSINESS', 'CASE_NO_MATCH', 'NONE', 'NONE', 'corr-${suffix}', now());
       SELECT count(*) FROM cs_cases WHERE id = '${caseId}';
       SELECT count(*) FROM cs_command_inbox WHERE tenant_id = '${tenantId}';
       COMMIT;`,
    ),
    /\nINSERT 0 1\nINSERT 0 1\n1\n1\nCOMMIT$/,
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  for (const table of ['cs_cases', 'cs_command_inbox']) {
    assert.match(
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM ${table} WHERE tenant_id = '${tenantId}'; COMMIT;`,
      ),
      /\n0\nCOMMIT$/,
    );
  }

  // case เดินสถานะได้ (UPDATE ผ่าน) แต่ห้ามหายไปทั้งแถว
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE cs_cases SET status = 'RESOLVED' WHERE id = '${caseId}'; COMMIT;`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );
  for (const mutation of [
    `DELETE FROM cs_cases WHERE id = '${caseId}'`,
    `DELETE FROM cs_command_inbox WHERE tenant_id = '${tenantId}'`,
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
      `SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN (
         'cs_case_type_policies', 'cs_routing_policies', 'cs_cases',
         'cs_case_links', 'cs_case_activities', 'cs_command_inbox'
       ) AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;`,
    ),
    '6',
  );
});

test('J2.5 Dialer ob_campaign_targets/ob_dialer_command_inbox บังคับ tenant RLS และห้าม application role ลบแถว', (t) => {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const campaignId = randomUUID();
  const sourceTeamId = randomUUID();
  const targetTeamId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'J2.5 RLS ${suffix}', 'j2-5-rls-${suffix}', 'j2-5-rls-${suffix}.test');
     INSERT INTO contacts (id, tenant_id, display_name) VALUES ('${contactId}', '${tenantId}', 'J2.5 RLS contact');
     INSERT INTO teams (id, tenant_id, name) VALUES ('${sourceTeamId}', '${tenantId}', 'Journey');
     INSERT INTO teams (id, tenant_id, name) VALUES ('${targetTeamId}', '${tenantId}', 'Dialer');
     INSERT INTO ob_campaigns (id, tenant_id, key) VALUES ('${campaignId}', '${tenantId}', 'campaign-${suffix}');
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM ob_dialer_command_inbox WHERE tenant_id = '${tenantId}';
       DELETE FROM ob_campaign_targets WHERE tenant_id = '${tenantId}';
       DELETE FROM ob_campaign_admission_policies WHERE tenant_id = '${tenantId}';
       DELETE FROM ob_campaigns WHERE tenant_id = '${tenantId}';
       DELETE FROM teams WHERE tenant_id = '${tenantId}';
       DELETE FROM contacts WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  const targetId = randomUUID();
  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO ob_campaign_targets (id, tenant_id, campaign_id, contact_id, source_owner_team_id, target_owner_team_id, admission_policy_version, updated_at) VALUES ('${targetId}', '${tenantId}', '${campaignId}', '${contactId}', '${sourceTeamId}', '${targetTeamId}', 1, now());
       INSERT INTO ob_dialer_command_inbox (id, tenant_id, command_id, action_key, command_type, request_hash, status, code, category, reason_code, failure_class, retry_disposition, correlation_id, observed_at) VALUES ('${randomUUID()}', '${tenantId}', 'command-${suffix}', 'action-${suffix}', 'ADMIT_CAMPAIGN_TARGET', '${'a'.repeat(64)}', 'ADMITTED', 'ADMITTED', 'BUSINESS', 'CAMPAIGN_ACTIVE_ADMITTED', 'NONE', 'NONE', 'corr-${suffix}', now());
       SELECT count(*) FROM ob_campaign_targets WHERE id = '${targetId}';
       SELECT count(*) FROM ob_dialer_command_inbox WHERE tenant_id = '${tenantId}';
       COMMIT;`,
    ),
    /\nINSERT 0 1\nINSERT 0 1\n1\n1\nCOMMIT$/,
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  for (const table of ['ob_campaign_targets', 'ob_dialer_command_inbox']) {
    assert.match(
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM ${table} WHERE tenant_id = '${tenantId}'; COMMIT;`,
      ),
      /\n0\nCOMMIT$/,
    );
  }

  // target เดินสถานะได้ (UPDATE ผ่าน) แต่ห้ามหายไปทั้งแถว
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE ob_campaign_targets SET state = 'DEFERRED' WHERE id = '${targetId}'; COMMIT;`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );
  for (const mutation of [
    `DELETE FROM ob_campaign_targets WHERE id = '${targetId}'`,
    `DELETE FROM ob_dialer_command_inbox WHERE tenant_id = '${tenantId}'`,
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
      `SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN (
         'ob_campaigns', 'ob_campaign_admission_policies', 'ob_campaign_targets', 'ob_dialer_command_inbox'
       ) AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;`,
    ),
    '4',
  );
});

test('J2.6 Dialer ob_callbacks บังคับ tenant RLS และห้าม application role ลบแถว', (t) => {
  const tenantId = randomUUID();
  const contactId = randomUUID();
  const queueId = randomUUID();
  const sourceTeamId = randomUUID();
  const targetTeamId = randomUUID();
  const suffix = tenantId.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'J2.6 RLS ${suffix}', 'j2-6-rls-${suffix}', 'j2-6-rls-${suffix}.test');
     INSERT INTO contacts (id, tenant_id, display_name) VALUES ('${contactId}', '${tenantId}', 'J2.6 RLS contact');
     INSERT INTO teams (id, tenant_id, name) VALUES ('${sourceTeamId}', '${tenantId}', 'Journey');
     INSERT INTO teams (id, tenant_id, name) VALUES ('${targetTeamId}', '${tenantId}', 'Dialer');
     INSERT INTO queues (id, tenant_id, name) VALUES ('${queueId}', '${tenantId}', 'Callback queue');
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM ob_callbacks WHERE tenant_id = '${tenantId}';
       DELETE FROM queues WHERE tenant_id = '${tenantId}';
       DELETE FROM teams WHERE tenant_id = '${tenantId}';
       DELETE FROM contacts WHERE tenant_id = '${tenantId}';
       DELETE FROM tenants WHERE id = '${tenantId}';`,
    ),
  );

  const callbackId = randomUUID();
  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO ob_callbacks (id, tenant_id, contact_id, queue_id, requested_for, expires_at, source_owner_team_id, target_owner_team_id, updated_at) VALUES ('${callbackId}', '${tenantId}', '${contactId}', '${queueId}', now() + interval '6 hours', now() + interval '30 hours', '${sourceTeamId}', '${targetTeamId}', now());
       SELECT count(*) FROM ob_callbacks WHERE id = '${callbackId}';
       COMMIT;`,
    ),
    /\nINSERT 0 1\n1\nCOMMIT$/,
  );

  const demoTenantId = queryAsOwner("SELECT id FROM tenants WHERE slug = 'demo';");
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${demoTenantId}', true); SELECT count(*) FROM ob_callbacks WHERE tenant_id = '${tenantId}'; COMMIT;`,
    ),
    /\n0\nCOMMIT$/,
  );

  // callback เดินสถานะได้ (UPDATE ผ่าน) แต่ห้ามหายไปทั้งแถว
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE ob_callbacks SET state = 'CANCELLED' WHERE id = '${callbackId}'; COMMIT;`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); DELETE FROM ob_callbacks WHERE id = '${callbackId}'; COMMIT;`,
      ),
    /permission denied/i,
  );

  assert.equal(
    queryAsOwner(
      "SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename = 'ob_callbacks' AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;",
    ),
    '1',
  );
});

test('J3.5 jr_segment_* บังคับ RLS, transport/logical identity, composite binding และ immutable intent', (t) => {
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const contactId = randomUUID();
  const otherContactId = randomUUID();
  /**
   * contacts.id เป็น primary key ระดับ global จึง reuse ข้าม tenant ไม่ได้ — ตัวที่ reuse ได้จริง
   * และต้องพิสูจน์คือ segment_id กับ event_id ซึ่งเป็น TEXT ที่ tenant ตั้งเองได้อิสระ ทั้งคู่ต้อง
   * ชนกันเองภายใน tenant เท่านั้น ไม่ใช่ข้าม tenant
   */
  const suffix = tenantId.slice(0, 8);
  const receiptId = randomUUID();
  const segmentId = `segment-${suffix}`;
  const hash = 'a'.repeat(64);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantId}', 'J3.5 RLS ${suffix}', 'j3-5-rls-${suffix}', 'j3-5-rls-${suffix}.test');
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${otherTenantId}', 'J3.5 other ${suffix}', 'j3-5-other-${suffix}', 'j3-5-other-${suffix}.test');
     INSERT INTO contacts (id, tenant_id) VALUES ('${contactId}', '${tenantId}');
     INSERT INTO contacts (id, tenant_id) VALUES ('${otherContactId}', '${otherTenantId}');
     COMMIT;`,
  );

  t.after(() =>
    queryAsOwner(
      `DELETE FROM jr_segment_outbox WHERE tenant_id IN ('${tenantId}', '${otherTenantId}');
       DELETE FROM jr_segment_refilter_cursors WHERE tenant_id IN ('${tenantId}', '${otherTenantId}');
       DELETE FROM jr_segment_enrollment_intents WHERE tenant_id IN ('${tenantId}', '${otherTenantId}');
       DELETE FROM jr_segment_heads WHERE tenant_id IN ('${tenantId}', '${otherTenantId}');
       DELETE FROM jr_segment_receipts WHERE tenant_id IN ('${tenantId}', '${otherTenantId}');
       DELETE FROM jr_recovery_audit WHERE tenant_id IN ('${tenantId}', '${otherTenantId}');
       DELETE FROM contacts WHERE tenant_id IN ('${tenantId}', '${otherTenantId}');
       DELETE FROM tenants WHERE id IN ('${tenantId}', '${otherTenantId}');`,
    ),
  );

  const insertReceipt = (id: string, eventId: string, revision: number) =>
    `INSERT INTO jr_segment_receipts (id, tenant_id, source, event_id, contact_id, segment_id, membership_revision, change_kind, entry_id, segment_definition_version, payload_hash, correlation_id) VALUES ('${id}', '${tenantId}', 'CUSTOMER_360', '${eventId}', '${contactId}', '${segmentId}', ${revision}, 'ENTERED', 'entry-${suffix}', 1, '${hash}', 'corr-${suffix}')`;

  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       ${insertReceipt(receiptId, `event-${suffix}`, 1)};
       INSERT INTO jr_segment_heads (tenant_id, contact_id, segment_id, last_applied_revision, updated_at) VALUES ('${tenantId}', '${contactId}', '${segmentId}', 1, now());
       COMMIT;`,
    ),
    /\nINSERT 0 1\nINSERT 0 1\nCOMMIT$/,
  );

  // transport identity: event เดิมส่งซ้ำมาจาก broker ต้องชนถึงแม้จะเป็นคนละ row id
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${insertReceipt(randomUUID(), `event-${suffix}`, 2)}; COMMIT;`,
      ),
    /jr_segment_receipts_transport_key|duplicate key/i,
  );

  // logical identity: revision เดิมที่มาคนละ event ก็ต้องชน — คนละเหตุผลกับข้างบน
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${insertReceipt(randomUUID(), `event-other-${suffix}`, 1)}; COMMIT;`,
      ),
    /jr_segment_receipts_logical_key|duplicate key/i,
  );

  // composite binding: tenant อื่นอ้าง contact ที่ไม่ใช่ของตัวเองต้องผูกไม่ได้
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN;
         SELECT set_config('app.tenant_id', '${otherTenantId}', true);
         INSERT INTO jr_segment_receipts (id, tenant_id, source, event_id, contact_id, segment_id, membership_revision, change_kind, segment_definition_version, payload_hash, correlation_id) VALUES ('${randomUUID()}', '${otherTenantId}', 'CUSTOMER_360', 'event-x-${suffix}', '${contactId}', '${segmentId}', 1, 'ENTERED', 1, '${hash}', 'corr-${suffix}');
         COMMIT;`,
      ),
    /foreign key|violates/i,
  );

  // reused ID: segment_id และ event_id ชุดเดียวกันเป๊ะ ๆ ต้องอยู่ได้ทั้งสอง tenant พร้อมกัน
  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${otherTenantId}', true);
       INSERT INTO jr_segment_receipts (id, tenant_id, source, event_id, contact_id, segment_id, membership_revision, change_kind, segment_definition_version, payload_hash, correlation_id) VALUES ('${randomUUID()}', '${otherTenantId}', 'CUSTOMER_360', 'event-${suffix}', '${otherContactId}', '${segmentId}', 1, 'ENTERED', 1, '${hash}', 'corr-${suffix}');
       COMMIT;`,
    ),
    /\nINSERT 0 1\nCOMMIT$/,
  );

  // RLS: อีก tenant มองไม่เห็นแถวของ tenant นี้เลยแม้ contact id จะซ้ำกัน
  for (const table of [
    'jr_segment_receipts',
    'jr_segment_heads',
    'jr_segment_refilter_cursors',
    'jr_segment_outbox',
  ]) {
    assert.match(
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${otherTenantId}', true); SELECT count(*) FROM ${table} WHERE tenant_id = '${tenantId}'; COMMIT;`,
      ),
      /\n0\nCOMMIT$/,
      `${table} ต้องไม่รั่วข้าม tenant`,
    );
  }

  // lease ต้องมาเป็นคู่ — owner ที่ไม่มีวันหมดอายุคือ lease ค้างตลอดกาลเมื่อ worker ตาย
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE jr_segment_receipts SET state = 'PROCESSING', lease_owner = 'worker-1' WHERE id = '${receiptId}'; COMMIT;`,
      ),
    /jr_segment_receipts_lease_check/i,
  );

  // APPLIED ต้องมี applied_at เสมอ และห้ามมีเมื่อยังไม่ APPLIED
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE jr_segment_receipts SET state = 'APPLIED' WHERE id = '${receiptId}'; COMMIT;`,
      ),
    /jr_segment_receipts_state_check/i,
  );
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE jr_segment_receipts SET state = 'APPLIED', applied_at = now() WHERE id = '${receiptId}'; COMMIT;`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );

  // first-terminal protection: terminal ต้องมาครบชุดและห้ามล้ำหน้า revision ที่ apply แล้ว
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE jr_segment_heads SET terminal_entry_id = 'entry-${suffix}' WHERE tenant_id = '${tenantId}' AND contact_id = '${contactId}' AND segment_id = '${segmentId}'; COMMIT;`,
      ),
    /jr_segment_heads_terminal_check/i,
  );
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); UPDATE jr_segment_heads SET terminal_entry_id = 'entry-${suffix}', terminal_revision = 99, terminal_reason_code = 'LEFT' WHERE tenant_id = '${tenantId}' AND contact_id = '${contactId}' AND segment_id = '${segmentId}'; COMMIT;`,
      ),
    /jr_segment_heads_terminal_check/i,
  );

  // enrollment intent: เขียนได้ครั้งเดียว แก้หรือลบไม่ได้ทั้งที่ระดับ grant และ trigger
  const intentId = randomUUID();
  const journeyId = `journey-${suffix}`;
  const insertIntent = (id: string) =>
    `INSERT INTO jr_segment_enrollment_intents (id, tenant_id, journey_id, journey_version, contact_id, segment_id, entry_id, receipt_id, reason_membership_revision, reason_definition_version, reason_digest, correlation_id) VALUES ('${id}', '${tenantId}', '${journeyId}', 1, '${contactId}', '${segmentId}', 'entry-${suffix}', '${receiptId}', 1, 1, '${hash}', 'corr-${suffix}')`;

  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${insertIntent(intentId)}; COMMIT;`,
    ),
    /\nINSERT 0 1\nCOMMIT$/,
  );
  // intent เดิมซ้ำต้องชน unique ไม่ใช่สร้างเหตุผลใบที่สองให้ enrollment เดียวกัน
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${insertIntent(randomUUID())}; COMMIT;`,
      ),
    /jr_segment_enrollment_intents_key|duplicate key/i,
  );
  for (const mutation of [
    `UPDATE jr_segment_enrollment_intents SET reason_digest = '${'b'.repeat(64)}' WHERE id = '${intentId}'`,
    `DELETE FROM jr_segment_enrollment_intents WHERE id = '${intentId}'`,
  ]) {
    assert.throws(
      () =>
        queryAsApplicationRole(
          `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${mutation}; COMMIT;`,
        ),
      /permission denied|append-only/i,
    );
  }

  // recovery audit รับ target/operation ใหม่ได้แบบ additive โดยค่าเดิมยังใช้ได้เหมือนเดิม
  assert.match(
    queryAsApplicationRole(
      `BEGIN;
       SELECT set_config('app.tenant_id', '${tenantId}', true);
       INSERT INTO jr_recovery_audit (id, tenant_id, operation, target_kind, target_ref, reason_code, actor_id) VALUES ('${randomUUID()}', '${tenantId}', 'REVALIDATE', 'SEGMENT_REFILTER', 'entry-${suffix}', 'MANUAL_TEST', '${randomUUID()}');
       INSERT INTO jr_recovery_audit (id, tenant_id, operation, target_kind, target_ref, reason_code, actor_id) VALUES ('${randomUUID()}', '${tenantId}', 'REPLAY', 'SEGMENT_RECEIPT', 'event-${suffix}', 'MANUAL_TEST', '${randomUUID()}');
       INSERT INTO jr_recovery_audit (id, tenant_id, operation, target_kind, target_ref, reason_code, actor_id) VALUES ('${randomUUID()}', '${tenantId}', 'RECONCILE', 'ACTION', 'action-${suffix}', 'MANUAL_TEST', '${randomUUID()}');
       COMMIT;`,
    ),
    /\nINSERT 0 1\nINSERT 0 1\nINSERT 0 1\nCOMMIT$/,
  );

  assert.equal(
    queryAsOwner(
      `SELECT count(*) FROM pg_policies WHERE schemaname = 'public' AND tablename IN (
         'jr_segment_receipts', 'jr_segment_heads', 'jr_segment_enrollment_intents',
         'jr_segment_refilter_cursors', 'jr_segment_outbox'
       ) AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;`,
    ),
    '5',
  );
});
