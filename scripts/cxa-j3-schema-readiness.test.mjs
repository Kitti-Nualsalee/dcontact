import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CANONICAL_J3_TABLES,
  REQUIRED_J3_CONSTRAINTS,
  REQUIRED_J3_TRIGGERS,
  REQUIRED_J3_UNIQUE_INDEXES,
  parseJ3SchemaEvidence,
} from './cxa-j3-schema-readiness.mjs';

const tables = CANONICAL_J3_TABLES.length;
const checks = REQUIRED_J3_CONSTRAINTS.length;
const indexes = REQUIRED_J3_UNIQUE_INDEXES.length;
const triggers = REQUIRED_J3_TRIGGERS.length;

function evidence(overrides = {}) {
  const values = {
    tables,
    rlsEnabled: tables,
    tenantPolicies: tables,
    checks,
    uniqueIndexes: indexes,
    triggers,
    compositeKeys: 9,
    ...overrides,
  };
  return [
    values.tables,
    values.rlsEnabled,
    values.tenantPolicies,
    values.checks,
    values.uniqueIndexes,
    values.triggers,
    values.compositeKeys,
  ].join('|');
}

test('schema ที่ครบทุกด้านผ่าน', () => {
  const parsed = parseJ3SchemaEvidence(evidence());
  assert.equal(parsed.status, 'PASS');
  assert.equal(parsed.tables, tables);
});

test('ตารางขาดแม้แต่ตัวเดียวถือว่าไม่ผ่าน', () => {
  assert.equal(parseJ3SchemaEvidence(evidence({ tables: tables - 1 })).status, 'FAIL');
});

test('RLS หรือ tenant policy ไม่ครบถือว่าไม่ผ่าน', () => {
  assert.equal(parseJ3SchemaEvidence(evidence({ rlsEnabled: tables - 1 })).status, 'FAIL');
  assert.equal(parseJ3SchemaEvidence(evidence({ tenantPolicies: 0 })).status, 'FAIL');
});

test('CHECK ที่หายไปต้องทำให้ไม่ผ่าน แม้ตารางกับ RLS จะครบ', () => {
  /**
   * นี่คือเหตุผลหลักที่เพิ่มการตรวจระดับนี้: J2-MG01 เดิมนับแค่ตาราง/RLS/policy ซึ่งผ่านได้
   * แม้ CHECK ที่กัน lease ค้างหรือ head ถอยหลังจะหายไปทั้งชุด
   */
  const parsed = parseJ3SchemaEvidence(evidence({ checks: checks - 1 }));
  assert.equal(parsed.status, 'FAIL');
  assert.equal(parsed.tables, tables, 'ตารางยังครบ แต่ผลรวมต้องไม่ผ่าน');
});

test('unique index หรือ trigger ที่หายไปทำให้ไม่ผ่าน', () => {
  assert.equal(parseJ3SchemaEvidence(evidence({ uniqueIndexes: indexes - 1 })).status, 'FAIL');
  assert.equal(parseJ3SchemaEvidence(evidence({ triggers: 0 })).status, 'FAIL');
});

test('ไม่มี composite foreign key เลยถือว่าไม่ผ่าน', () => {
  // composite FK คือสิ่งที่กัน cross-tenant binding — ไม่มีเลยแปลว่าขอบเขต tenant หายไป
  assert.equal(parseJ3SchemaEvidence(evidence({ compositeKeys: 0 })).status, 'FAIL');
});

test('evidence ที่รูปแบบผิดถูกปฏิเสธ ไม่ใช่ตีความเป็นศูนย์', () => {
  for (const malformed of ['', '1|2|3', 'a|b|c|d|e|f|g', `${tables}|${tables}`]) {
    assert.throws(() => parseJ3SchemaEvidence(malformed), TypeError);
  }
});

test('รายการที่ต้องมีไม่ซ้ำกันเอง', () => {
  for (const [label, list] of [
    ['tables', CANONICAL_J3_TABLES],
    ['constraints', REQUIRED_J3_CONSTRAINTS],
    ['indexes', REQUIRED_J3_UNIQUE_INDEXES],
    ['triggers', REQUIRED_J3_TRIGGERS],
  ]) {
    assert.equal(new Set(list).size, list.length, `${label} มีรายการซ้ำ`);
  }
});

test('schema registry ใช้ unique cursor key ต่อ owner team หลัง IAM scope invalidation', () => {
  assert.ok(REQUIRED_J3_UNIQUE_INDEXES.includes('jr_segment_refilter_cursors_team_scope_key'));
  assert.ok(!REQUIRED_J3_UNIQUE_INDEXES.includes('jr_segment_refilter_cursors_key'));
});
