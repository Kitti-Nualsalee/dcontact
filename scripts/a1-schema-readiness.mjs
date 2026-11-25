import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findDestructiveStatements } from './cxa-s2-schema-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const composeArguments = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];

/**
 * A1.1 (#406): schema gate of the Platform control plane - migrations must pass both fresh and upgrade,
 * be expand-only, and privileges must be fully separated: `dcontact_platform` sees only `pf_*` + tenants metadata,
 * `dcontact_app` does not see `pf_*`, and no role can edit/delete append-only evidence
 */
export const A1_MIGRATIONS = Object.freeze([
  '20260924090000_add_a1_platform_control_plane',
  // A1.3 (#408): the retry action kind lives in a separate file from the column used by scheduling
  '20260924100000_add_a1_3_action_kind',
  '20260924100100_add_a1_3_step_scheduling',
  // A1.4 (#409): invitation outbox + tenant bootstrap role (#388 decision)
  '20260924110000_add_a1_4_invitation_outbox',
  // A1.5 (#410): the action kind lives in a separate file from the plan catalog/baseline that uses it
  '20260924120000_add_a1_5_action_kind',
  '20260924120100_add_a1_5_bootstrap',
  // A1.6 (#411): durable operator command of the Platform API
  '20260924130000_add_a1_6_operator_commands',
  // A1.5b (#441): guard that allows editing the first admin email under conditions + revision
  '20260924140000_add_a1_5b_first_admin_email_change',
]);

export const CANONICAL_A1_TABLES = Object.freeze([
  'pf_bootstrap_templates',
  'pf_provisioning_requests',
  'pf_provisioning_steps',
  'pf_provisioning_step_receipts',
  'pf_command_receipts',
  'pf_identity_reservations',
  'pf_action_history',
  'pf_invitations',
  'pf_plan_versions',
  'pf_request_payload_revisions',
  'pf_operator_commands',
  'pf_first_admin_email_revisions',
]);

export const APPEND_ONLY_A1_TABLES = Object.freeze([
  'pf_provisioning_step_receipts',
  'pf_command_receipts',
  'pf_action_history',
  'pf_request_payload_revisions',
  'pf_first_admin_email_revisions',
]);

/** Tables the control-plane role may have privileges on - everything else must be zero (no reading business data) */
export const PLATFORM_ROLE_TABLES = Object.freeze([...CANONICAL_A1_TABLES, 'tenants']);

export const REQUIRED_A1_CONSTRAINTS = Object.freeze([
  'pf_bootstrap_templates_values_check',
  'pf_provisioning_requests_values_check',
  'pf_provisioning_requests_terminal_check',
  'pf_provisioning_steps_values_check',
  'pf_provisioning_step_receipts_values_check',
  'pf_command_receipts_values_check',
  'pf_identity_reservations_values_check',
  'pf_action_history_values_check',
  'tenants_provisioning_placeholder_check',
  'pf_provisioning_steps_attempt_floor_check',
  'pf_invitations_values_check',
  'pf_plan_versions_values_check',
  'pf_request_payload_revisions_values_check',
  'tenant_plan_bindings_values_check',
  'business_hours_values_check',
  'pf_operator_commands_values_check',
  'pf_first_admin_email_revisions_values_check',
]);

export const REQUIRED_A1_UNIQUE_INDEXES = Object.freeze([
  'pf_bootstrap_templates_pin_key',
  'pf_provisioning_requests_tenant_id_key',
  'pf_provisioning_requests_idempotency_key_hash_key',
  'pf_provisioning_requests_binding_key',
  'pf_provisioning_steps_ordinal_key',
  'pf_provisioning_step_receipts_attempt_key',
  'pf_command_receipts_idempotency_key_hash_key',
  'tenants_primary_domain_key',
  'pf_invitations_generation_key',
  'pf_plan_versions_pin_key',
  'pf_request_payload_revisions_revision_key',
  'pf_operator_commands_idempotency_key_hash_key',
  // only one unfinished execute per request at a time (partial unique)
  'pf_operator_commands_single_execute_key',
  'pf_first_admin_email_revisions_revision_key',
]);

