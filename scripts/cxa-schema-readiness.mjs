import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
const composeArguments = ['compose', '-f', 'infra/docker/docker-compose.dev.yml'];

export const CANONICAL_CXA_TABLES = [
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
  'jr_schedule_occurrences',
  'jr_step_runs',
];

const tableArray = `ARRAY[${CANONICAL_CXA_TABLES.map((table) => `'${table}'`).join(',')}]`;
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

export function parseCanonicalSchemaEvidence(value) {
  const match = String(value)
    .trim()
    .match(/^(\d+)\|(\d+)\|(\d+)$/);
  if (!match) throw new TypeError('schema evidence ต้องมีจำนวน table|RLS|policy');
  const [, tables, rlsEnabled, tenantPolicies] = match.map(Number);
  const expected = CANONICAL_CXA_TABLES.length;
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
  return parseCanonicalSchemaEvidence(databaseCommand(databaseName, 'psql', '-tAc', evidenceQuery));
}

export function runCxaSchemaReadiness() {
  const existingDatabase = process.env.CXA_ACCEPTANCE_DATABASE_NAME ?? 'dcontact';
  if (!/^[a-zA-Z0-9_]+$/.test(existingDatabase)) {
    throw new TypeError('CXA_ACCEPTANCE_DATABASE_NAME มีชื่อฐานข้อมูลไม่ถูกต้อง');
  }
  const freshDatabase = `dcontact_cxa_verify_${randomBytes(6).toString('hex')}`;

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
    workflow: 'cx-automation-phase-1-schema',
    status: existing.status === 'PASS' && fresh?.status === 'PASS' ? 'PASS' : 'FAIL',
    existing,
    fresh,
    canonicalTables: CANONICAL_CXA_TABLES,
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
  return summary;
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const summary = runCxaSchemaReadiness();
    if (summary.status === 'FAIL') process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
