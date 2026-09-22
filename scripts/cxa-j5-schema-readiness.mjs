import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const composeArguments = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];

/** ตารางที่ J5.1 (#339) เพิ่ม — authoring/template/review/receipt/audit/outbox/rollout และ IAM store */
export const CANONICAL_J5_TABLES = Object.freeze([
  'jr_journey_heads',
  'jr_journey_drafts',
  'jr_authoring_command_receipts',
  'jr_review_candidates',
  'jr_review_decisions',
  'jr_authoring_audit',
  'jr_authoring_outbox',
  'jr_template_heads',
  'jr_template_drafts',
  'jr_template_versions',
  'jr_template_provenance',
  'jr_template_upgrade_applications',
  'jr_authoring_rollout_state',
  'iam_authoring_subjects',
  'iam_authoring_capability_grants',
  'iam_authoring_delegations',
  'iam_authoring_delegation_revocations',
  'iam_authoring_scope_versions',
]);

/**
 * CHECK ที่เป็น invariant ไม่ใช่แค่รูปแบบ — หายตัวเดียวก็ถือว่า migration ไม่ผ่าน เพราะของที่กันไว้
 * (active ครึ่งชุด, receipt จบแบบไม่มีผล, built-in ใน tenant table, delegation เกิน 8 ชม.)
 * จะไม่มีใครเห็นจนกว่าข้อมูลเสียจริง
 */
export const REQUIRED_J5_CONSTRAINTS = Object.freeze([
  'jr_journey_heads_active_check',
  'jr_journey_heads_version_check',
  'jr_journey_drafts_revision_check',
  'jr_authoring_command_receipts_state_check',
  'jr_review_decisions_capability_check',
  'jr_authoring_audit_code_check',
  'jr_authoring_outbox_state_check',
  'jr_template_heads_active_check',
  'jr_template_versions_origin_check',
  'jr_template_upgrade_applications_state_check',
  'jr_authoring_rollout_state_stage_check',
  'iam_authoring_subjects_values_check',
  'iam_authoring_capability_grants_capability_check',
  'iam_authoring_capability_grants_scope_check',
  'iam_authoring_delegations_capability_check',
  'iam_authoring_delegations_window_check',
]);

/** identity/idempotency boundary — รวม partial unique ของ candidate ที่กำลัง review */
export const REQUIRED_J5_UNIQUE_INDEXES = Object.freeze([
  'jr_journey_heads_tenant_journey_key',
  'jr_journey_drafts_revision_key',
  'jr_journey_drafts_binding_key',
  'jr_authoring_command_receipts_idempotency_key',
  'jr_review_candidates_one_in_review_key',
  'jr_review_decisions_reviewer_key',
  'jr_authoring_outbox_event_key',
  'jr_template_heads_tenant_template_key',
  'jr_template_drafts_binding_key',
  'jr_template_versions_version_key',
  'jr_template_provenance_draft_key',
  'jr_template_upgrade_applications_idempotency_key',
  'jr_authoring_rollout_state_tenant_key',
  'iam_authoring_subjects_subject_key',
  'iam_authoring_capability_grants_scope_key',
  'iam_authoring_delegation_revocations_delegation_key',
]);

/** trigger ที่บังคับ append-only, CAS, pinned binding และ stage เดินหน้าอย่างเดียว */
export const REQUIRED_J5_TRIGGERS = Object.freeze([
  'jr_journey_drafts_immutable',
  'jr_review_decisions_immutable',
  'jr_authoring_audit_immutable',
  'jr_template_drafts_immutable',
  'jr_template_versions_immutable',
  'jr_template_provenance_immutable',
  'iam_authoring_delegations_immutable',
  'iam_authoring_delegation_revocations_immutable',
  'jr_journey_heads_guard',
  'jr_template_heads_guard',
  'jr_authoring_command_receipts_guard',
  'jr_review_candidates_guard',
  'jr_authoring_outbox_guard',
  'jr_template_upgrade_applications_guard',
  'jr_authoring_rollout_guard',
  'jr_template_provenance_source_guard',
  'iam_authoring_delegations_human_guard',
]);

/** composite FK ขั้นต่ำ — ทุกตารางลูกที่อ้าง entity อื่นต้องผูกด้วย tenant_id ร่วมเสมอ */
export const MINIMUM_J5_COMPOSITE_FOREIGN_KEYS = 19;

function sqlArray(values) {
  return `ARRAY[${values.map((value) => `'${value}'`).join(',')}]`;
}

