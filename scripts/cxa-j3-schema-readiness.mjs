import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const composeArguments = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];

/** ตารางทั้งหมดที่ J3 เพิ่มเข้ามา ทั้งฝั่ง Customer 360 และฝั่ง Journey */
export const CANONICAL_J3_TABLES = [
  'c360_segment_definitions',
  'c360_segment_definition_heads',
  'c360_fact_snapshots',
  'c360_segment_evaluations',
  'c360_segment_membership_heads',
  'c360_segment_membership_changes',
  'c360_segment_membership_outbox',
  'c360_segment_evidence',
  'c360_evidence_access_audit',
  'c360_membership_command_receipts',
  'c360_membership_quarantine',
  'c360_identity_heads',
  'c360_identity_lineage',
  'jr_segment_receipts',
  'jr_segment_heads',
  'jr_segment_enrollment_intents',
  'jr_segment_refilter_cursors',
  'jr_segment_outbox',
  'jr_segment_rollout_state',
  'jr_segment_shadow_mismatches',
];

/**
 * constraint ที่เป็น invariant ของ J3 ไม่ใช่แค่รูปแบบ — ถ้าหายไปแม้แต่ตัวเดียว migration
 * ถือว่าไม่ผ่าน
 *
 * ตรวจถึงระดับนี้เพราะ J2-MG01 เดิมนับแค่ตาราง/RLS/policy ซึ่งผ่านได้แม้ CHECK ที่กัน lease
 * ค้างหรือ head ถอยหลังจะหายไปทั้งชุด — และนั่นคือความผิดพลาดที่จะไม่มีใครเห็นจนกว่าจะมีข้อมูล
 * เสียหายจริงใน production
 */
export const REQUIRED_J3_CONSTRAINTS = [
  'c360_segment_definitions_lifecycle_check',
  'c360_segment_definition_heads_state_check',
  'jr_segment_receipts_revision_check',
  'jr_segment_receipts_supersedes_check',
  'jr_segment_receipts_lease_check',
  'jr_segment_receipts_state_check',
  'jr_segment_receipts_version_check',
  'jr_segment_heads_revision_check',
  'jr_segment_heads_terminal_check',
  'jr_segment_refilter_cursors_revision_check',
  'jr_segment_refilter_cursors_lease_check',
  'jr_segment_refilter_cursors_settled_check',
  'jr_segment_refilter_cursors_version_check',
  'jr_segment_outbox_state_check',
  'jr_enrollments_single_trigger_source_check',
  'jr_segment_rollout_state_stage_check',
  'jr_segment_rollout_state_version_check',
];

/** unique index ที่เป็น identity boundary — สองชั้นของ receipt และ 1:1 ของ enrollment intent */
export const REQUIRED_J3_UNIQUE_INDEXES = [
  'jr_segment_receipts_transport_key',
  'jr_segment_receipts_logical_key',
  'jr_segment_enrollment_intents_key',
  'jr_segment_refilter_cursors_key',
  'jr_segment_outbox_event_key',
  'jr_enrollments_tenant_segment_intent_key',
  'jr_segment_rollout_state_tenant_key',
  'jr_segment_shadow_mismatches_key',
];

/** trigger ที่บังคับ append-only — ของที่แก้ย้อนหลังได้ก็ไม่ใช่หลักฐาน */
export const REQUIRED_J3_TRIGGERS = [
  'c360_membership_change_immutable',
  'c360_identity_lineage_immutable',
  'c360_membership_outbox_guard',
  'jr_segment_enrollment_intents_immutable',
  'jr_segment_rollout_guard',
  'jr_segment_shadow_mismatches_immutable',
];

function sqlArray(values) {
  return `ARRAY[${values.map((value) => `'${value}'`).join(',')}]`;
}

