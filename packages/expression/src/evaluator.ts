import type {
  EvaluateExpressionInput,
  ExpressionComparisonOperator,
  ExpressionContext,
  ExpressionErrorCode,
  ExpressionEvaluationResult,
  ExpressionEvaluator as ExpressionEvaluatorPort,
  ExpressionNode,
  ExpressionTrace,
  ExpressionValue,
  ExpressionValueType,
} from '@d-contact/cxa-contracts';

const MAX_NODES = 256;
const MAX_DEPTH = 32;
const MAX_DOCUMENT_BYTES = 32 * 1024;
const MAX_CONTEXT_BYTES = 4 * 1024 * 1024;
const DEADLINE_MS = 50;
const MASK = '[MASKED]';
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'prototype', 'constructor']);

/** Internal control-flow signal only; never leaves this module as a thrown value. */
class ExpressionRuntimeError extends Error {
  constructor(readonly code: ExpressionErrorCode) {
    super(code);
    this.name = 'ExpressionRuntimeError';
  }
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function valueType(value: ExpressionValue): ExpressionValueType {
  return value === null ? 'null' : (typeof value as ExpressionValueType);
}

function isLiteralValue(value: unknown): value is ExpressionValue {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  );
}

interface CountState {
  nodes: number;
}

/** Single pass over the document that fixes grammar, node count, and depth before any evaluation runs. */
function validate(node: unknown, depth: number, state: CountState): asserts node is ExpressionNode {
  if (depth > MAX_DEPTH) throw new ExpressionRuntimeError('LIMIT_EXCEEDED');
  state.nodes += 1;
  if (state.nodes > MAX_NODES) throw new ExpressionRuntimeError('LIMIT_EXCEEDED');
  if (typeof node !== 'object' || node === null || Array.isArray(node)) {
    throw new ExpressionRuntimeError('INVALID_EXPRESSION');
  }
  const record = node as Record<string, unknown>;
  switch (record.type) {
    case 'literal': {
      if (!isLiteralValue(record.value)) throw new ExpressionRuntimeError('INVALID_EXPRESSION');
      return;
    }
    case 'ref': {
      const path = record.path;
      if (!Array.isArray(path) || path.length === 0 || !path.every((s) => typeof s === 'string')) {
        throw new ExpressionRuntimeError('INVALID_EXPRESSION');
      }
      const root = path[0];
      if (root !== 'vars' && root !== 'contact' && root !== 'interaction') {
        throw new ExpressionRuntimeError('FORBIDDEN_REFERENCE');
      }
      for (const segment of path as string[]) {
        if (FORBIDDEN_SEGMENTS.has(segment))
          throw new ExpressionRuntimeError('FORBIDDEN_REFERENCE');
      }
      return;
    }
    case 'and':
    case 'or': {
      if (!Array.isArray(record.operands)) throw new ExpressionRuntimeError('INVALID_EXPRESSION');
      for (const child of record.operands) validate(child, depth + 1, state);
      return;
    }
    case 'not': {
      validate(record.operand, depth + 1, state);
      return;
    }
    case 'comparison': {
      const operators: ExpressionComparisonOperator[] = ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
      if (!operators.includes(record.operator as ExpressionComparisonOperator)) {
        throw new ExpressionRuntimeError('INVALID_EXPRESSION');
      }
      validate(record.left, depth + 1, state);
      validate(record.right, depth + 1, state);
      return;
    }
    case 'in': {
      if (!Array.isArray(record.items)) throw new ExpressionRuntimeError('INVALID_EXPRESSION');
      validate(record.value, depth + 1, state);
      for (const item of record.items) validate(item, depth + 1, state);
      return;
    }
    case 'coalesce': {
      if (!Array.isArray(record.operands) || record.operands.length === 0) {
        throw new ExpressionRuntimeError('INVALID_EXPRESSION');
      }
      for (const child of record.operands) validate(child, depth + 1, state);
      return;
    }
    case 'isNull': {
      validate(record.operand, depth + 1, state);
      return;
    }
    default:
      throw new ExpressionRuntimeError('INVALID_EXPRESSION');
  }
}

function resolveReference(context: ExpressionContext, path: readonly string[]): ExpressionValue {
  const [root, ...rest] = path;
  let current: unknown = (context as Record<string, unknown>)[root];
  for (const segment of rest) {
    if (FORBIDDEN_SEGMENTS.has(segment)) throw new ExpressionRuntimeError('FORBIDDEN_REFERENCE');
    if (
      current === null ||
      current === undefined ||
      typeof current !== 'object' ||
      Array.isArray(current)
    ) {
      return null;
    }
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return null;
    current = (current as Record<string, unknown>)[segment];
  }
  if (current === undefined) return null;
  if (!isLiteralValue(current)) throw new ExpressionRuntimeError('TYPE_MISMATCH');
  return current;
}

