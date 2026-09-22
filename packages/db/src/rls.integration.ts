import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(process.cwd(), '../..');
// ค่าเริ่มต้นคือ dev database เดิม; worktree ที่ต้องแยก database ตั้งค่านี้ได้ (ชื่อเดียวกับ readiness script)
const databaseName = process.env.CXA_ACCEPTANCE_DATABASE_NAME ?? 'dcontact';
if (!/^[a-zA-Z0-9_]+$/.test(databaseName))
  throw new TypeError('CXA_ACCEPTANCE_DATABASE_NAME ไม่ถูกต้อง');

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
      `PGPASSWORD=dcontact_app psql -h 127.0.0.1 -U dcontact_app -d ${databaseName} -tAc ${JSON.stringify(compactSql)}`,
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
      databaseName,
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

test('J3 bootstrap คงสิทธิ์ immutable evidence และ rollout ตาม migration', () => {
  for (const [table, updateAllowed] of [
    ['jr_segment_enrollment_intents', false],
    ['jr_segment_shadow_mismatches', false],
    ['jr_segment_rollout_state', true],
  ] as const) {
    assert.equal(
      queryAsOwner(
        `SELECT has_table_privilege('dcontact_app', '${table}', 'SELECT'), has_table_privilege('dcontact_app', '${table}', 'INSERT'), has_table_privilege('dcontact_app', '${table}', 'UPDATE'), has_table_privilege('dcontact_app', '${table}', 'DELETE');`,
      ),
      `t|t|${updateAllowed ? 't' : 'f'}|f`,
      table,
    );
  }
});

/**
 * J2.10 (#138): migration ถอนสิทธิ์ที่ตารางหนึ่งต้องเป็น append-only/undeletable ไว้ แต่ rls.sql
 * (bootstrap) GRANT SELECT/INSERT/UPDATE/DELETE ทุกตารางก่อนแล้วค่อย REVOKE ทีละตาราง — ตารางใหม่
 * ที่ลืมใส่รายการ REVOKE จึงได้สิทธิ์คืนเงียบ ๆ บน environment ที่ bootstrap (CI) แต่ไม่ใช่บนเครื่อง
 * ที่รันแค่ migrate เทสนี้อ่าน REVOKE ทั้งหมดจาก migration แล้วยืนยันกับสิทธิ์จริงหลัง bootstrap
 */
