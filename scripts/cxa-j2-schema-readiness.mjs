import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const composeArguments = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];

/** ตารางใหม่ที่ J2 เพิ่มเข้ามา (ไม่รวม jr_journey_definitions ที่ C1.4 สร้างไว้ก่อนแล้ว) */
export const CANONICAL_J2_TABLES = [
  'jr_outcome_receipts',
  'jr_outcome_heads',
  'jr_owner_actions',
  'jr_owner_command_outbox',
  'jr_owner_result_inbox',
  'jr_recovery_audit',
  'cs_case_type_policies',
  'cs_routing_policies',
  'cs_cases',
  'cs_case_links',
  'cs_case_activities',
  'cs_command_inbox',
  'ob_campaigns',
  'ob_campaign_admission_policies',
  'ob_campaign_targets',
  'ob_dialer_command_inbox',
  'ob_callbacks',
];

const tableArray = `ARRAY[${CANONICAL_J2_TABLES.map((table) => `'${table}'`).join(',')}]`;
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
        AND tablename = ANY(${tableArray}));
`
  .replace(/\s+/g, ' ')
  .trim();

export function parseJ2SchemaEvidence(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\|(\d+)\|(\d+)$/);
  if (!match) throw new TypeError('schema evidence ต้องมีจำนวน table|RLS|policy');
  const [, tables, rlsEnabled, tenantPolicies] = match.map(Number);
  const expected = CANONICAL_J2_TABLES.length;
  return {
    tables,
    rlsEnabled,
    tenantPolicies,
    status:
      tables === expected && rlsEnabled === expected && tenantPolicies === expected
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
  return parseJ2SchemaEvidence(databaseCommand(databaseName, 'psql', '-tAc', evidenceQuery));
}

/** J2-MG01: migration ครอบคลุมตาราง J2 ใหม่ทั้งหมดทั้งบน DB ที่มีอยู่และ fresh migrate */
export function runCxaJ2SchemaReadiness() {
  const existingDatabase = process.env.CXA_ACCEPTANCE_DATABASE_NAME ?? 'dcontact';
  if (!/^[a-zA-Z0-9_]+$/.test(existingDatabase)) {
    throw new TypeError('CXA_ACCEPTANCE_DATABASE_NAME มีชื่อฐานข้อมูลไม่ถูกต้อง');
  }
  const freshDatabase = `dcontact_cxa_j2_verify_${randomBytes(6).toString('hex')}`;

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
    workflow: 'cx-automation-j2-schema',
    status: existing.status === 'PASS' && fresh?.status === 'PASS' ? 'PASS' : 'FAIL',
    existing,
    fresh,
    canonicalTables: CANONICAL_J2_TABLES,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = runCxaJ2SchemaReadiness();
    if (summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