export const REQUIRED_A1_TRIGGERS = Object.freeze([
  'pf_provisioning_step_receipts_append_only',
  'pf_command_receipts_append_only',
  'pf_action_history_append_only',
  'pf_provisioning_requests_retained',
  'pf_provisioning_steps_retained',
  'pf_identity_reservations_retained',
  'pf_bootstrap_templates_retained',
  'pf_provisioning_requests_guard',
  'pf_provisioning_steps_guard',
  'pf_identity_reservations_guard',
  'pf_bootstrap_templates_guard',
  'tenants_lifecycle_guard',
  'pf_invitations_retained',
  'pf_invitations_insert_guard',
  'pf_invitations_guard',
  'pf_plan_versions_retained',
  'pf_plan_versions_guard',
  'pf_request_payload_revisions_append_only',
  'pf_operator_commands_retained',
  'pf_operator_commands_guard',
  'pf_first_admin_email_revisions_append_only',
]);

/**
 * #388 decision "Tenant bootstrap write boundary": `dcontact_provisioner` may hold only these table privileges
 * (UPDATE keycloak_id and SELECT id/lifecycle of tenants are column grants, so they are not in the list)
 */
export const PROVISIONER_TABLES = Object.freeze([
  'users',
  // A1.5 (#410): operational baseline
  'teams',
  'queues',
  'tenant_settings',
  'tenant_plan_bindings',
  'business_hours',
]);
export const PROVISIONER_TABLE_PRIVILEGES = Object.freeze(
  PROVISIONER_TABLES.flatMap((table) => [
    [table, 'SELECT'],
    [table, 'INSERT'],
  ]),
);

/** steps/receipts/command/reservation/history/invitations/payload+email revisions/operator commands + plan pin */
export const MINIMUM_A1_COMPOSITE_FOREIGN_KEYS = 11;

function sqlArray(values) {
  return `ARRAY[${values.map((value) => `'${value}'`).join(',')}]`;
}

const tables = sqlArray(CANONICAL_A1_TABLES);

export const A1_SCHEMA_EVIDENCE_QUERY = `
  SELECT
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${tables}))
    || '|' ||
    (SELECT count(*) FROM pg_constraint
      WHERE contype = 'c' AND conname = ANY(${sqlArray(REQUIRED_A1_CONSTRAINTS)}))
    || '|' ||
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
        AND indexname = ANY(${sqlArray(REQUIRED_A1_UNIQUE_INDEXES)}))
    || '|' ||
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY(${sqlArray(REQUIRED_A1_TRIGGERS)}))
    || '|' ||
    (SELECT count(*) FROM pg_constraint AS fk
      JOIN pg_class AS child ON child.oid = fk.conrelid
      WHERE fk.contype = 'f' AND child.relname = ANY(${tables})
        AND array_length(fk.conkey, 1) > 1)
    || '|' ||
    (SELECT count(*) FROM information_schema.table_privileges
      WHERE grantee = 'dcontact_app' AND table_name = ANY(${tables}))
    || '|' ||
    (SELECT count(*) FROM information_schema.table_privileges
      WHERE grantee = 'dcontact_platform'
        AND (
          table_name <> ALL(${sqlArray(PLATFORM_ROLE_TABLES)})
          OR privilege_type IN ('DELETE', 'TRUNCATE')
          OR (privilege_type = 'UPDATE' AND table_name = ANY(${sqlArray([...APPEND_ONLY_A1_TABLES, 'tenants'])}))
        ))
    || '|' ||
    (SELECT count(*) FROM pg_roles WHERE rolname = 'dcontact_platform' AND NOT rolbypassrls AND NOT rolsuper)
    || '|' ||
    (SELECT count(*) FROM information_schema.table_privileges
      WHERE grantee = 'dcontact_provisioner'
        AND (table_name || ':' || privilege_type) <> ALL(${sqlArray(
          PROVISIONER_TABLE_PRIVILEGES.map(([table, privilege]) => `${table}:${privilege}`),
        )}))
    || '|' ||
    (SELECT count(*) FROM pg_roles WHERE rolname = 'dcontact_provisioner' AND NOT rolbypassrls AND NOT rolsuper)
    || '|' ||
    (SELECT count(*) FROM pg_policies
      WHERE tablename = ANY(${sqlArray(PROVISIONER_TABLES)}) AND policyname = 'provisioner_provisioning_only'
        AND permissive = 'RESTRICTIVE' AND roles = '{dcontact_provisioner}');
`
  .replace(/\s+/g, ' ')
  .trim();