function revokedApplicationPrivilegesFromMigrations(): Array<[string, string]> {
  const migrations = resolve(repositoryRoot, 'packages/db/prisma/migrations');
  const pattern = /REVOKE\s+([A-Za-z,\s]+?)\s+ON\s+"?([a-z0-9_]+)"?\s+FROM\s+dcontact_app/gi;
  const revoked = new Set<string>();
  for (const entry of readdirSync(migrations, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sql = readFileSync(resolve(migrations, entry.name, 'migration.sql'), 'utf8');
    for (const match of sql.matchAll(pattern)) {
      for (const privilege of match[1].split(',')) {
        revoked.add(`${match[2]} ${privilege.trim().toUpperCase()}`);
      }
    }
  }
  return [...revoked].sort().map((row) => row.split(' ') as [string, string]);
}

test('bootstrap ไม่คืนสิทธิ์ที่ migration ถอนจาก dcontact_app', () => {
  const revoked = revokedApplicationPrivilegesFromMigrations();
  assert.ok(revoked.length >= 40, `อ่าน REVOKE จาก migration ได้ ${revoked.length} รายการ`);
  const values = revoked.map(([table, privilege]) => `('${table}','${privilege}')`).join(',');
  assert.equal(
    queryAsOwner(
      `SELECT coalesce(string_agg(t || ':' || p, ', ' ORDER BY t, p), '') FROM (VALUES ${values})
         AS revoked(t, p) WHERE has_table_privilege('dcontact_app', t, p);`,
    ),
    '',
    'packages/db/prisma/rls.sql ต้อง REVOKE สิทธิ์เหล่านี้ซ้ำหลัง GRANT ... ON ALL TABLES',
  );
});

test('J2.9 rollout gate: state ลบไม่ได้และ audit เป็น append-only สำหรับ application role', () => {
  for (const [table, expected] of [
    ['ob_originate_rollout_state', 't|t|t|f'],
    ['ob_originate_rollout_scopes', 't|t|f|t'],
    ['ob_originate_rollout_audit', 't|t|f|f'],
  ] as const) {
    assert.equal(
      queryAsOwner(
        `SELECT has_table_privilege('dcontact_app', '${table}', 'SELECT'), has_table_privilege('dcontact_app', '${table}', 'INSERT'), has_table_privilege('dcontact_app', '${table}', 'UPDATE'), has_table_privilege('dcontact_app', '${table}', 'DELETE');`,
      ),
      expected,
      table,
    );
  }
});

test('J5.1 authoring/template/IAM บังคับ RLS, composite binding, CAS และ append-only', (t) => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const teamA = randomUUID();
  const teamB = randomUUID();
  const suffix = tenantA.slice(0, 8);
  const journeyId = randomUUID();
  const headId = randomUUID();
  const draftId = randomUUID();
  const legacyDefinitionId = randomUUID();
  const templateId = randomUUID();
  const hashA = 'a'.repeat(64);
  const hashB = 'b'.repeat(64);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantA}', 'J5.1 A ${suffix}', 'j5-1-a-${suffix}', 'j5-1-a-${suffix}.test');
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES ('${tenantB}', 'J5.1 B ${suffix}', 'j5-1-b-${suffix}', 'j5-1-b-${suffix}.test');
     INSERT INTO teams (id, tenant_id, name) VALUES ('${teamA}', '${tenantA}', 'j5-a-${suffix}');
     INSERT INTO teams (id, tenant_id, name) VALUES ('${teamB}', '${tenantB}', 'j5-b-${suffix}');
     INSERT INTO jr_journey_definitions (id, tenant_id, journey_id, version, name, owner_team_id, purpose, sender_identity_id, status, trigger, graph, goal, exit_rules, max_duration_days, input_hash, correlation_id, published_at)
       VALUES ('${legacyDefinitionId}', '${tenantA}', '${journeyId}', 1, 'legacy', '${teamA}', 'SERVICE', 'sender-test', 'PUBLISHED', '{"kind":"EVENT","eventType":"order.created"}', '{"entryStepId":"exit","steps":[{"id":"exit","type":"EXIT","reason":"DONE"}]}', '{"kind":"EVENT","eventType":"order.completed"}', '[]', 7, '${hashA}', 'corr-${suffix}', now());
     INSERT INTO iam_authoring_subjects (id, tenant_id, subject_id, authentication_strength, updated_at) VALUES ('${randomUUID()}', '${tenantA}', 'human-a', 'STRONG', now());
     INSERT INTO iam_authoring_subjects (id, tenant_id, subject_id, authentication_strength, updated_at) VALUES ('${randomUUID()}', '${tenantA}', 'human-b', 'STANDARD', now());
     INSERT INTO iam_authoring_subjects (id, tenant_id, subject_id, authentication_strength, is_service_principal, updated_at) VALUES ('${randomUUID()}', '${tenantA}', 'service-a', 'STANDARD', true, now());
     COMMIT;`,
  );

  t.after(() => {
    const tenants = `('${tenantA}', '${tenantB}')`;
    queryAsOwner(
      `BEGIN;
       DELETE FROM iam_authoring_delegation_revocations WHERE tenant_id IN ${tenants};
       DELETE FROM iam_authoring_delegations WHERE tenant_id IN ${tenants};
       DELETE FROM iam_authoring_capability_grants WHERE tenant_id IN ${tenants};
       DELETE FROM iam_authoring_subjects WHERE tenant_id IN ${tenants};
       DELETE FROM iam_authoring_scope_versions WHERE tenant_id IN ${tenants};
       DELETE FROM jr_authoring_rollout_state WHERE tenant_id IN ${tenants};
       DELETE FROM jr_review_decisions WHERE tenant_id IN ${tenants};
       DELETE FROM jr_review_candidates WHERE tenant_id IN ${tenants};
       DELETE FROM jr_authoring_command_receipts WHERE tenant_id IN ${tenants};
       DELETE FROM jr_authoring_audit WHERE tenant_id IN ${tenants};
       DELETE FROM jr_authoring_outbox WHERE tenant_id IN ${tenants};
       DELETE FROM jr_template_provenance WHERE tenant_id IN ${tenants};
       DELETE FROM jr_template_upgrade_applications WHERE tenant_id IN ${tenants};
       DELETE FROM jr_journey_heads WHERE tenant_id IN ${tenants};
       DELETE FROM jr_journey_drafts WHERE tenant_id IN ${tenants};
       DELETE FROM jr_template_heads WHERE tenant_id IN ${tenants};
       DELETE FROM jr_template_versions WHERE tenant_id IN ${tenants};
       DELETE FROM jr_template_drafts WHERE tenant_id IN ${tenants};
       DELETE FROM jr_journey_definitions WHERE tenant_id IN ${tenants};
       DELETE FROM teams WHERE tenant_id IN ${tenants};
       DELETE FROM tenants WHERE id IN ${tenants};
       COMMIT;`,
    );
  });

  const as = (tenantId: string, sql: string) =>
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantId}', true); ${sql}; COMMIT;`,
    );
  const insertDraft = (tenantId: string, id: string, revision: number, journey = journeyId) =>
    `INSERT INTO jr_journey_drafts (id, tenant_id, journey_id, revision, schema_version, registry_version, document, content_digest, created_by_ref) VALUES ('${id}', '${tenantId}', '${journey}', ${revision}, 'J5_AUTHORING_V1', 'J5_PALETTE_V1', '{}', '${hashA}', 'human-a')`;
  const insertHead = (tenantId: string, team: string, journey = journeyId, id = headId) =>
    `INSERT INTO jr_journey_heads (id, tenant_id, journey_id, name, owner_team_id, current_draft_id, current_draft_revision, current_draft_digest, updated_at) VALUES ('${id}', '${tenantId}', '${journey}', 'synthetic', '${team}', '${draftId}', 1, '${hashA}', now())`;

  // head กับ draft แรกเกิดพร้อมกันใน transaction เดียวได้เพราะ FK ถูก defer ถึง commit
  assert.match(
    as(tenantA, `${insertHead(tenantA, teamA)}; ${insertDraft(tenantA, draftId, 1)}`),
    /\nINSERT 0 1\nINSERT 0 1\nCOMMIT$/,
  );
  // head ชี้ draft ของ journey อื่น (หรือที่ไม่มีอยู่จริง) ล้มตอน commit
  assert.throws(
    () => as(tenantA, insertHead(tenantA, teamA, randomUUID(), randomUUID())),
    /jr_journey_heads_current_draft_fkey|foreign key/i,
  );
  // tenant B ผูกกับ team หรือ journey ของ tenant A ไม่ได้
  const foreignJourneyId = randomUUID();
  const foreignDraftId = randomUUID();
  assert.throws(
    () =>
      as(
        tenantB,
        `${insertHead(tenantB, teamA, foreignJourneyId, randomUUID()).replace(`'${draftId}'`, `'${foreignDraftId}'`)}; ${insertDraft(tenantB, foreignDraftId, 1, foreignJourneyId)}`,
      ),
    /jr_journey_heads_owner_team_fkey/,
  );
  assert.throws(
    () => as(tenantB, insertDraft(tenantB, randomUUID(), 2)),
    /jr_journey_drafts_head_fkey|foreign key/i,
  );

  // draft เป็น append-only ทั้งที่ grant และ trigger
  for (const mutation of [
    `UPDATE jr_journey_drafts SET content_digest = '${hashB}' WHERE id = '${draftId}'`,
    `DELETE FROM jr_journey_drafts WHERE id = '${draftId}'`,
  ]) {
    assert.throws(() => as(tenantA, mutation), /permission denied|append-only/i);
  }
  assert.throws(
    () => queryAsOwner(`UPDATE jr_journey_drafts SET revision = 9 WHERE id = '${draftId}';`),
    /append-only/i,
  );

  // head เป็น CAS: version ต้อง +1 และ ACTIVE ต้องชี้ definition ที่มีอยู่จริงของ journey เดียวกัน
  assert.throws(
    () => as(tenantA, `UPDATE jr_journey_heads SET name = 'x' WHERE id = '${headId}'`),
    /version ต้องเพิ่มทีละหนึ่ง/,
  );
  assert.throws(
    () =>
      as(
        tenantA,
        `UPDATE jr_journey_heads SET lifecycle = 'ACTIVE', version = 2 WHERE id = '${headId}'`,
      ),
    /jr_journey_heads_active_check/,
  );
  assert.match(
    as(
      tenantA,
      `UPDATE jr_journey_heads SET lifecycle = 'ACTIVE', version = 2, active_definition_id = '${legacyDefinitionId}', active_version = 1, active_runtime_hash = '${hashA}' WHERE id = '${headId}'`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );
  assert.throws(
    () =>
      as(
        tenantA,
        `UPDATE jr_journey_heads SET version = 3, active_version = 2 WHERE id = '${headId}'`,
      ),
    /jr_journey_heads_active_version_fkey|foreign key/i,
  );

  // mixed-version: writer เดิมยังเขียน definition ได้โดยไม่ต้องมี head และ legacy row ไม่ถูกแก้
  assert.match(
    as(
      tenantA,
      `INSERT INTO jr_journey_definitions (id, tenant_id, journey_id, version, name, owner_team_id, purpose, sender_identity_id, trigger, graph, goal, exit_rules, max_duration_days, input_hash, correlation_id) VALUES ('${randomUUID()}', '${tenantA}', '${randomUUID()}', 1, 'legacy-writer', '${teamA}', 'SERVICE', 'sender-test', '{}', '{}', '{}', '[]', 7, '${hashB}', 'corr-${suffix}')`,
    ),
    /\nINSERT 0 1\nCOMMIT$/,
  );
  assert.equal(
    queryAsOwner(
      `SELECT status || '|' || input_hash FROM jr_journey_definitions WHERE id = '${legacyDefinitionId}';`,
    ),
    `PUBLISHED|${hashA}`,
  );

  // receipt: key เดิมชน และเปลี่ยนสถานะได้ครั้งเดียวจาก PENDING
  const receiptId = randomUUID();
  const insertReceipt = (id: string) =>
    `INSERT INTO jr_authoring_command_receipts (id, tenant_id, idempotency_key, command_name, resource_kind, resource_id, request_hash, correlation_id) VALUES ('${id}', '${tenantA}', 'key-${suffix}', 'UpdateJourneyDraft', 'JOURNEY', '${journeyId}', '${hashA}', 'corr-${suffix}')`;
  assert.match(as(tenantA, insertReceipt(receiptId)), /\nINSERT 0 1\nCOMMIT$/);
  assert.throws(
    () => as(tenantA, insertReceipt(randomUUID())),
    /jr_authoring_command_receipts_idempotency_key|duplicate key/i,
  );
  assert.throws(
    () =>
      as(
        tenantA,
        `UPDATE jr_authoring_command_receipts SET request_hash = '${hashB}' WHERE id = '${receiptId}'`,
      ),
    /แก้ key\/hash\/resource ไม่ได้/,
  );
  assert.match(
    as(
      tenantA,
      `UPDATE jr_authoring_command_receipts SET state = 'COMMITTED', http_status = 200, completed_at = now() WHERE id = '${receiptId}'`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );
  assert.throws(
    () =>
      as(
        tenantA,
        `UPDATE jr_authoring_command_receipts SET state = 'FAILED', http_status = 409, error_code = 'X' WHERE id = '${receiptId}'`,
      ),
    /ที่จบแล้วแก้ไม่ได้/,
  );

  // review: candidate IN_REVIEW ได้ใบเดียวต่อ resource และ vote นับเฉพาะ capability review
  const candidateId = randomUUID();
  const insertCandidate = (id: string) =>
    `INSERT INTO jr_review_candidates (id, tenant_id, resource_kind, resource_id, draft_revision, draft_digest, compile_digest, runtime_hash, base_head_version, reference_digest, capability_digest, maker_subject_id, maker_authorization_epoch, maker_scope_version, updated_at) VALUES ('${id}', '${tenantA}', 'JOURNEY', '${journeyId}', 1, '${hashA}', '${hashA}', '${hashA}', 2, '${hashA}', '${hashA}', 'human-a', 1, 1, now())`;
  assert.match(as(tenantA, insertCandidate(candidateId)), /\nINSERT 0 1\nCOMMIT$/);
  assert.throws(
    () => as(tenantA, insertCandidate(randomUUID())),
    /jr_review_candidates_one_in_review_key|duplicate key/i,
  );
  assert.throws(
    () =>
      as(
        tenantA,
        `UPDATE jr_review_candidates SET compile_digest = '${hashB}' WHERE id = '${candidateId}'`,
      ),
    /แก้ binding ที่ pin ไว้ไม่ได้/,
  );
  const insertDecision = (capability: string) =>
    `INSERT INTO jr_review_decisions (id, tenant_id, candidate_id, decision, reviewer_subject_id, capability, capability_source, authorization_epoch, scope_version, evidence_ref, reason_code, decided_at) VALUES ('${randomUUID()}', '${tenantA}', '${candidateId}', 'APPROVE', 'human-b', '${capability}', 'DIRECT_GRANT', 1, 1, 'evidence-${suffix}', 'LOOKS_GOOD', now())`;
  assert.throws(
    () => as(tenantA, insertDecision('journey.publish')),
    /jr_review_decisions_capability_check/,
  );
  assert.match(as(tenantA, insertDecision('journey.review')), /\nINSERT 0 1\nCOMMIT$/);

  // audit ใช้ closed code เท่านั้น ไม่รับ free text
  assert.throws(
    () =>
      as(
        tenantA,
        `INSERT INTO jr_authoring_audit (id, tenant_id, resource_kind, resource_id, action, actor_subject_id, reason_code, correlation_id, occurred_at) VALUES ('${randomUUID()}', '${tenantA}', 'JOURNEY', '${journeyId}', 'edited by somchai', 'human-a', 'X', 'corr', now())`,
      ),
    /jr_authoring_audit_code_check/,
  );

  // template: built-in ห้ามมีแถวใน tenant table และ provenance ต้องอ้าง version ใน tenant เดียวกัน
  const templateDraftId = randomUUID();
  assert.match(
    as(
      tenantA,
      `INSERT INTO jr_template_heads (id, tenant_id, template_id, name, owner_team_id, current_draft_id, current_draft_revision, current_draft_digest, updated_at) VALUES ('${randomUUID()}', '${tenantA}', '${templateId}', 'tpl', '${teamA}', '${templateDraftId}', 1, '${hashA}', now());
       INSERT INTO jr_template_drafts (id, tenant_id, template_id, revision, schema_version, registry_version, document, parameter_schema, content_digest, created_by_ref) VALUES ('${templateDraftId}', '${tenantA}', '${templateId}', 1, 'J5_TEMPLATE_V1', 'J5_PALETTE_V1', '{}', '[]', '${hashA}', 'human-a')`,
    ),
    /\nINSERT 0 1\nINSERT 0 1\nCOMMIT$/,
  );
  const insertVersion = (origin: string, version: number) =>
    `INSERT INTO jr_template_versions (id, tenant_id, template_id, version, origin, visibility, owner_team_id, schema_version, registry_version, document, parameter_schema, content_digest, compile_digest, node_mapping_digest, published_by_ref, published_at) VALUES ('${randomUUID()}', '${tenantA}', '${templateId}', ${version}, '${origin}', 'TEAM', '${teamA}', 'J5_TEMPLATE_V1', 'J5_PALETTE_V1', '{}', '[]', '${hashA}', '${hashA}', '${hashA}', 'human-a', now())`;
  assert.throws(
    () => as(tenantA, insertVersion('PLATFORM_BUILTIN', 1)),
    /jr_template_versions_origin_check/,
  );
  assert.match(as(tenantA, insertVersion('TENANT', 1)), /\nINSERT 0 1\nCOMMIT$/);
  const insertProvenance = (sourceVersion: number) =>
    `INSERT INTO jr_template_provenance (id, tenant_id, journey_id, draft_revision, template_origin, source_template_id, source_template_version, source_content_digest, binding_digest, node_mapping, node_mapping_digest) VALUES ('${randomUUID()}', '${tenantA}', '${journeyId}', 1, 'TENANT', '${templateId}', ${sourceVersion}, '${hashA}', '${hashA}', '{}', '${hashA}')`;
  assert.throws(() => as(tenantA, insertProvenance(9)), /ไม่มีใน tenant นี้/);
  assert.match(as(tenantA, insertProvenance(1)), /\nINSERT 0 1\nCOMMIT$/);
  // tenant B อ้าง template version ของ A ไม่ได้แม้รู้ ID
  assert.throws(
    () => as(tenantB, insertProvenance(1).replaceAll(`'${tenantA}'`, `'${tenantB}'`)),
    /ไม่มีใน tenant นี้|foreign key/i,
  );

  // rollout: DISABLED เปิด feature ไม่ได้, stage ถอยไม่ได้, version ต้อง +1
  assert.throws(
    () =>
      as(
        tenantA,
        `INSERT INTO jr_authoring_rollout_state (id, tenant_id, canvas_write_enabled, updated_by_ref, evidence_ref, updated_at) VALUES ('${randomUUID()}', '${tenantA}', true, 'ops', 'evidence', now())`,
      ),
    /jr_authoring_rollout_state_stage_check/,
  );
  assert.match(
    as(
      tenantA,
      `INSERT INTO jr_authoring_rollout_state (id, tenant_id, stage, canvas_write_enabled, updated_by_ref, evidence_ref, updated_at) VALUES ('${randomUUID()}', '${tenantA}', 'INTERNAL_SYNTHETIC', true, 'ops', 'evidence', now())`,
    ),
    /\nINSERT 0 1\nCOMMIT$/,
  );
  assert.throws(
    () =>
      as(
        tenantA,
        `UPDATE jr_authoring_rollout_state SET stage = 'DISABLED', canvas_write_enabled = false, version = 2 WHERE tenant_id = '${tenantA}'`,
      ),
    /ย้อน stage ไม่ได้/,
  );
  assert.match(
    as(
      tenantA,
      `UPDATE jr_authoring_rollout_state SET mutation_frozen = true, version = 2 WHERE tenant_id = '${tenantA}'`,
    ),
    /\nUPDATE 1\nCOMMIT$/,
  );

  // IAM: app ขยายสิทธิ์ตัวเองไม่ได้; delegation human-to-human ≤ 8 ชม. และมอบได้แค่ read/edit
  assert.throws(
    () =>
      as(
        tenantA,
        `INSERT INTO iam_authoring_capability_grants (id, tenant_id, subject_id, capability, scope_kind, scope_id, granted_by_ref) VALUES ('${randomUUID()}', '${tenantA}', 'human-a', 'journey.publish', 'TENANT', '${tenantA}', 'self')`,
      ),
    /permission denied/i,
  );
  const insertDelegation = (to: string, capability: string, hours: number) =>
    `INSERT INTO iam_authoring_delegations (id, tenant_id, delegator_subject_id, delegate_subject_id, capability, scope_kind, scope_id, starts_at, expires_at, evidence_ref) VALUES ('${randomUUID()}', '${tenantA}', 'human-a', '${to}', '${capability}', 'JOURNEY', '${journeyId}', now(), now() + interval '${hours} hours', 'evidence-${suffix}')`;
  assert.throws(
    () => as(tenantA, insertDelegation('human-b', 'journey.edit', 9)),
    /iam_authoring_delegations_window_check/,
  );
  assert.throws(
    () => as(tenantA, insertDelegation('human-b', 'journey.publish', 1)),
    /iam_authoring_delegations_capability_check/,
  );
  assert.throws(
    () => as(tenantA, insertDelegation('service-a', 'journey.edit', 1)),
    /service principal/,
  );
  assert.match(
    as(tenantA, insertDelegation('human-b', 'journey.edit', 8)),
    /\nINSERT 0 1\nCOMMIT$/,
  );

  // RLS: tenant B มองไม่เห็นแถวใดของ tenant A ในทุกตารางของ J5.1
  for (const table of [
    'jr_journey_heads',
    'jr_journey_drafts',
    'jr_authoring_command_receipts',
    'jr_review_candidates',
    'jr_review_decisions',
    'jr_template_heads',
    'jr_template_drafts',
    'jr_template_versions',
    'jr_template_provenance',
    'jr_authoring_rollout_state',
    'iam_authoring_subjects',
    'iam_authoring_delegations',
  ]) {
    assert.match(
      as(tenantB, `SELECT count(*) FROM ${table} WHERE tenant_id = '${tenantA}'`),
      /\n0\nCOMMIT$/,
      `${table} ต้องไม่รั่วข้าม tenant`,
    );
  }
});

