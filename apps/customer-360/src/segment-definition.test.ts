import assert from 'node:assert/strict';
import test from 'node:test';
import { DcExprEvaluator } from '@d-contact/expression';
import {
  C360SegmentContractError,
  canonicalJson,
  normalizeFactSnapshot,
  segmentDefinitionContentDigest,
  validateSegmentDefinitionContent,
  type C360SegmentDefinitionContentV1,
} from './segment-definition.js';
import { C360SegmentEvaluator } from './segment-evaluator.js';

const definition: C360SegmentDefinitionContentV1 = {
  contractVersion: 1,
  name: 'ลูกค้า GOLD ที่มียอดค้าง',
  expression: {
    language: 'DC_EXPR',
    version: 1,
    expression: {
      type: 'and',
      operands: [
        {
          type: 'comparison',
          operator: 'eq',
          left: { type: 'ref', path: ['contact', 'tier'] },
          right: { type: 'literal', value: 'GOLD' },
        },
        {
          type: 'comparison',
          operator: 'gt',
          left: { type: 'ref', path: ['vars', 'outstandingBalance'] },
          right: { type: 'literal', value: 1000 },
        },
      ],
    },
  },
};

const typedSnapshot = {
  attributes: {
    tier: { type: 'STRING', value: 'GOLD' },
    crmLabel: { type: 'STRING', value: 'synthetic-customer-label' },
  },
  computed: {
    outstandingBalance: { type: 'NUMBER', value: 2500 },
    lastPurchaseAt: { type: 'TIMESTAMP', value: '2026-09-13T11:00:00+07:00' },
  },
  sourceCutoffAt: '2026-09-13T11:05:00+07:00',
} as const;

test('definition เป็น closed DC_EXPR contract และ content digest ไม่ขึ้นกับ object key order', () => {
  const validated = validateSegmentDefinitionContent(definition);
  assert.equal(validated.expression.language, 'DC_EXPR');
  assert.equal(
    segmentDefinitionContentDigest(definition),
    segmentDefinitionContentDigest({
      expression: definition.expression,
      name: definition.name,
      contractVersion: 1,
    }),
  );
  assert.throws(
    () => validateSegmentDefinitionContent({ ...definition, arbitrary: true }),
    /closed contract/,
  );
  assert.throws(
    () =>
      validateSegmentDefinitionContent({
        ...definition,
        expression: {
          ...definition.expression,
          expression: {
            type: 'comparison',
            operator: 'contains',
            left: { type: 'literal', value: 'a' },
            right: { type: 'literal', value: 'b' },
          },
        },
      }),
    (error: unknown) =>
      error instanceof C360SegmentContractError && error.code === 'INVALID_DEFINITION',
  );
});

test('canonical JSON เรียง key แบบไม่ขึ้นกับ locale ของ runtime', () => {
  assert.equal(canonicalJson({ ä: 1, z: 2 }), '{"z":2,"ä":1}');
});

test('definition ปฏิเสธ unknown version และ reference ที่ไม่ใช่ owner-local fact', () => {
  assert.throws(
    () =>
      validateSegmentDefinitionContent({
        ...definition,
        contractVersion: 2,
      }),
    (error: unknown) =>
      error instanceof C360SegmentContractError && error.code === 'UNSUPPORTED_VERSION',
  );
  assert.throws(
    () =>
      validateSegmentDefinitionContent({
        ...definition,
        expression: {
          language: 'DC_EXPR',
          version: 1,
          expression: { type: 'ref', path: ['interaction', 'channel'] },
        },
      }),
    (error: unknown) =>
      error instanceof C360SegmentContractError && error.code === 'FORBIDDEN_REFERENCE',
  );
});

test('typed fact normalization คง type, normalize timestamp และ fail closed เมื่อเวลา/type คลุมเครือ', () => {
  const normalized = normalizeFactSnapshot(typedSnapshot);
  assert.deepEqual(normalized.attributes, {
    crmLabel: 'synthetic-customer-label',
    tier: 'GOLD',
  });
  assert.deepEqual(normalized.computed, {
    lastPurchaseAt: '2026-09-13T04:00:00.000Z',
    outstandingBalance: 2500,
  });
  assert.equal(normalized.sourceCutoffAt, '2026-09-13T04:05:00.000Z');

  assert.throws(
    () =>
      normalizeFactSnapshot({
        ...typedSnapshot,
        computed: { outstandingBalance: { type: 'NUMBER', value: '2500' } },
      }),
    (error: unknown) => error instanceof C360SegmentContractError && error.code === 'TYPE_MISMATCH',
  );
  assert.throws(
    () =>
      normalizeFactSnapshot({
        ...typedSnapshot,
        computed: { lastPurchaseAt: { type: 'TIMESTAMP', value: '2026-09-13 11:00:00' } },
      }),
    (error: unknown) =>
      error instanceof C360SegmentContractError && error.code === 'TIME_AMBIGUOUS',
  );
});

test('evaluator ให้ result/digest เดิมข้าม retry และไม่คืน raw fact ใน evidence result', () => {
  const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
  const input = {
    tenantId: 'tenant-a',
    contactId: 'contact-a',
    segmentId: 'segment-gold',
    segmentDefinitionVersion: 1,
    snapshotVersion: 1,
    definition,
    snapshot: normalizeFactSnapshot(typedSnapshot),
  };
  const first = evaluator.evaluate(input);
  const retry = new C360SegmentEvaluator(new DcExprEvaluator()).evaluate(input);
  assert.deepEqual(retry, first);
  assert.equal(first.outcome, 'MATCH');
  assert.equal(first.matched, true);
  assert.doesNotMatch(JSON.stringify(first), /synthetic-customer-label|GOLD|2500/);
});

test('expression type mismatch คืน ERROR แบบ deterministic และไม่สร้าง positive result', () => {
  const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
  const invalidType: C360SegmentDefinitionContentV1 = {
    ...definition,
    expression: {
      language: 'DC_EXPR',
      version: 1,
      expression: {
        type: 'comparison',
        operator: 'gt',
        left: { type: 'ref', path: ['contact', 'tier'] },
        right: { type: 'literal', value: 1000 },
      },
    },
  };
  const result = evaluator.evaluate({
    tenantId: 'tenant-a',
    contactId: 'contact-a',
    segmentId: 'segment-gold',
    segmentDefinitionVersion: 1,
    snapshotVersion: 1,
    definition: invalidType,
    snapshot: normalizeFactSnapshot(typedSnapshot),
  });
  assert.equal(result.outcome, 'ERROR');
  assert.equal(result.errorCode, 'TYPE_MISMATCH');
  assert.equal(result.matched, false);
});
