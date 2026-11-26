import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sha256 } from './cxa-c1-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationsRoot = resolve(repositoryRoot, 'packages/db/prisma/migrations');

/**
 * CG5-MG01 (#273, Phase Contract §2/§8): the CG5 migration must be purely additive
 *
 * - may create/alter only CG5 objects (`cg5_*`, type `Cg5*`) and add existing enum values with `ADD VALUE`
 * - no DROP/RENAME/TRUNCATE and no data writes (INSERT/UPDATE/DELETE) in any case
 * - an index on a canonical table must be a non-unique `CREATE INDEX CONCURRENTLY` alone in its own file
 *   (Postgres cannot create a concurrent index in a transaction together with other statements)
 *
 * Checked statically from the committed SQL files, not depending on a database, so it cannot pass because of the environment
 */

const isCg5Name = (name) => /^"?(cg5_|Cg5)/.test(name);

export function cg5MigrationStatements(sql) {
  return sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n')
    .split(';')
    .map((statement) => statement.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function tablesAfterOn(statement) {
  const match = statement.match(/\bON\s+(.+?)\s+(?:TO|FROM)\b/i);
  return match ? match[1].split(',').map((name) => name.trim()) : [];
}

/** Return null when the statement is additive, otherwise the violated reason */
export function cg5StatementViolation(statement, statementsInFile) {
  if (/\b(DROP|RENAME|TRUNCATE)\b/i.test(statement)) return 'DESTRUCTIVE_DDL';
  if (/^(INSERT|UPDATE|DELETE|COPY)\b/i.test(statement)) return 'DATA_WRITE';

  if (/^CREATE TYPE\s+("?\w+"?)/i.test(statement)) {
    return isCg5Name(statement.match(/^CREATE TYPE\s+("?\w+"?)/i)[1]) ? null : 'NON_CG5_TYPE';
  }
  if (/^ALTER TYPE\s+"?\w+"?\s+ADD VALUE\b/i.test(statement)) return null;
  if (/^CREATE TABLE\s+("?\w+"?)/i.test(statement)) {
    return isCg5Name(statement.match(/^CREATE TABLE\s+("?\w+"?)/i)[1]) ? null : 'NON_CG5_TABLE';
  }
  const index = statement.match(
    /^CREATE (UNIQUE )?INDEX (CONCURRENTLY )?(?:IF NOT EXISTS )?"?\w+"? ON ("?\w+"?)/i,
  );
  if (index) {
    const [, unique, concurrently, table] = index;
    if (isCg5Name(table)) return null;
    if (!concurrently) return 'CANONICAL_INDEX_NOT_CONCURRENT';
    if (unique) return 'CANONICAL_UNIQUE_INDEX';
    return statementsInFile === 1 ? null : 'CONCURRENT_INDEX_NOT_ISOLATED';
  }
  if (/^ALTER TABLE\s+("?\w+"?)/i.test(statement)) {
    return isCg5Name(statement.match(/^ALTER TABLE\s+("?\w+"?)/i)[1])
      ? null
      : 'CANONICAL_TABLE_ALTERED';
  }
  if (/^CREATE POLICY\s+\w+\s+ON\s+("?\w+"?)/i.test(statement)) {
    return isCg5Name(statement.match(/^CREATE POLICY\s+\w+\s+ON\s+("?\w+"?)/i)[1])
      ? null
      : 'CANONICAL_POLICY_CHANGED';
  }
  if (/^(GRANT|REVOKE)\b/i.test(statement)) {
    const tables = tablesAfterOn(statement);
    return tables.length > 0 && tables.every(isCg5Name) ? null : 'CANONICAL_GRANT_CHANGED';
  }
  return 'UNRECOGNIZED_STATEMENT';
}

export function cg5MigrationReport(migrations) {
  const violations = [];
  let canonicalIndexes = 0;
  for (const { name, sql } of migrations) {
    const statements = cg5MigrationStatements(sql);
    for (const statement of statements) {
      const reason = cg5StatementViolation(statement, statements.length);
      if (reason) violations.push({ migration: name, reason, statement: statement.slice(0, 160) });
      else if (/^CREATE INDEX CONCURRENTLY/i.test(statement)) canonicalIndexes += 1;
    }
  }
  return { violations, canonicalIndexes };
}

export function readCg5Migrations(root = migrationsRoot) {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /_cg5_/.test(entry.name))
    .map((entry) => entry.name)
    .sort()
    .map((name) => ({ name, sql: readFileSync(resolve(root, name, 'migration.sql'), 'utf8') }));
}

export function cxaCg5MigrationSummary(migrations = readCg5Migrations()) {
  if (migrations.length === 0) throw new Error('CG5-MG01 found no CG5 migration');
  const { violations, canonicalIndexes } = cg5MigrationReport(migrations);
  if (violations.length > 0) {
    throw new Error(
      `CG5-MG01 migration is not additive: ${violations
        .map(({ migration, reason }) => `${migration}=${reason}`)
        .join(', ')}`,
    );
  }
  return {
    type: 'migration.readiness',
    workflow: 'cxa-cg5-migration',
    status: 'PASS',
    migrations: migrations.map(({ name, sql }) => ({ name, sha256: sha256(sql) })),
    canonicalConcurrentIndexes: canonicalIndexes,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    process.stdout.write(
      `CXA_CG5_MIGRATION_EVIDENCE:${JSON.stringify(cxaCg5MigrationSummary())}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
