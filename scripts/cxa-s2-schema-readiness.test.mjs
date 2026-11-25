import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  APPEND_ONLY_S2_TABLES,
  CANONICAL_S2_TABLES,
  MINIMUM_S2_COMPOSITE_FOREIGN_KEYS,
  REQUIRED_S2_CONSTRAINTS,
  REQUIRED_S2_ENUM_VALUES,
  REQUIRED_S2_TRIGGERS,
  REQUIRED_S2_UNIQUE_INDEXES,
  S2_MIGRATIONS,
  findDestructiveStatements,
  parseS2SchemaEvidence,
} from './cxa-s2-schema-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migrationSql = (name) =>
  readFileSync(
    resolve(repositoryRoot, 'packages/db/prisma/migrations', name, 'migration.sql'),
    'utf8',
  );
const [enumMigration, persistenceMigration] = S2_MIGRATIONS.map(migrationSql);
// the registry covers every file of the phase, not only the persistence files of S2.1
const allMigrationSql = S2_MIGRATIONS.map(migrationSql).join('\n');
const rlsBootstrap = readFileSync(resolve(repositoryRoot, 'packages/db/prisma/rls.sql'), 'utf8');

const passing = [
  CANONICAL_S2_TABLES.length,
  CANONICAL_S2_TABLES.length,
  CANONICAL_S2_TABLES.length,
  REQUIRED_S2_CONSTRAINTS.length,
  REQUIRED_S2_UNIQUE_INDEXES.length,
  REQUIRED_S2_TRIGGERS.length,
  MINIMUM_S2_COMPOSITE_FOREIGN_KEYS,
  REQUIRED_S2_ENUM_VALUES.length,
  0,
];

test('complete evidence passes, and missing any one piece fails', () => {
  assert.equal(parseS2SchemaEvidence(passing.join('|')).status, 'PASS');
  for (let index = 0; index < passing.length; index += 1) {
    const broken = [...passing];
    // the last one is the app forbidden privilege - even a single one must fail
    broken[index] = index === passing.length - 1 ? 1 : broken[index] - 1;
    assert.equal(parseS2SchemaEvidence(broken.join('|')).status, 'FAIL', `field ${index}`);
  }
  assert.throws(() => parseS2SchemaEvidence('1|2|3'), /nine numbers/);
});

test('every name in the registry really exists in a migration - prevents the registry and the SQL from drifting apart', () => {
  for (const table of CANONICAL_S2_TABLES) {
    assert.match(persistenceMigration, new RegExp(`CREATE TABLE "${table}"`), table);
  }
  for (const name of [
    ...REQUIRED_S2_CONSTRAINTS,
    ...REQUIRED_S2_UNIQUE_INDEXES,
    ...REQUIRED_S2_TRIGGERS,
  ]) {
    assert.ok(allMigrationSql.includes(`"${name}"`), name);
  }
  for (const [type, value] of REQUIRED_S2_ENUM_VALUES) {
    assert.ok(enumMigration.includes(`"${type}" ADD VALUE IF NOT EXISTS '${value}'`), type);
  }
  const compositeForeignKeys = persistenceMigration.match(
    /FOREIGN KEY \("tenant_id", "[a-z_]+"[^)]*\)/g,
  );
  assert.ok((compositeForeignKeys?.length ?? 0) >= MINIMUM_S2_COMPOSITE_FOREIGN_KEYS);
});

test('every S2 migration file is expand-only and enum values are in a separate transaction', () => {
  for (const name of S2_MIGRATIONS) {
    assert.deepEqual(findDestructiveStatements(migrationSql(name)), [], name);
  }
  // a new enum value must not be used in the same migration that adds it
  assert.doesNotMatch(enumMigration, /CREATE TABLE|CHECK \(/);
  // every new table has tenant_id NOT NULL
  for (const table of CANONICAL_S2_TABLES) {
    const body = persistenceMigration.split(`CREATE TABLE "${table}" (`)[1]?.split(');')[0] ?? '';
    assert.match(body, /"tenant_id" UUID NOT NULL/, table);
  }
});

test('the destructive scanner catches destructive statements and does not count comments', () => {
  assert.deepEqual(findDestructiveStatements('-- DROP TABLE x;\nCREATE TABLE "y" ();'), []);
  for (const sql of [
    'DROP TABLE "dl_outbox_entries";',
    'ALTER TABLE "a" DROP COLUMN "b";',
    'ALTER TABLE "a" RENAME COLUMN "b" TO "c";',
    'TRUNCATE "a";',
    'DELETE FROM "a";',
    'UPDATE "dl_outbox_entries" SET adapter = \'LINE_MESSAGING_API\';',
    'ALTER TABLE "a" ALTER COLUMN "b" SET NOT NULL;',
    'ALTER TABLE "a" ALTER COLUMN "b" TYPE TEXT;',
  ]) {
    assert.ok(findDestructiveStatements(sql).length > 0, sql);
  }
});

test('rls.sql bootstrap covers every S2.1 table and re-revokes after the blanket GRANT', () => {
  for (const table of CANONICAL_S2_TABLES) {
    assert.ok(rlsBootstrap.includes(`'${table}'`), `${table} must be in the RLS array`);
    const privileges = APPEND_ONLY_S2_TABLES.includes(table) ? 'UPDATE, DELETE' : 'DELETE';
    assert.ok(
      rlsBootstrap.includes(`REVOKE ${privileges} ON ${table} FROM dcontact_app;`),
      `${table} must REVOKE ${privileges}`,
    );
  }
});
