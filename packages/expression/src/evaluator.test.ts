import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  ExpressionContext,
  ExpressionDocument,
  ExpressionNode,
  ExpressionValue,
} from '@d-contact/cxa-contracts';
import { DcExprEvaluator } from './evaluator.js';

function doc(expression: ExpressionNode, version: 1 | number = 1): ExpressionDocument {
  return { language: 'DC_EXPR', version, expression } as ExpressionDocument;
}

const lit = (value: ExpressionValue): ExpressionNode => ({ type: 'literal', value });
const ref = (...path: readonly string[]): ExpressionNode =>
  ({ type: 'ref', path }) as ExpressionNode;

const context: ExpressionContext = {
  vars: { threshold: 10, name: 'Somchai', flag: true, nested: { city: 'Bangkok' } },
  contact: { tier: 'GOLD', nationalId: '1-2345-67890-12-3' },
  interaction: { channel: 'VOICE' },
};

function run(
  node: ExpressionNode,
  expectedType: 'string' | 'number' | 'boolean' | 'null' = 'boolean',
) {
  return new DcExprEvaluator().evaluate({ document: doc(node), context, expectedType });
}

test('literal round-trips for every scalar type', () => {
  const result = run(lit('hi'), 'string');
  assert.equal(result.status, 'OK');
  assert.equal((result as { value: unknown }).value, 'hi');
  assert.deepEqual((result as { trace: { maskedContext: unknown } }).trace.maskedContext, context);
  assert.equal((result as { trace: { result: unknown } }).trace.result, 'hi');
  assert.equal(run(lit(1), 'number').status, 'OK');
  assert.equal((run(lit(1), 'number') as { value: unknown }).value, 1);
  assert.equal((run(lit(true)) as { value: unknown }).value, true);
  assert.equal((run(lit(null), 'null') as { value: unknown }).value, null);
});

test('result type must match expectedType', () => {
  const result = run(lit('hi'), 'boolean');
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'TYPE_MISMATCH');
});

test('ref resolves nested vars/contact/interaction and missing path resolves to null', () => {
  assert.equal(
    (run(ref('vars', 'nested', 'city'), 'string') as { value: unknown }).value,
    'Bangkok',
  );
  assert.equal((run(ref('contact', 'tier'), 'string') as { value: unknown }).value, 'GOLD');
  assert.equal((run(ref('interaction', 'channel'), 'string') as { value: unknown }).value, 'VOICE');
  assert.equal((run(ref('vars', 'doesNotExist'), 'null') as { value: unknown }).value, null);
  assert.equal(
    (run(ref('vars', 'nested', 'missing', 'deeper'), 'null') as { value: unknown }).value,
    null,
  );
  assert.equal((run(ref('vars', 'threshold'), 'number') as { value: unknown }).value, 10);
});

test('ref into a non-scalar leaf is TYPE_MISMATCH', () => {
  const result = run(ref('vars', 'nested'), 'string');
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'TYPE_MISMATCH');
});

test('root outside vars/contact/interaction is FORBIDDEN_REFERENCE', () => {
  const result = run(ref('process', 'env'), 'string');
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'FORBIDDEN_REFERENCE');
});

for (const segment of ['__proto__', 'prototype', 'constructor']) {
  test(`path segment "${segment}" is FORBIDDEN_REFERENCE`, () => {
    const result = run(ref('vars', segment, 'polluted'), 'null');
    assert.equal(result.status, 'ERROR');
    assert.equal((result as { code: string }).code, 'FORBIDDEN_REFERENCE');
  });
}

test('prototype pollution via JSON.parse own-property does not leak host prototype', () => {
  const poisoned = JSON.parse('{"vars":{"__proto__":{"polluted":true}}}') as ExpressionContext;
  const evaluator = new DcExprEvaluator();
  const result = evaluator.evaluate({
    document: doc(ref('vars', '__proto__', 'polluted')),
    context: poisoned,
    expectedType: 'boolean',
  });
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'FORBIDDEN_REFERENCE');
  assert.equal(({} as { polluted?: boolean }).polluted, undefined);
});

