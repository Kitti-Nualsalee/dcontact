import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const composeArguments = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];

/**
 * migration ของ S2 — enum values แยกไฟล์เพราะ Postgres ใช้ค่าใหม่ใน transaction เดียวกันไม่ได้
 * ไฟล์ที่สามเป็นด่าน Attempt/Touch ของ S2.2 (#364) ซึ่งอ้างค่า enum ที่ commit ไปแล้ว
 */
export const S2_MIGRATIONS = Object.freeze([
  '20260922160000_add_s2_line_enum_values',
  '20260922160100_add_s2_line_persistence',
  '20260923101500_add_s2_2_correlated_touch_guard',
]);

/** ตารางที่ S2.1 เพิ่มตาม Phase Contract #362 §3 */
export const CANONICAL_S2_TABLES = Object.freeze([
  'dl_provider_submission_attempts',
  'dl_line_scope_gates',
  'dl_line_credential_refs',
  'dl_line_allowlist_entries',
  'dl_line_run_authorizations',
  'dl_line_cap_ledger',
  'dl_line_webhook_inbox',
  'dl_line_touch_correlations',
  'dl_line_audit_events',
]);

/** หลักฐาน append-only: application role ต้อง INSERT ได้แต่ UPDATE/DELETE ไม่ได้ */
export const APPEND_ONLY_S2_TABLES = Object.freeze([
  'dl_provider_submission_attempts',
  'dl_line_audit_events',
]);

/**
 * CHECK ที่เป็น invariant ของสัญญา (ไม่ใช่แค่รูปแบบ) — รวมตัวที่เพิ่มบน dl_outbox_entries/cg_touches
 * หายตัวเดียวแปลว่ามีเส้นทางที่ adapter ทำผิดสัญญาได้โดยไม่มีใครเห็น
 */
export const REQUIRED_S2_CONSTRAINTS = Object.freeze([
  'dl_outbox_entries_line_binding_check',
  'dl_provider_submission_attempts_attempt_no_check',
  'dl_provider_submission_attempts_class_check',
  'dl_provider_submission_attempts_rejection_check',
  'dl_provider_submission_attempts_acceptance_check',
  'dl_line_scope_gates_scope_check',
  'dl_line_scope_gates_kill_check',
  'dl_line_scope_gates_config_check',
  'dl_line_credential_refs_kind_check',
  'dl_line_credential_refs_status_check',
  'dl_line_allowlist_entries_values_check',
  'dl_line_run_authorizations_caps_check',
  'dl_line_run_authorizations_approval_check',
  'dl_line_run_authorizations_consume_check',
  'dl_line_cap_ledger_values_check',
  'dl_line_webhook_inbox_values_check',
  'dl_line_webhook_inbox_state_check',
  'dl_line_touch_correlations_values_check',
  'dl_line_touch_correlations_state_check',
  'dl_line_audit_events_values_check',
  'cg_touches_response_evidence_check',
  'cg_touches_provider_accepted_evidence_check',
]);

/** identity/idempotency boundary ตาม #362 §3 รวม partial unique */
export const REQUIRED_S2_UNIQUE_INDEXES = Object.freeze([
  'dl_outbox_entries_tenant_delivery_request_adapter_key',
  'dl_outbox_entries_tenant_delivery_adapter_key',
  'dl_provider_submission_attempts_attempt_key',
  'dl_provider_submission_attempts_request_id_key',
  'dl_line_scope_gates_scope_key',
  'dl_line_credential_refs_version_key',
  'dl_line_credential_refs_one_active_key',
  'dl_line_allowlist_entries_tuple_key',
  'dl_line_run_authorizations_proposal_key',
  'dl_line_run_authorizations_consumed_delivery_key',
  'dl_line_cap_ledger_reservation_key',
  'dl_line_webhook_inbox_event_key',
  'dl_line_touch_correlations_evidence_key',
  'dl_line_touch_correlations_inbox_key',
  'dl_line_touch_correlations_bound_attempt_key',
  'dl_line_audit_events_event_key',
  'cg_touches_tenant_response_evidence_key',
]);

/** trigger ที่บังคับ append-only, CAS, one-shot, kill latch และ identity คงที่ */
export const REQUIRED_S2_TRIGGERS = Object.freeze([
  'dl_outbox_entries_identity_guard',
  'dl_provider_submission_attempts_immutable',
  'dl_provider_submission_attempts_sequence_guard',
  'dl_line_audit_events_immutable',
  'dl_line_scope_gates_guard',
  'dl_line_allowlist_entries_guard',
  'dl_line_run_authorizations_guard',
  'dl_line_cap_ledger_guard',
  'dl_line_credential_refs_guard',
  'dl_line_webhook_inbox_guard',
  'dl_line_touch_correlations_guard',
  'cg_touches_evidence_guard',
]);