test('J5.1 bootstrap คงสิทธิ์ตาม migration: state ลบไม่ได้, หลักฐาน append-only, IAM อ่านอย่างเดียว', () => {
  for (const [table, expected] of [
    ['jr_journey_heads', 't|t|t|f'],
    ['jr_authoring_command_receipts', 't|t|t|f'],
    ['jr_review_candidates', 't|t|t|f'],
    ['jr_authoring_outbox', 't|t|t|f'],
    ['jr_template_heads', 't|t|t|f'],
    ['jr_template_upgrade_applications', 't|t|t|f'],
    ['jr_authoring_rollout_state', 't|t|t|f'],
    ['jr_journey_drafts', 't|t|f|f'],
    ['jr_review_decisions', 't|t|f|f'],
    ['jr_authoring_audit', 't|t|f|f'],
    ['jr_template_drafts', 't|t|f|f'],
    ['jr_template_versions', 't|t|f|f'],
    ['jr_template_provenance', 't|t|f|f'],
    ['iam_authoring_delegations', 't|t|f|f'],
    ['iam_authoring_delegation_revocations', 't|t|f|f'],
    ['iam_authoring_subjects', 't|f|f|f'],
    ['iam_authoring_capability_grants', 't|f|f|f'],
    ['iam_authoring_scope_versions', 't|f|f|f'],
  ] as const) {
    assert.equal(
      queryAsOwner(
        `SELECT has_table_privilege('dcontact_app', '${table}', 'SELECT'), has_table_privilege('dcontact_app', '${table}', 'INSERT'), has_table_privilege('dcontact_app', '${table}', 'UPDATE'), has_table_privilege('dcontact_app', '${table}', 'DELETE');`,
      ),
      expected,
      table,
    );
  }
});

