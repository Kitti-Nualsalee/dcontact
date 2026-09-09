/**
 * DC_EXPR contract for the deterministic, sandboxed expression language used by
 * Journey `BRANCH` (ADR-021). A document is data, never executable source: no
 * JavaScript, no `eval`, no `node:vm`. This module fixes the wire shape only;
 * `@d-contact/expression` owns grammar, limits, and evaluation.
 */

export type ExpressionValue = string | number | boolean | null;
export type ExpressionValueType = 'string' | 'number' | 'boolean' | 'null';

export interface ExpressionLiteralNode {
  type: 'literal';
  value: ExpressionValue;
}

export type ExpressionReferenceRoot = 'vars' | 'contact' | 'interaction';

/** Read-only reference; the first path segment selects the root binding. */
export interface ExpressionReferenceNode {
  type: 'ref';
  path: readonly [ExpressionReferenceRoot, ...string[]];
}

export interface ExpressionAndNode {
  type: 'and';
  operands: readonly ExpressionNode[];
}

export interface ExpressionOrNode {
  type: 'or';
  operands: readonly ExpressionNode[];
}

export interface ExpressionNotNode {
  type: 'not';
  operand: ExpressionNode;
}

export type ExpressionComparisonOperator = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte';

export interface ExpressionComparisonNode {
  type: 'comparison';
  operator: ExpressionComparisonOperator;
  left: ExpressionNode;
  right: ExpressionNode;
}

export interface ExpressionInNode {
  type: 'in';
  value: ExpressionNode;
  items: readonly ExpressionNode[];
}

export interface ExpressionCoalesceNode {
  type: 'coalesce';
  operands: readonly ExpressionNode[];
}

export interface ExpressionIsNullNode {
  type: 'isNull';
  operand: ExpressionNode;
}

export type ExpressionNode =
  | ExpressionLiteralNode
  | ExpressionReferenceNode
  | ExpressionAndNode
  | ExpressionOrNode
  | ExpressionNotNode
  | ExpressionComparisonNode
  | ExpressionInNode
  | ExpressionCoalesceNode
  | ExpressionIsNullNode;

/** Versioned so later additions (map/filter/reduce, string transforms) expand this type; V1 never forks a second Journey DSL. */
export interface ExpressionDocument {
  language: 'DC_EXPR';
  version: 1;
  expression: ExpressionNode;
}

export interface ExpressionContext {
  vars?: Readonly<Record<string, unknown>>;
  contact?: Readonly<Record<string, unknown>>;
  interaction?: Readonly<Record<string, unknown>>;
}

export interface EvaluateExpressionInput {
  document: ExpressionDocument;
  context: ExpressionContext;
  expectedType: ExpressionValueType;
  /** Context paths masked in the returned trace regardless of whether the expression reads them. */
  sensitivePaths?: readonly (readonly string[])[];
}

export interface ExpressionTrace {
  /** `context` with every declared sensitive path replaced; safe to persist in a flow trace. */
  maskedContext: unknown;
  result?: ExpressionValue;
  durationMs: number;
}

export interface ExpressionEvaluationSuccess {
  status: 'OK';
  value: ExpressionValue;
  trace: ExpressionTrace;
}

export type ExpressionErrorCode =
  | 'INVALID_EXPRESSION'
  | 'UNSUPPORTED_VERSION'
  | 'TYPE_MISMATCH'
  | 'LIMIT_EXCEEDED'
  | 'EVALUATION_TIMEOUT'
  | 'FORBIDDEN_REFERENCE';

export interface ExpressionEvaluationFailure {
  status: 'ERROR';
  code: ExpressionErrorCode;
  trace: ExpressionTrace;
}

export type ExpressionEvaluationResult = ExpressionEvaluationSuccess | ExpressionEvaluationFailure;

/**
 * Owner: Flow/Expression. Synchronous by contract: DC_EXPR forbids I/O, so an
 * implementation that needs to await anything is already out of grammar.
 */
export interface ExpressionEvaluator {
  evaluate(input: EvaluateExpressionInput): ExpressionEvaluationResult;
}