/** composite FK ขั้นต่ำ — ทุกเส้นที่อ้าง entity อื่นผูก tenant_id ร่วม (บางเส้นผูก adapter ด้วย) */
export const MINIMUM_S2_COMPOSITE_FOREIGN_KEYS = 11;

/** ค่า enum ใหม่บน type เดิม */
export const REQUIRED_S2_ENUM_VALUES = Object.freeze([
  ['DlDeliveryAdapter', 'LINE_MESSAGING_API'],
  ['CgFactOutcome', 'PROVIDER_ACCEPTED'],
]);

/**
 * คำสั่งที่ migration แบบ expand-only ห้ามมี (#362 §11) — rollback ทำด้วย switch off/kill/drain
 * และ forward-fix เท่านั้น จึงไม่มี down migration และไม่มีคำสั่งที่ทำลาย/เขียนทับข้อมูลเดิม
 */
export const DESTRUCTIVE_SQL_PATTERNS = Object.freeze([
  /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT|POLICY|TRIGGER|FUNCTION)\b/i,
  /\bRENAME\s+(TO|COLUMN|CONSTRAINT|VALUE)\b/i,
  /\bTRUNCATE\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bUPDATE\s+"?[a-z_]+"?\s+SET\b/i,
  /\bALTER\s+COLUMN\b[^;]*\b(TYPE|SET\s+NOT\s+NULL|DROP\s+DEFAULT)\b/i,
]);

/** คืนรายการ pattern ที่เจอหลังตัด comment ออก — ว่าง = expand-only */
export function findDestructiveStatements(sql) {
  const statements = String(sql)
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');
  return DESTRUCTIVE_SQL_PATTERNS.filter((pattern) => pattern.test(statements)).map(String);
}

function sqlArray(values) {
  return `ARRAY[${values.map((value) => `'${value}'`).join(',')}]`;
}

const tableArray = sqlArray(CANONICAL_S2_TABLES);
const enumPairs = REQUIRED_S2_ENUM_VALUES.map(
  ([type, value]) => `(type.typname = '${type}' AND value.enumlabel = '${value}')`,
).join(' OR ');

export const S2_SCHEMA_EVIDENCE_QUERY = `
  SELECT
    (SELECT count(*) FROM information_schema.tables
      WHERE table_schema = 'public' AND table_name = ANY(${tableArray}))
    || '|' ||
    (SELECT count(*) FROM pg_class AS relation
      JOIN pg_namespace AS namespace ON namespace.oid = relation.relnamespace
      WHERE namespace.nspname = 'public'
        AND relation.relname = ANY(${tableArray})
        AND relation.relrowsecurity)
    || '|' ||
    (SELECT count(DISTINCT tablename) FROM pg_policies
      WHERE schemaname = 'public'
        AND policyname = 'tenant_isolation'
        AND qual IS NOT NULL AND with_check IS NOT NULL
        AND tablename = ANY(${tableArray}))
    || '|' ||
    (SELECT count(*) FROM pg_constraint
      WHERE contype = 'c' AND conname = ANY(${sqlArray(REQUIRED_S2_CONSTRAINTS)}))
    || '|' ||
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
        AND indexname = ANY(${sqlArray(REQUIRED_S2_UNIQUE_INDEXES)}))
    || '|' ||
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY(${sqlArray(REQUIRED_S2_TRIGGERS)}))
    || '|' ||
    (SELECT count(*) FROM pg_constraint AS fk
      JOIN pg_class AS child ON child.oid = fk.conrelid
      WHERE fk.contype = 'f'
        AND child.relname = ANY(${tableArray})
        AND array_length(fk.conkey, 1) > 1)
    || '|' ||
    (SELECT count(*) FROM pg_enum AS value
      JOIN pg_type AS type ON type.oid = value.enumtypid
      WHERE ${enumPairs})
    || '|' ||
    (SELECT count(*) FROM information_schema.table_privileges
      WHERE grantee = 'dcontact_app'
        AND (
          (privilege_type = 'DELETE' AND table_name = ANY(${tableArray}))
          OR (privilege_type = 'UPDATE' AND table_name = ANY(${sqlArray(APPEND_ONLY_S2_TABLES)}))
        ));
`
  .replace(/\s+/g, ' ')
  .trim();