test('S2.1 LINE persistence: RLS ทุกตาราง, bootstrap คงสิทธิ์ตาม migration และ append-only evidence', () => {
  const tables = [
    ['dl_provider_submission_attempts', 't|t|f|f'],
    ['dl_line_audit_events', 't|t|f|f'],
    ['dl_line_scope_gates', 't|t|t|f'],
    ['dl_line_credential_refs', 't|t|t|f'],
    ['dl_line_allowlist_entries', 't|t|t|f'],
    ['dl_line_run_authorizations', 't|t|t|f'],
    ['dl_line_cap_ledger', 't|t|t|f'],
    ['dl_line_webhook_inbox', 't|t|t|f'],
    ['dl_line_touch_correlations', 't|t|t|f'],
  ] as const;
  for (const [table, expected] of tables) {
    assert.equal(
      queryAsOwner(
        `SELECT has_table_privilege('dcontact_app', '${table}', 'SELECT'), has_table_privilege('dcontact_app', '${table}', 'INSERT'), has_table_privilege('dcontact_app', '${table}', 'UPDATE'), has_table_privilege('dcontact_app', '${table}', 'DELETE');`,
      ),
      expected,
      table,
    );
    assert.equal(
      queryAsOwner(
        `SELECT relrowsecurity FROM pg_class WHERE relname = '${table}'; SELECT count(*) FROM pg_policies WHERE tablename = '${table}' AND policyname = 'tenant_isolation' AND qual IS NOT NULL AND with_check IS NOT NULL;`,
      ),
      't\n1',
      `${table} ต้องมี RLS + tenant_isolation ทั้ง USING/WITH CHECK`,
    );
  }
  // ไม่มี tenant context = ไม่เห็นอะไรเลยแม้แถวจะมีอยู่
  for (const [table] of tables) {
    assert.equal(queryAsApplicationRole(`SELECT count(*) FROM ${table};`), '0', table);
  }
});
