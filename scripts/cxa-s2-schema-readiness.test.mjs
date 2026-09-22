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

test('evidence ครบทุกตัวผ่าน และขาดตัวใดตัวหนึ่งไม่ผ่าน', () => {
  assert.equal(parseS2SchemaEvidence(passing.join('|')).status, 'PASS');
  for (let index = 0; index < passing.length; index += 1) {
    const broken = [...passing];
    // ตัวสุดท้ายคือสิทธิ์ต้องห้ามของ app — มีแม้แต่ตัวเดียวก็ต้องไม่ผ่าน
    broken[index] = index === passing.length - 1 ? 1 : broken[index] - 1;
    assert.equal(parseS2SchemaEvidence(broken.join('|')).status, 'FAIL', `field ${index}`);
  }
  assert.throws(() => parseS2SchemaEvidence('1|2|3'), /เก้าตัวเลข/);
});

test('ทุกชื่อใน registry มีอยู่จริงใน migration — ป้องกัน registry กับ SQL เดินแยกกัน', () => {
  for (const table of CANONICAL_S2_TABLES) {
    assert.match(persistenceMigration, new RegExp(`CREATE TABLE "${table}"`), table);
  }
  for (const name of [
    ...REQUIRED_S2_CONSTRAINTS,
    ...REQUIRED_S2_UNIQUE_INDEXES,
    ...REQUIRED_S2_TRIGGERS,
  ]) {
    assert.ok(persistenceMigration.includes(`"${name}"`), name);
  }
  for (const [type, value] of REQUIRED_S2_ENUM_VALUES) {
    assert.ok(enumMigration.includes(`"${type}" ADD VALUE IF NOT EXISTS '${value}'`), type);
  }
  const compositeForeignKeys = persistenceMigration.match(
    /FOREIGN KEY \("tenant_id", "[a-z_]+"[^)]*\)/g,
  );
  assert.ok((compositeForeignKeys?.length ?? 0) >= MINIMUM_S2_COMPOSITE_FOREIGN_KEYS);
});

test('migration ของ S2.1 เป็น expand-only และ enum value แยก transaction', () => {
  for (const [name, sql] of [
    [S2_MIGRATIONS[0], enumMigration],
    [S2_MIGRATIONS[1], persistenceMigration],
  ]) {
    assert.deepEqual(findDestructiveStatements(sql), [], name);
  }
  // ค่าใหม่ของ enum ห้ามถูกใช้ใน migration เดียวกับที่เพิ่ม
  assert.doesNotMatch(enumMigration, /CREATE TABLE|CHECK \(/);
  // ทุกตารางใหม่มี tenant_id NOT NULL
  for (const table of CANONICAL_S2_TABLES) {
    const body = persistenceMigration.split(`CREATE TABLE "${table}" (`)[1]?.split(');')[0] ?? '';
    assert.match(body, /"tenant_id" UUID NOT NULL/, table);
  }
});

test('destructive scanner จับคำสั่งทำลายและไม่นับ comment', () => {
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

test('rls.sql bootstrap ครอบทุกตาราง S2.1 และถอนสิทธิ์ซ้ำหลัง blanket GRANT', () => {
  for (const table of CANONICAL_S2_TABLES) {
    assert.ok(rlsBootstrap.includes(`'${table}'`), `${table} ต้องอยู่ใน array ของ RLS`);
    const privileges = APPEND_ONLY_S2_TABLES.includes(table) ? 'UPDATE, DELETE' : 'DELETE';
    assert.ok(
      rlsBootstrap.includes(`REVOKE ${privileges} ON ${table} FROM dcontact_app;`),
      `${table} ต้อง REVOKE ${privileges}`,
    );
  }
});