export function parseA1SchemaEvidence(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)$/);
  if (!match) throw new TypeError('schema evidence must contain eleven numbers separated by |');
  const [
    ,
    tablesFound,
    checks,
    uniqueIndexes,
    triggers,
    compositeKeys,
    applicationPrivileges,
    forbiddenPlatformPrivileges,
    platformRole,
    forbiddenProvisionerPrivileges,
    provisionerRole,
    provisionerRestrictivePolicy,
  ] = match.map(Number);
  return {
    tables: tablesFound,
    checks,
    uniqueIndexes,
    triggers,
    compositeKeys,
    applicationPrivileges,
    forbiddenPlatformPrivileges,
    platformRole,
    forbiddenProvisionerPrivileges,
    provisionerRole,
    provisionerRestrictivePolicy,
    status:
      tablesFound === CANONICAL_A1_TABLES.length &&
      checks === REQUIRED_A1_CONSTRAINTS.length &&
      uniqueIndexes === REQUIRED_A1_UNIQUE_INDEXES.length &&
      triggers === REQUIRED_A1_TRIGGERS.length &&
      compositeKeys >= MINIMUM_A1_COMPOSITE_FOREIGN_KEYS &&
      // the tenant app does not see the control plane, and the control plane has no privilege outside metadata/delete/edit of evidence
      applicationPrivileges === 0 &&
      forbiddenPlatformPrivileges === 0 &&
      platformRole === 1 &&
      // the provisioner can write only bootstrap rows and cannot escape the PROVISIONING-only policy
      forbiddenProvisionerPrivileges === 0 &&
      provisionerRole === 1 &&
      provisionerRestrictivePolicy === PROVISIONER_TABLES.length
        ? 'PASS'
        : 'FAIL',
  };
}

function execute(command, arguments_, options = {}) {
  const result = spawnSync(command, arguments_, {
    cwd: repositoryRoot,
    encoding: 'utf8',
    env: process.env,
    ...options,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `${command} ${arguments_.join(' ')} failed with status ${result.status ?? result.error?.code ?? 'unknown'}`,
    );
  }
  return String(result.stdout ?? '').trim();
}

function postgres(...arguments_) {
  return execute('docker', [...composeArguments, 'exec', '-T', 'postgres', ...arguments_]);
}

function migrateTwice(databaseName) {
  const env = {
    ...process.env,
    DATABASE_URL: `postgresql://dcontact:dcontact@localhost:5433/${databaseName}?schema=public`,
  };
  for (let round = 0; round < 2; round += 1) {
    execute(pnpm, ['db:migrate'], { env });
    execute(pnpm, ['db:rls'], { env });
  }
}

function inspectDatabase(databaseName) {
  return parseA1SchemaEvidence(
    postgres('psql', '-tAc', A1_SCHEMA_EVIDENCE_QUERY, '-U', 'dcontact', databaseName),
  );
}

export function runA1SchemaReadiness() {
  const destructive = Object.fromEntries(
    A1_MIGRATIONS.map((name) => [
      name,
      findDestructiveStatements(
        readFileSync(
          resolve(repositoryRoot, 'packages/db/prisma/migrations', name, 'migration.sql'),
          'utf8',
        ),
      ),
    ]),
  );
  const expandOnly = Object.values(destructive).every((found) => found.length === 0);
  const existingDatabase = process.env.A1_ACCEPTANCE_DATABASE_NAME ?? 'dcontact';
  if (!/^[a-zA-Z0-9_]+$/.test(existingDatabase)) {
    throw new TypeError('A1_ACCEPTANCE_DATABASE_NAME contains an invalid database name');
  }
  const freshDatabase = `dcontact_a1_verify_${randomBytes(6).toString('hex')}`;

  migrateTwice(existingDatabase);
  const existing = inspectDatabase(existingDatabase);
  let fresh;
  postgres('createdb', '-U', 'dcontact', freshDatabase);
  try {
    migrateTwice(freshDatabase);
    fresh = inspectDatabase(freshDatabase);
  } finally {
    spawnSync(
      'docker',
      [
        ...composeArguments,
        'exec',
        '-T',
        'postgres',
        'dropdb',
        '--if-exists',
        '--force',
        '-U',
        'dcontact',
        freshDatabase,
      ],
      { cwd: repositoryRoot, encoding: 'utf8' },
    );
  }

  const summary = {
    type: 'schema.readiness',
    workflow: 'a1-platform-control-schema',
    status: expandOnly && existing.status === 'PASS' && fresh?.status === 'PASS' ? 'PASS' : 'FAIL',
    expandOnly,
    destructive,
    existing,
    fresh,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = runA1SchemaReadiness();
    if (summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