const tableArray = sqlArray(CANONICAL_J5_TABLES);
export const J5_SCHEMA_EVIDENCE_QUERY = `
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
      WHERE contype = 'c' AND conname = ANY(${sqlArray(REQUIRED_J5_CONSTRAINTS)}))
    || '|' ||
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public' AND indexdef ILIKE 'CREATE UNIQUE INDEX%'
        AND indexname = ANY(${sqlArray(REQUIRED_J5_UNIQUE_INDEXES)}))
    || '|' ||
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY(${sqlArray(REQUIRED_J5_TRIGGERS)}))
    || '|' ||
    (SELECT count(*) FROM pg_constraint AS fk
      JOIN pg_class AS child ON child.oid = fk.conrelid
      WHERE fk.contype = 'f'
        AND child.relname = ANY(${tableArray})
        AND array_length(fk.conkey, 1) > 1)
    || '|' ||
    (SELECT count(*) FROM information_schema.table_privileges
      WHERE grantee = 'dcontact_app' AND privilege_type = 'DELETE'
        AND table_name = ANY(${tableArray}));
`
  .replace(/\s+/g, ' ')
  .trim();

export function parseJ5SchemaEvidence(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)$/);
  if (!match) {
    throw new TypeError('schema evidence ต้องมีแปดตัวเลขคั่นด้วย |');
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
    applicationDeletes,
  ] = match.map(Number);
  const expectedTables = CANONICAL_J5_TABLES.length;
  return {
    tables,
    rlsEnabled,
    tenantPolicies,
    checks,
    uniqueIndexes,
    triggers,
    compositeKeys,
    applicationDeletes,
    status:
      tables === expectedTables &&
      rlsEnabled === expectedTables &&
      tenantPolicies === expectedTables &&
      checks === REQUIRED_J5_CONSTRAINTS.length &&
      uniqueIndexes === REQUIRED_J5_UNIQUE_INDEXES.length &&
      triggers === REQUIRED_J5_TRIGGERS.length &&
      compositeKeys >= MINIMUM_J5_COMPOSITE_FOREIGN_KEYS &&
      // application role ลบแถวของ J5.1 ไม่ได้เลยทุกตาราง
      applicationDeletes === 0
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
      `${command} ล้มเหลวด้วย status ${result.status ?? result.error?.code ?? 'unknown'}`,
    );
  }
  return String(result.stdout ?? '').trim();
}

function inspectDatabase(databaseName) {
  return parseJ5SchemaEvidence(
    execute('docker', [
      ...composeArguments,
      'exec',
      '-T',
      'postgres',
      'psql',
      '-tAc',
      J5_SCHEMA_EVIDENCE_QUERY,
      '-U',
      'dcontact',
      databaseName,
    ]),
  );
}

/**
 * J5-MG01: migration ของ J5.1 ครบทั้งบน database ที่ upgrade มาจากของเดิม (มี J1–J3 และ J5.0
 * อยู่แล้ว) และบน fresh migrate — ต้องตรวจทั้งสองทางเพราะ migration ที่เขียนมืออาจผ่านทางหนึ่ง
 * แต่พังอีกทาง
 */
export function runCxaJ5SchemaReadiness() {
  const existingDatabase = process.env.CXA_ACCEPTANCE_DATABASE_NAME ?? 'dcontact';
  if (!/^[a-zA-Z0-9_]+$/.test(existingDatabase)) {
    throw new TypeError('CXA_ACCEPTANCE_DATABASE_NAME มีชื่อฐานข้อมูลไม่ถูกต้อง');
  }
  const freshDatabase = `dcontact_cxa_j5_verify_${randomBytes(6).toString('hex')}`;

  execute(pnpm, ['db:migrate']);
  const existing = inspectDatabase(existingDatabase);
  let fresh;

  execute('docker', [
    ...composeArguments,
    'exec',
    '-T',
    'postgres',
    'createdb',
    '-U',
    'dcontact',
    freshDatabase,
  ]);
  try {
    execute(pnpm, ['db:migrate'], {
      env: {
        ...process.env,
        DATABASE_URL: `postgresql://dcontact:dcontact@localhost:5433/${freshDatabase}?schema=public`,
      },
    });
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
    workflow: 'cx-automation-j5-schema',
    status: existing.status === 'PASS' && fresh?.status === 'PASS' ? 'PASS' : 'FAIL',
    existing,
    fresh,
    canonicalTables: CANONICAL_J5_TABLES,
    requiredConstraints: REQUIRED_J5_CONSTRAINTS,
    requiredUniqueIndexes: REQUIRED_J5_UNIQUE_INDEXES,
    requiredTriggers: REQUIRED_J5_TRIGGERS,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = runCxaJ5SchemaReadiness();
    if (summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
