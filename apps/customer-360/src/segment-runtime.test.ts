import assert from 'node:assert/strict';
import test from 'node:test';
import { DcExprEvaluator } from '@d-contact/expression';
import { C360SegmentEvaluator } from './segment-evaluator.js';
import { normalizeFactSnapshot, validateSegmentDefinitionContent } from './segment-definition.js';
import {
  C360_SYSTEM_SEGMENTS,
  c360ContactFacts,
  c360SystemEvaluationCommandId,
} from './segment-runtime.js';

const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
const segment = (id: string) => C360_SYSTEM_SEGMENTS.find((item) => item.segmentId === id)!;
const evaluate = (id: string, contact: { vip: boolean; company: string | null }) =>
  evaluator.evaluate({
    tenantId: '00000000-0000-4000-8000-000000000001',
    contactId: '00000000-0000-4000-8000-000000000002',
    segmentId: id,
    segmentDefinitionVersion: 1,
    snapshotVersion: 1,
    definition: segment(id).definition,
    // repository normalize typed facts ก่อนเก็บ/ประเมินเสมอ
    snapshot: normalizeFactSnapshot({
      attributes: c360ContactFacts(contact),
      computed: {},
      sourceCutoffAt: '2026-11-18T00:00:00.000Z',
    }),
  }).outcome;

test('segment ระบบผ่าน contract เดิมและประเมินจาก facts ของ Contact', () => {
  for (const item of C360_SYSTEM_SEGMENTS) validateSegmentDefinitionContent(item.definition);
  assert.deepEqual(
    C360_SYSTEM_SEGMENTS.map((item) => item.segmentId),
    ['system:all-customers', 'system:vip'],
  );
  assert.equal(evaluate('system:all-customers', { vip: false, company: null }), 'MATCH');
  assert.equal(evaluate('system:vip', { vip: true, company: 'บริษัท' }), 'MATCH');
  assert.equal(evaluate('system:vip', { vip: false, company: null }), 'NO_MATCH');
});

test('facts มีเฉพาะ vip/company แบบ typed และ commandId คงที่ต่อ input', () => {
  assert.deepEqual(c360ContactFacts({ vip: true, company: null }), {
    vip: { type: 'BOOLEAN', value: true },
    company: { type: 'NULL', value: null },
  });
  const input = {
    contactId: '00000000-0000-4000-8000-000000000002',
    segmentId: 'system:vip',
    segmentDefinitionVersion: 1,
    snapshotVersion: 2,
    expectedMembershipRevision: 0,
  };
  assert.equal(c360SystemEvaluationCommandId(input), c360SystemEvaluationCommandId({ ...input }));
  assert.notEqual(
    c360SystemEvaluationCommandId(input),
    c360SystemEvaluationCommandId({ ...input, expectedMembershipRevision: 1 }),
  );
  // receipt unique ต่อ tenant: contact ต่างกันต้องได้ commandId ต่างกัน
  assert.notEqual(
    c360SystemEvaluationCommandId(input),
    c360SystemEvaluationCommandId({ ...input, contactId: '00000000-0000-4000-8000-000000000003' }),
  );
});