test('and/or/not truth table with short-circuit that skips ill-typed unreached operands', () => {
  assert.equal(
    (run({ type: 'and', operands: [lit(true), lit(true)] }) as { value: unknown }).value,
    true,
  );
  assert.equal(
    (
      run({ type: 'and', operands: [lit(false), lit('boom') as ExpressionNode] }) as {
        value: unknown;
      }
    ).value,
    false,
  );
  assert.equal(
    (
      run({ type: 'or', operands: [lit(true), lit('boom') as ExpressionNode] }) as {
        value: unknown;
      }
    ).value,
    true,
  );
  assert.equal(
    (run({ type: 'or', operands: [lit(false), lit(false)] }) as { value: unknown }).value,
    false,
  );
  assert.equal((run({ type: 'not', operand: lit(false) }) as { value: unknown }).value, true);
  const mismatch = run({ type: 'and', operands: [lit(1 as unknown as boolean)] });
  assert.equal(mismatch.status, 'ERROR');
  assert.equal((mismatch as { code: string }).code, 'TYPE_MISMATCH');
});

test('comparison truth table: eq/ne/gt/gte/lt/lte', () => {
  const cmp = (operator: string, left: ExpressionValue, right: ExpressionValue) =>
    run({ type: 'comparison', operator, left: lit(left), right: lit(right) } as ExpressionNode);
  assert.equal((cmp('eq', 1, 1) as { value: unknown }).value, true);
  assert.equal((cmp('eq', 1, 2) as { value: unknown }).value, false);
  assert.equal((cmp('ne', 1, 2) as { value: unknown }).value, true);
  assert.equal((cmp('gt', 2, 1) as { value: unknown }).value, true);
  assert.equal((cmp('gte', 1, 1) as { value: unknown }).value, true);
  assert.equal((cmp('lt', 1, 2) as { value: unknown }).value, true);
  assert.equal((cmp('lte', 1, 1) as { value: unknown }).value, true);
  assert.equal((cmp('eq', null, null) as { value: unknown }).value, true);
  assert.equal((cmp('eq', '1', 1) as { code: string }).code, 'TYPE_MISMATCH');
  assert.equal((cmp('gt', '1', '0') as { code: string }).code, 'TYPE_MISMATCH');
});

test('in is lenient across mixed-type candidates and equal only on same type+value', () => {
  const inNode = (value: ExpressionValue, items: readonly ExpressionValue[]): ExpressionNode => ({
    type: 'in',
    value: lit(value),
    items: items.map(lit),
  });
  assert.equal((run(inNode('a', ['a', 1, true])) as { value: unknown }).value, true);
  assert.equal((run(inNode(1, ['a', 1, true])) as { value: unknown }).value, true);
  assert.equal((run(inNode(2, ['a', 1, true])) as { value: unknown }).value, false);
  assert.equal((run(inNode(null, [null])) as { value: unknown }).value, true);
  assert.equal((run(inNode('a', [])) as { value: unknown }).value, false);
});

test('vacuous and/or over an empty operand list follow the boolean identity', () => {
  assert.equal((run({ type: 'and', operands: [] }) as { value: unknown }).value, true);
  assert.equal((run({ type: 'or', operands: [] }) as { value: unknown }).value, false);
});

test('coalesce returns first non-null; all-null coalesce is null', () => {
  assert.equal(
    (
      run({ type: 'coalesce', operands: [lit(null), lit(null), lit('x')] }, 'string') as {
        value: unknown;
      }
    ).value,
    'x',
  );
  assert.equal(
    (run({ type: 'coalesce', operands: [lit(null), lit(null)] }, 'null') as { value: unknown })
      .value,
    null,
  );
});

test('isNull reports presence correctly', () => {
  assert.equal((run({ type: 'isNull', operand: lit(null) }) as { value: unknown }).value, true);
  assert.equal((run({ type: 'isNull', operand: lit('x') }) as { value: unknown }).value, false);
});

test('unsupported document version and language are rejected before evaluation', () => {
  const evaluator = new DcExprEvaluator();
  const badVersion = evaluator.evaluate({
    document: doc(lit(true), 2),
    context,
    expectedType: 'boolean',
  });
  assert.equal((badVersion as { code: string }).code, 'UNSUPPORTED_VERSION');

  const badLanguage = evaluator.evaluate({
    document: { language: 'JS' as 'DC_EXPR', version: 1, expression: lit(true) },
    context,
    expectedType: 'boolean',
  });
  assert.equal((badLanguage as { code: string }).code, 'INVALID_EXPRESSION');
});

