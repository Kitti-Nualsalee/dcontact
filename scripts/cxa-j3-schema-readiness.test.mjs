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

test('a schema complete in every respect passes', () => {
  const parsed = parseJ3SchemaEvidence(evidence());
  assert.equal(parsed.status, 'PASS');
  assert.equal(parsed.tables, tables);
});

test('even one missing table counts as failing', () => {
  assert.equal(parseJ3SchemaEvidence(evidence({ tables: tables - 1 })).status, 'FAIL');
});

test('incomplete RLS or tenant policy counts as failing', () => {
  assert.equal(parseJ3SchemaEvidence(evidence({ rlsEnabled: tables - 1 })).status, 'FAIL');
  assert.equal(parseJ3SchemaEvidence(evidence({ tenantPolicies: 0 })).status, 'FAIL');
});

test('a missing CHECK must make it fail even when tables and RLS are complete', () => {
  /**
   * This is the main reason this level of checking was added: the earlier J2-MG01 counted only tables/RLS/policies, which can pass
   * even when the CHECKs that guard against a stuck lease or a regressing head are missing entirely
   */
  const parsed = parseJ3SchemaEvidence(evidence({ checks: checks - 1 }));
  assert.equal(parsed.status, 'FAIL');
  assert.equal(parsed.tables, tables, 'tables are still complete, but the total must fail');
});

test('a missing unique index or trigger makes it fail', () => {
  assert.equal(parseJ3SchemaEvidence(evidence({ uniqueIndexes: indexes - 1 })).status, 'FAIL');
  assert.equal(parseJ3SchemaEvidence(evidence({ triggers: 0 })).status, 'FAIL');
});

test('no composite foreign key at all counts as failing', () => {
  // composite FKs are what guard against cross-tenant binding - having none means the tenant boundary is gone
  assert.equal(parseJ3SchemaEvidence(evidence({ compositeKeys: 0 })).status, 'FAIL');
});

test('evidence in the wrong format is rejected, not interpreted as zero', () => {
  for (const malformed of ['', '1|2|3', 'a|b|c|d|e|f|g', `${tables}|${tables}`]) {
    assert.throws(() => parseJ3SchemaEvidence(malformed), TypeError);
  }
});

test('the required lists do not duplicate themselves', () => {
  for (const [label, list] of [
    ['tables', CANONICAL_J3_TABLES],
    ['constraints', REQUIRED_J3_CONSTRAINTS],
    ['indexes', REQUIRED_J3_UNIQUE_INDEXES],
    ['triggers', REQUIRED_J3_TRIGGERS],
  ]) {
    assert.equal(new Set(list).size, list.length, `${label} has duplicate entries`);
  }
});

test('schema registry uses a unique cursor key per owner team after IAM scope invalidation', () => {
  assert.ok(REQUIRED_J3_UNIQUE_INDEXES.includes('jr_segment_refilter_cursors_team_scope_key'));
  assert.ok(!REQUIRED_J3_UNIQUE_INDEXES.includes('jr_segment_refilter_cursors_key'));
});