export function parseS2SchemaEvidence(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)$/);
  if (!match) {
    throw new TypeError('schema evidence ต้องมีเก้าตัวเลขคั่นด้วย |');
  }
  const [
    ,
    tables,
    rlsEnabled,
    tenantPolicies,
    checks,
    uniqueIndexes,
    triggers,
    compositeKeys,
    enumValues,
    forbiddenApplicationPrivileges,
  ] = match.map(Number);
  const expectedTables = CANONICAL_S2_TABLES.length;
  return {
    tables,
    rlsEnabled,
    tenantPolicies,
    checks,
    uniqueIndexes,
    triggers,
    compositeKeys,
    enumValues,
    forbiddenApplicationPrivileges,
    status:
      tables === expectedTables &&
      rlsEnabled === expectedTables &&
      tenantPolicies === expectedTables &&
      checks === REQUIRED_S2_CONSTRAINTS.length &&
      uniqueIndexes === REQUIRED_S2_UNIQUE_INDEXES.length &&
      triggers === REQUIRED_S2_TRIGGERS.length &&
      compositeKeys >= MINIMUM_S2_COMPOSITE_FOREIGN_KEYS &&
      enumValues === REQUIRED_S2_ENUM_VALUES.length &&
      // application role ลบไม่ได้ทุกตาราง และแก้หลักฐาน append-only ไม่ได้
      forbiddenApplicationPrivileges === 0
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
      `${command} ${arguments_.join(' ')} ล้มเหลวด้วย status ${result.status ?? result.error?.code ?? 'unknown'}`,
    );
  }
  return String(result.stdout ?? '').trim();
}

function postgres(...arguments_) {
  return execute('docker', [...composeArguments, 'exec', '-T', 'postgres', ...arguments_]);
}

function databaseUrl(databaseName) {
  return `postgresql://dcontact:dcontact@localhost:5433/${databaseName}?schema=public`;
}

/**
 * migrate + bootstrap RLS แล้วรันซ้ำอีกรอบ: รอบสองต้องไม่มี migration ค้างและ bootstrap ต้อง
 * idempotent — นี่คือเส้นทาง forward-fix (ไม่มี down migration) ที่ต้องรันซ้ำได้อย่างปลอดภัย
 */
function migrateTwice(databaseName) {
  const env = { ...process.env, DATABASE_URL: databaseUrl(databaseName) };
  for (let round = 0; round < 2; round += 1) {
    execute(pnpm, ['db:migrate'], { env });
    execute(pnpm, ['db:rls'], { env });
  }
}

function inspectDatabase(databaseName) {
  return parseS2SchemaEvidence(
    postgres('psql', '-tAc', S2_SCHEMA_EVIDENCE_QUERY, '-U', 'dcontact', databaseName),
  );
}

/**
 * S2.1 schema gate: ตรวจทั้ง database ที่ upgrade มาจากของเดิม (มี S1/J-series อยู่แล้ว) และ
 * fresh migrate เพราะ migration ที่เขียนมืออาจผ่านทางหนึ่งแต่พังอีกทาง รวมถึง static scan ว่า
 * migration ของ S2.1 เป็น expand-only
 */
export function runCxaS2SchemaReadiness() {
  const destructive = Object.fromEntries(
    S2_MIGRATIONS.map((name) => [
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

  const existingDatabase = process.env.CXA_ACCEPTANCE_DATABASE_NAME ?? 'dcontact';
  if (!/^[a-zA-Z0-9_]+$/.test(existingDatabase)) {
    throw new TypeError('CXA_ACCEPTANCE_DATABASE_NAME มีชื่อฐานข้อมูลไม่ถูกต้อง');
  }
  const freshDatabase = `dcontact_cxa_s2_verify_${randomBytes(6).toString('hex')}`;

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
    workflow: 'cx-automation-s2-schema',
    status: expandOnly && existing.status === 'PASS' && fresh?.status === 'PASS' ? 'PASS' : 'FAIL',
    expandOnly,
    destructive,
    existing,
    fresh,
    canonicalTables: CANONICAL_S2_TABLES,
    requiredConstraints: REQUIRED_S2_CONSTRAINTS,
    requiredUniqueIndexes: REQUIRED_S2_UNIQUE_INDEXES,
    requiredTriggers: REQUIRED_S2_TRIGGERS,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = runCxaS2SchemaReadiness();
    if (summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
