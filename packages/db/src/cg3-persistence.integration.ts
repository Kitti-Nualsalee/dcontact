import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import test from 'node:test';

const repositoryRoot = resolve(process.cwd(), '../..');

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

test('CG3 migration สร้าง canonical tables, compatibility columns และ validated tenant constraints', () => {
  const tables = [
    'cg_preferences',
    'cg_policies',
    'cg_holiday_calendar_entries',
    'cg_callback_requests',
    'cg_contact_state_heads',
    'cg_event_outbox',
    'cg_command_receipts',
    'cg_audit_logs',
    'cg_consumer_acknowledgements',
  ];
  assert.equal(
    queryAsOwner(
      `SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN (${tables
        .map((table) => `'${table}'`)
        .join(',')});`,
    ),
    String(tables.length),
  );
  assert.equal(
    queryAsOwner(
      `SELECT count(*) FROM information_schema.columns WHERE table_schema = 'public' AND
       (table_name, column_name) IN (
         ('cg_reservations', 'authorization_aggregate_version'),
         ('cg_reservations', 'authorization_policy_version'),
         ('cg_reservations', 'authorization_decision_id'),
         ('cg_decision_logs', 'aggregate_version'),
         ('cg_decision_logs', 'preference_version'),
         ('cg_decision_logs', 'next_eligible_at'),
         ('cg_decision_logs', 'timezone_source'),
         ('cg_decision_logs', 'matched_scope'),
         ('cg_decision_logs', 'matched_window_ref'),
         ('cg_decision_logs', 'exception_mode'),
         ('cg_decision_logs', 'exception_ref')
       );`,
    ),
    '11',
  );
  assert.equal(
    queryAsOwner(
      `SELECT count(*) FROM pg_constraint
       WHERE conname IN (
         'cg_restrictions_tenant_contact_fkey',
         'cg_restrictions_tenant_identity_fkey',
         'cg_consents_tenant_contact_fkey',
         'cg_consents_tenant_identity_fkey'
       ) AND convalidated;`,
    ),
    '4',
  );
});

test('CG3 tables บังคับ RLS สอง tenant, composite binding และ immutable application grants', (t) => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const contactA = randomUUID();
  const contactB = randomUUID();
  const preferenceId = randomUUID();
  const seriesId = randomUUID();
  const suffix = tenantA.slice(0, 8);

  queryAsOwner(
    `BEGIN;
     INSERT INTO tenants (id, name, slug, sip_domain) VALUES
       ('${tenantA}', 'CG3 RLS A ${suffix}', 'cg3-rls-a-${suffix}', 'cg3-rls-a-${suffix}.test'),
       ('${tenantB}', 'CG3 RLS B ${suffix}', 'cg3-rls-b-${suffix}', 'cg3-rls-b-${suffix}.test');
     INSERT INTO contacts (id, tenant_id) VALUES
       ('${contactA}', '${tenantA}'),
       ('${contactB}', '${tenantB}');
     INSERT INTO cg_preferences (
       id, tenant_id, series_id, version, contact_id, scope_hash, decision,
       preferred_windows, source_kind, occurred_at, effective_from, mutation_kind,
       request_hash, evidence_ref, actor_class
     ) VALUES (
       '${preferenceId}', '${tenantA}', '${seriesId}', 1, '${contactA}', repeat('a', 64),
       'BLOCK', '[]', 'CUSTOMER', now(), now(), 'SET', repeat('b', 64),
       'evidence:rls', 'CUSTOMER'
     );
     COMMIT;`,
  );
  t.after(() => {
    queryAsOwner(
      `DELETE FROM cg_preferences WHERE tenant_id IN ('${tenantA}', '${tenantB}');
       DELETE FROM contacts WHERE tenant_id IN ('${tenantA}', '${tenantB}');
       DELETE FROM tenants WHERE id IN ('${tenantA}', '${tenantB}');`,
    );
  });

  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantB}', true);
       SELECT count(*) FROM cg_preferences WHERE id = '${preferenceId}'; COMMIT;`,
    ),
    /\n0\nCOMMIT$/,
  );
  assert.match(
    queryAsApplicationRole(
      `BEGIN; SELECT set_config('app.tenant_id', '${tenantA}', true);
       SELECT count(*) FROM cg_preferences WHERE id = '${preferenceId}'; COMMIT;`,
    ),
    /\n1\nCOMMIT$/,
  );

  for (const crossTenantInsert of [
    `INSERT INTO cg_preferences (
           id, tenant_id, series_id, version, contact_id, scope_hash, decision,
           preferred_windows, source_kind, occurred_at, effective_from, mutation_kind,
           request_hash, evidence_ref, actor_class
         ) VALUES (
           '${randomUUID()}', '${tenantA}', '${randomUUID()}', 1, '${contactB}', repeat('c', 64),
           'BLOCK', '[]', 'CUSTOMER', now(), now(), 'SET', repeat('d', 64),
           'evidence:swap', 'CUSTOMER'
         );`,
    `INSERT INTO cg_restrictions (
       id, tenant_id, contact_id, type, scope, overridable, reason_code, source, starts_at, created_by
     ) VALUES (
       '${randomUUID()}', '${tenantA}', '${contactB}', 'DNC', 'CONTACT', false,
       'DNC_GLOBAL', 'TEST', now(), 'integration-test'
     );`,
    `INSERT INTO cg_consents (
       id, tenant_id, contact_id, purpose, channel, status, lawful_basis, evidence, updated_at
     ) VALUES (
       '${randomUUID()}', '${tenantA}', '${contactB}', 'MARKETING', 'EMAIL',
       'GRANTED', 'CONSENT', '{}', now()
     );`,
  ]) {
    assert.throws(() => queryAsOwner(crossTenantInsert), /foreign key constraint/i);
  }

  assert.equal(
    queryAsOwner(
      `SELECT count(*) FROM pg_policies
       WHERE schemaname = 'public'
         AND tablename IN (
           'cg_preferences', 'cg_policies', 'cg_holiday_calendar_entries',
           'cg_callback_requests', 'cg_contact_state_heads', 'cg_event_outbox',
           'cg_command_receipts', 'cg_audit_logs', 'cg_consumer_acknowledgements'
         )
         AND policyname = 'tenant_isolation'
         AND qual IS NOT NULL
         AND with_check IS NOT NULL;`,
    ),
    '9',
  );
  assert.equal(
    queryAsOwner(
      `SELECT count(*) FROM (VALUES
         ('cg_preferences'), ('cg_holiday_calendar_entries'), ('cg_callback_requests'),
         ('cg_command_receipts'), ('cg_audit_logs'), ('cg_consumer_acknowledgements')
       ) AS immutable(table_name)
       WHERE has_table_privilege('dcontact_app', table_name, 'UPDATE')
          OR has_table_privilege('dcontact_app', table_name, 'DELETE');`,
    ),
    '0',
  );
  assert.throws(
    () =>
      queryAsApplicationRole(
        `BEGIN; SELECT set_config('app.tenant_id', '${tenantA}', true);
         UPDATE cg_preferences SET actor_class = 'MUTATED' WHERE id = '${preferenceId}'; COMMIT;`,
      ),
    /permission denied/i,
  );
});
