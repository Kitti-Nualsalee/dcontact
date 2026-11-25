import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { findDestructiveStatements } from './cxa-s2-schema-readiness.mjs';
import {
  A1_MIGRATIONS,
  APPEND_ONLY_A1_TABLES,
  CANONICAL_A1_TABLES,
  MINIMUM_A1_COMPOSITE_FOREIGN_KEYS,
  REQUIRED_A1_CONSTRAINTS,
  REQUIRED_A1_TRIGGERS,
  REQUIRED_A1_UNIQUE_INDEXES,
  PROVISIONER_TABLES,
  parseA1SchemaEvidence,
} from './a1-schema-readiness.mjs';

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const migration = A1_MIGRATIONS.map((name) =>
  readFileSync(
    resolve(repositoryRoot, 'packages/db/prisma/migrations', name, 'migration.sql'),
    'utf8',
  ),
).join('\n');
const rls = readFileSync(resolve(repositoryRoot, 'packages/db/prisma/rls.sql'), 'utf8');

const complete = [
  CANONICAL_A1_TABLES.length,
  REQUIRED_A1_CONSTRAINTS.length,
  REQUIRED_A1_UNIQUE_INDEXES.length,
  REQUIRED_A1_TRIGGERS.length,
  MINIMUM_A1_COMPOSITE_FOREIGN_KEYS,
  0,
  0,
  1,
  0,
  1,
  PROVISIONER_TABLES.length,
];

test('A1.1 complete evidence passes; any missing piece or excess privilege fails', () => {
  assert.equal(parseA1SchemaEvidence(complete.join('|')).status, 'PASS');
  for (let index = 0; index < complete.length; index += 1) {
    const broken = [...complete];
    // indexes 5/6/8 count excess privileges (must be zero); the others are missing one piece
    broken[index] = [5, 6, 8].includes(index) ? 1 : broken[index] - 1;
    assert.equal(parseA1SchemaEvidence(broken.join('|')).status, 'FAIL', `index ${index}`);
  }
  assert.throws(() => parseA1SchemaEvidence('1|2'));
});

test('A1.1 every name in the registry exists in a migration', () => {
  for (const table of CANONICAL_A1_TABLES)
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  // A1.5: the plan pin is added as NOT VALID (old rows are not re-checked) - still expand-only
  assert.match(migration, /"pf_provisioning_requests_plan_pin_fkey"[^;]*NOT VALID;/);
  for (const name of [
    ...REQUIRED_A1_CONSTRAINTS,
    ...REQUIRED_A1_UNIQUE_INDEXES,
    ...REQUIRED_A1_TRIGGERS,
  ]) {
    assert.ok(migration.includes(`"${name}"`), name);
  }
});

test('A1 every migration file is expand-only and tenants gets only new columns with a default/nullable', () => {
  assert.deepEqual(findDestructiveStatements(migration), []);
  // a new enum value must be inserted in contract order and live in a different file from the migration that uses it
  assert.match(
    migration,
    /ADD VALUE IF NOT EXISTS 'STEP_RETRY_SCHEDULED' AFTER 'STEP_ACTION_REQUIRED'/,
  );
  assert.match(migration, /ADD COLUMN "attempt_floor" INTEGER NOT NULL DEFAULT 0/);
  assert.match(
    migration,
    /ADD COLUMN\s+"lifecycle_status" "TenantLifecycleStatus" NOT NULL DEFAULT 'ACTIVE'/,
  );
  assert.match(migration, /ADD COLUMN\s+"primary_domain" TEXT(?! NOT NULL)/);
});

test('A1.1 rls.sql revokes pf_* from dcontact_app after the blanket GRANT and does not let platform delete/edit evidence', () => {
  const blanket = rls.indexOf(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dcontact_app',
  );
  const revoke = rls.indexOf('pf_action_history FROM dcontact_app');
  assert.ok(blanket >= 0 && revoke > blanket);
  for (const table of CANONICAL_A1_TABLES) assert.ok(rls.includes(table), table);
  assert.doesNotMatch(rls, /GRANT[^;]*DELETE[^;]*TO dcontact_platform/);
  // A1.4: the invitation outbox is revoked from the tenant app and the provisioner has no DELETE or privilege outside users/tenants
  assert.ok(rls.indexOf('REVOKE ALL ON pf_invitations FROM dcontact_app') > blanket);
  assert.doesNotMatch(rls, /GRANT[^;]*DELETE[^;]*TO dcontact_provisioner/);
  for (const statement of rls.match(/GRANT [^;]*TO dcontact_provisioner/g) ?? []) {
    assert.match(
      statement,
      /ON (SCHEMA public|tenants|users|"?teams"?, "?queues"?, "?tenant_settings"?, "?tenant_plan_bindings"?, "?business_hours"?)\s+TO/,
      statement,
    );
  }
  for (const table of APPEND_ONLY_A1_TABLES) {
    assert.doesNotMatch(rls, new RegExp(`GRANT[^;]*UPDATE[^;]*${table}[^;]*TO dcontact_platform`));
  }
});