test('malformed nodes are INVALID_EXPRESSION', () => {
  const cases: ExpressionNode[] = [
    { type: 'unknown' } as unknown as ExpressionNode,
    { type: 'literal', value: { nested: true } } as unknown as ExpressionNode,
    { type: 'ref', path: [] } as unknown as ExpressionNode,
    { type: 'and', operands: 'not-an-array' } as unknown as ExpressionNode,
    { type: 'in', value: lit(1), items: 'not-an-array' } as unknown as ExpressionNode,
    { type: 'coalesce', operands: [] } as unknown as ExpressionNode,
    {
      type: 'comparison',
      operator: 'weird',
      left: lit(1),
      right: lit(1),
    } as unknown as ExpressionNode,
  ];
  for (const node of cases) {
    const result = run(node, 'boolean');
    assert.equal(result.status, 'ERROR');
    assert.equal((result as { code: string }).code, 'INVALID_EXPRESSION');
  }
});

test('node count above 256 is LIMIT_EXCEEDED even at shallow depth', () => {
  const operands = Array.from({ length: 257 }, () => lit(true));
  const result = run({ type: 'and', operands });
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'LIMIT_EXCEEDED');
});

test('nesting deeper than 32 is LIMIT_EXCEEDED even with few nodes', () => {
  let node: ExpressionNode = lit(true);
  for (let i = 0; i < 33; i += 1) node = { type: 'not', operand: node };
  const result = run(node, 'boolean');
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'LIMIT_EXCEEDED');
});

test('oversized document is LIMIT_EXCEEDED', () => {
  const result = run(lit('x'.repeat(40 * 1024)), 'string');
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'LIMIT_EXCEEDED');
});

test('oversized context is LIMIT_EXCEEDED', () => {
  const evaluator = new DcExprEvaluator();
  const result = evaluator.evaluate({
    document: doc(lit(true)),
    context: { vars: { blob: 'x'.repeat(5 * 1024 * 1024) } },
    expectedType: 'boolean',
  });
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'LIMIT_EXCEEDED');
});

test('deadline is enforced via injected clock and never leaks a value', () => {
  let calls = 0;
  const evaluator = new DcExprEvaluator(() => {
    const elapsed = calls * 100;
    calls += 1;
    return elapsed;
  });
  const result = evaluator.evaluate({
    document: doc({ type: 'not', operand: lit(true) }),
    context,
    expectedType: 'boolean',
  });
  assert.equal(result.status, 'ERROR');
  assert.equal((result as { code: string }).code, 'EVALUATION_TIMEOUT');
  assert.equal((result as { value?: unknown }).value, undefined);
});

test('evaluation is deterministic for identical input across separate evaluator instances', () => {
  const node: ExpressionNode = {
    type: 'and',
    operands: [
      { type: 'comparison', operator: 'gte', left: ref('vars', 'threshold'), right: lit(5) },
      { type: 'in', value: ref('contact', 'tier'), items: [lit('GOLD'), lit('PLATINUM')] },
    ],
  };
  const first = new DcExprEvaluator().evaluate({
    document: doc(node),
    context,
    expectedType: 'boolean',
  });
  const second = new DcExprEvaluator().evaluate({
    document: doc(node),
    context,
    expectedType: 'boolean',
  });
  assert.deepEqual(first, {
    ...second,
    trace: {
      ...second.trace,
      durationMs: (first as { trace: { durationMs: number } }).trace.durationMs,
    },
  });
  assert.equal((first as { value: unknown }).value, true);
});

test('sensitive paths are masked in trace on both success and error, and input context is untouched', () => {
  const evaluator = new DcExprEvaluator();
  const input = {
    document: doc(ref('contact', 'nationalId'), 1),
    context,
    expectedType: 'string' as const,
    sensitivePaths: [
      ['contact', 'nationalId'],
      ['vars', 'missing', 'path'],
    ],
  };
  const ok = evaluator.evaluate(input);
  assert.equal(ok.status, 'OK');
  assert.equal(
    (ok.trace.maskedContext as { contact: { nationalId: string } }).contact.nationalId,
    '[MASKED]',
  );
  assert.equal(context.contact?.nationalId, '1-2345-67890-12-3');

  const failing = evaluator.evaluate({ ...input, expectedType: 'boolean' });
  assert.equal(failing.status, 'ERROR');
  assert.equal(
    (failing.trace.maskedContext as { contact: { nationalId: string } }).contact.nationalId,
    '[MASKED]',
  );
});
