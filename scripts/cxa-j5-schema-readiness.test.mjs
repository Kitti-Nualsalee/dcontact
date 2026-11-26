import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import {
  CANONICAL_J5_TABLES,
  MINIMUM_J5_COMPOSITE_FOREIGN_KEYS,
  REQUIRED_J5_CONSTRAINTS,
  REQUIRED_J5_TRIGGERS,
  REQUIRED_J5_UNIQUE_INDEXES,
  parseJ5SchemaEvidence,
} from './cxa-j5-schema-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migration = readFileSync(
  resolve(
    repositoryRoot,
    'packages/db/prisma/migrations/20260922090000_add_j5_authoring_schema/migration.sql',
  ),
  'utf8',
);
const rlsBootstrap = readFileSync(resolve(repositoryRoot, 'packages/db/prisma/rls.sql'), 'utf8');

const passing = [
  CANONICAL_J5_TABLES.length,
  CANONICAL_J5_TABLES.length,
  CANONICAL_J5_TABLES.length,
  REQUIRED_J5_CONSTRAINTS.length,
  REQUIRED_J5_UNIQUE_INDEXES.length,
  REQUIRED_J5_TRIGGERS.length,
  MINIMUM_J5_COMPOSITE_FOREIGN_KEYS,
  0,
];

test('complete evidence passes, and missing any one piece fails', () => {
  assert.equal(parseJ5SchemaEvidence(passing.join('|')).status, 'PASS');
  for (let index = 0; index < passing.length; index += 1) {
    const broken = [...passing];
    // the last one is the app DELETE privilege - even a single one must fail
    broken[index] = index === passing.length - 1 ? 1 : broken[index] - 1;
    assert.equal(parseJ5SchemaEvidence(broken.join('|')).status, 'FAIL', `field ${index}`);
  }
  assert.throws(() => parseJ5SchemaEvidence('1|2|3'), /eight numbers/);
});

test('every name in the registry really exists in a migration - prevents the registry and the SQL from drifting apart', () => {
  for (const table of CANONICAL_J5_TABLES) {
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`), table);
  }
  for (const name of [
    ...REQUIRED_J5_CONSTRAINTS,
    ...REQUIRED_J5_UNIQUE_INDEXES,
    ...REQUIRED_J5_TRIGGERS,
  ]) {
    assert.ok(migration.includes(`"${name}"`), name);
  }
});

test('the migration is purely expand: it does not alter or overwrite jr_journey_definitions and has no destructive statement', () => {
  assert.doesNotMatch(migration, /ALTER TABLE "jr_journey_definitions"/);
  assert.doesNotMatch(migration, /\b(UPDATE|DELETE FROM|INSERT INTO)\s+"?jr_journey_definitions/i);
  assert.doesNotMatch(migration, /\bDROP\s+(TABLE|COLUMN|TYPE|INDEX)\b/i);
  // a built-in must not have a nullable tenant: every table has tenant_id NOT NULL
  for (const table of CANONICAL_J5_TABLES) {
    const body = migration.split(`CREATE TABLE "${table}" (`)[1]?.split(');')[0] ?? '';
    assert.match(body, /"tenant_id" UUID NOT NULL/, table);
  }
});

test('rls.sql bootstrap covers every J5.1 table', () => {
  for (const table of CANONICAL_J5_TABLES) {
    assert.ok(rlsBootstrap.includes(`'${table}'`), `${table} must be in the RLS array`);
    assert.match(
      rlsBootstrap,
      new RegExp(`REVOKE [A-Z, ]*DELETE ON ${table} FROM dcontact_app`),
      table,
    );
  }
});