function compare(
  operator: ExpressionComparisonOperator,
  left: ExpressionValue,
  right: ExpressionValue,
): boolean {
  if (operator === 'eq' || operator === 'ne') {
    if (valueType(left) !== valueType(right)) throw new ExpressionRuntimeError('TYPE_MISMATCH');
    return operator === 'eq' ? left === right : left !== right;
  }
  if (typeof left !== 'number' || typeof right !== 'number')
    throw new ExpressionRuntimeError('TYPE_MISMATCH');
  switch (operator) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
  }
}

class Deadline {
  private readonly expiresAt: number;

  constructor(private readonly now: () => number) {
    this.expiresAt = now() + DEADLINE_MS;
  }

  check(): void {
    if (this.now() > this.expiresAt) throw new ExpressionRuntimeError('EVALUATION_TIMEOUT');
  }
}

function evaluateNode(
  node: ExpressionNode,
  context: ExpressionContext,
  deadline: Deadline,
): ExpressionValue {
  deadline.check();
  switch (node.type) {
    case 'literal':
      return node.value;
    case 'ref':
      return resolveReference(context, node.path);
    case 'not': {
      const operand = evaluateNode(node.operand, context, deadline);
      if (typeof operand !== 'boolean') throw new ExpressionRuntimeError('TYPE_MISMATCH');
      return !operand;
    }
    case 'and': {
      for (const child of node.operands) {
        const value = evaluateNode(child, context, deadline);
        if (typeof value !== 'boolean') throw new ExpressionRuntimeError('TYPE_MISMATCH');
        if (!value) return false;
      }
      return true;
    }
    case 'or': {
      for (const child of node.operands) {
        const value = evaluateNode(child, context, deadline);
        if (typeof value !== 'boolean') throw new ExpressionRuntimeError('TYPE_MISMATCH');
        if (value) return true;
      }
      return false;
    }
    case 'comparison': {
      const left = evaluateNode(node.left, context, deadline);
      const right = evaluateNode(node.right, context, deadline);
      return compare(node.operator, left, right);
    }
    case 'in': {
      const value = evaluateNode(node.value, context, deadline);
      for (const itemNode of node.items) {
        const item = evaluateNode(itemNode, context, deadline);
        if (valueType(item) === valueType(value) && item === value) return true;
      }
      return false;
    }
    case 'coalesce': {
      let last: ExpressionValue = null;
      for (const child of node.operands) {
        last = evaluateNode(child, context, deadline);
        if (last !== null) return last;
      }
      return last;
    }
    case 'isNull':
      return evaluateNode(node.operand, context, deadline) === null;
  }
}

function maskContext(
  context: ExpressionContext,
  sensitivePaths: readonly (readonly string[])[],
): unknown {
  const masked = structuredClone(context) as Record<string, unknown>;
  for (const path of sensitivePaths) {
    if (path.length === 0) continue;
    let current: Record<string, unknown> = masked;
    let reachable = true;
    for (let i = 0; i < path.length - 1; i += 1) {
      const next = current[path[i]];
      if (typeof next !== 'object' || next === null || Array.isArray(next)) {
        reachable = false;
        break;
      }
      current = next as Record<string, unknown>;
    }
    const last = path[path.length - 1];
    if (reachable && Object.prototype.hasOwnProperty.call(current, last)) {
      current[last] = MASK;
    }
  }
  return masked;
}

/**
 * Owner: Flow/Expression. Trusts nothing from the document: grammar, size, depth,
 * node count, reference roots, and result type are all checked before a value is
 * produced. See ADR-021 and Phase Contract #64 for the invariants this enforces.
 */
export class DcExprEvaluator implements ExpressionEvaluatorPort {
  constructor(private readonly now: () => number = Date.now) {}

  evaluate(input: EvaluateExpressionInput): ExpressionEvaluationResult {
    const start = this.now();
    const sensitivePaths = input.sensitivePaths ?? [];
    const trace = (result?: ExpressionValue): ExpressionTrace => ({
      maskedContext: maskContext(input.context, sensitivePaths),
      result,
      durationMs: this.now() - start,
    });
    try {
      if (input.document.language !== 'DC_EXPR')
        throw new ExpressionRuntimeError('INVALID_EXPRESSION');
      if (input.document.version !== 1) throw new ExpressionRuntimeError('UNSUPPORTED_VERSION');
      if (byteLength(input.document) > MAX_DOCUMENT_BYTES)
        throw new ExpressionRuntimeError('LIMIT_EXCEEDED');
      if (byteLength(input.context) > MAX_CONTEXT_BYTES)
        throw new ExpressionRuntimeError('LIMIT_EXCEEDED');

      validate(input.document.expression, 1, { nodes: 0 });
      const deadline = new Deadline(this.now);
      const value = evaluateNode(input.document.expression, input.context, deadline);
      if (valueType(value) !== input.expectedType)
        throw new ExpressionRuntimeError('TYPE_MISMATCH');

      return { status: 'OK', value, trace: trace(value) };
    } catch (error) {
      if (error instanceof ExpressionRuntimeError) {
        return { status: 'ERROR', code: error.code, trace: trace() };
      }
      throw error;
    }
  }
}