const tableArray = sqlArray(CANONICAL_J3_TABLES);
const evidenceQuery = `
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
        AND tablename = ANY(${tableArray}))
    || '|' ||
    (SELECT count(*) FROM pg_constraint
      WHERE contype = 'c' AND conname = ANY(${sqlArray(REQUIRED_J3_CONSTRAINTS)}))
    || '|' ||
    (SELECT count(*) FROM pg_indexes
      WHERE schemaname = 'public' AND indexname = ANY(${sqlArray(REQUIRED_J3_UNIQUE_INDEXES)}))
    || '|' ||
    (SELECT count(*) FROM pg_trigger
      WHERE NOT tgisinternal AND tgname = ANY(${sqlArray(REQUIRED_J3_TRIGGERS)}))
    || '|' ||
    (SELECT count(*) FROM pg_constraint AS fk
      JOIN pg_class AS child ON child.oid = fk.conrelid
      WHERE fk.contype = 'f'
        AND child.relname = ANY(${tableArray})
        AND array_length(fk.conkey, 1) > 1);
`
  .replace(/\s+/g, ' ')
  .trim();

export function parseJ3SchemaEvidence(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)\|(\d+)$/);
  if (!match) {
    throw new TypeError('schema evidence ต้องมีเจ็ดตัวเลขคั่นด้วย |');
  }
  const [, tables, rlsEnabled, tenantPolicies, checks, uniqueIndexes, triggers, compositeKeys] =
    match.map(Number);
  const expectedTables = CANONICAL_J3_TABLES.length;
  return {
    tables,
    rlsEnabled,
    tenantPolicies,
    checks,
    uniqueIndexes,
    triggers,
    compositeKeys,
    status:
      tables === expectedTables &&
      rlsEnabled === expectedTables &&
      tenantPolicies === expectedTables &&
      checks === REQUIRED_J3_CONSTRAINTS.length &&
      uniqueIndexes === REQUIRED_J3_UNIQUE_INDEXES.length &&
      triggers === REQUIRED_J3_TRIGGERS.length &&
      // composite FK คือสิ่งที่กัน cross-tenant binding — ต้องมีอย่างน้อยหนึ่งตัวต่อ J3 table
      // ที่อ้าง contact/receipt; ไม่ fix ตัวเลขไว้เพราะ schema ยังโตได้
      compositeKeys > 0
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

function databaseCommand(databaseName, ...arguments_) {
  return execute('docker', [
    ...composeArguments,
    'exec',
    '-T',
    'postgres',
    ...arguments_,
    '-U',
    'dcontact',
    databaseName,
  ]);
}

function inspectDatabase(databaseName) {
  return parseJ3SchemaEvidence(databaseCommand(databaseName, 'psql', '-tAc', evidenceQuery));
}

/**
 * J3-MG01: migration ครอบคลุม J3 ทั้งบน database ที่ upgrade มาและบน fresh migrate
 *
 * ต้องตรวจทั้งสองทางเพราะ migration ที่เขียนมือ (repo นี้ไม่ใช้ prisma migrate diff — diff
 * ดริฟต์ทั้ง schema) อาจผ่านบน DB ที่มีของเดิมอยู่แล้วแต่พังบน DB เปล่า หรือกลับกัน
 */
export function runCxaJ3SchemaReadiness() {
  const existingDatabase = process.env.CXA_ACCEPTANCE_DATABASE_NAME ?? 'dcontact';
  if (!/^[a-zA-Z0-9_]+$/.test(existingDatabase)) {
    throw new TypeError('CXA_ACCEPTANCE_DATABASE_NAME มีชื่อฐานข้อมูลไม่ถูกต้อง');
  }
  const freshDatabase = `dcontact_cxa_j3_verify_${randomBytes(6).toString('hex')}`;

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
    workflow: 'cx-automation-j3-schema',
    status: existing.status === 'PASS' && fresh?.status === 'PASS' ? 'PASS' : 'FAIL',
    existing,
    fresh,
    canonicalTables: CANONICAL_J3_TABLES,
    requiredConstraints: REQUIRED_J3_CONSTRAINTS,
    requiredUniqueIndexes: REQUIRED_J3_UNIQUE_INDEXES,
    requiredTriggers: REQUIRED_J3_TRIGGERS,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = runCxaJ3SchemaReadiness();
    if (summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
