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
];

test('A1.1 evidence ครบผ่าน; ขาดชิ้นใดหรือมีสิทธิ์เกินไม่ผ่าน', () => {
  assert.equal(parseA1SchemaEvidence(complete.join('|')).status, 'PASS');
  for (let index = 0; index < complete.length; index += 1) {
    const broken = [...complete];
    broken[index] = index === 5 || index === 6 ? 1 : broken[index] === 0 ? 1 : broken[index] - 1;
    assert.equal(parseA1SchemaEvidence(broken.join('|')).status, 'FAIL', `index ${index}`);
  }
  assert.throws(() => parseA1SchemaEvidence('1|2'));
});

test('A1.1 ทุกชื่อใน registry มีอยู่จริงใน migration', () => {
  for (const table of CANONICAL_A1_TABLES)
    assert.match(migration, new RegExp(`CREATE TABLE "${table}"`));
  for (const name of [
    ...REQUIRED_A1_CONSTRAINTS,
    ...REQUIRED_A1_UNIQUE_INDEXES,
    ...REQUIRED_A1_TRIGGERS,
  ]) {
    assert.ok(migration.includes(`"${name}"`), name);
  }
});

test('A1 migration ทุกไฟล์เป็น expand-only และ tenants ได้แค่คอลัมน์ใหม่ที่มี default/nullable', () => {
  assert.deepEqual(findDestructiveStatements(migration), []);
  // enum value ใหม่ต้องแทรกตามลำดับ contract และอยู่คนละไฟล์กับ migration ที่ใช้มัน
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

test('A1.1 rls.sql ถอน pf_* จาก dcontact_app หลัง blanket GRANT และไม่ให้ platform ลบ/แก้หลักฐาน', () => {
  const blanket = rls.indexOf(
    'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dcontact_app',
  );
  const revoke = rls.indexOf('pf_action_history FROM dcontact_app');
  assert.ok(blanket >= 0 && revoke > blanket);
  for (const table of CANONICAL_A1_TABLES) assert.ok(rls.includes(table), table);
  assert.doesNotMatch(rls, /GRANT[^;]*DELETE[^;]*TO dcontact_platform/);
  for (const table of APPEND_ONLY_A1_TABLES) {
    assert.doesNotMatch(rls, new RegExp(`GRANT[^;]*UPDATE[^;]*${table}[^;]*TO dcontact_platform`));
  }
});
