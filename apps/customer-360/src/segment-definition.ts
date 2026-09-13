import { createHash } from 'node:crypto';
import type {
  ExpressionDocument,
  ExpressionNode,
  ExpressionReferenceRoot,
  ExpressionValue,
} from '@d-contact/cxa-contracts';

export const C360_SEGMENT_DEFINITION_CONTRACT_VERSION = 1 as const;
export const C360_SEGMENT_EVALUATOR_VERSION = 'C360_SEGMENT_EVALUATOR_V1' as const;

export interface C360SegmentDefinitionContentV1 {
  contractVersion: typeof C360_SEGMENT_DEFINITION_CONTRACT_VERSION;
  name: string;
  expression: ExpressionDocument;
}

export type C360TypedFactValue =
  | Readonly<{ type: 'STRING'; value: string }>
  | Readonly<{ type: 'NUMBER'; value: number }>
  | Readonly<{ type: 'BOOLEAN'; value: boolean }>
  | Readonly<{ type: 'TIMESTAMP'; value: string }>
  | Readonly<{ type: 'NULL'; value: null }>;

export interface C360FactSnapshotInput {
  attributes: Readonly<Record<string, C360TypedFactValue>>;
  computed: Readonly<Record<string, C360TypedFactValue>>;
  sourceCutoffAt: string;
}

export interface C360NormalizedFactSnapshot {
  attributes: Readonly<Record<string, ExpressionValue>>;
  computed: Readonly<Record<string, ExpressionValue>>;
  sourceCutoffAt: string;
}

export class C360SegmentContractError extends Error {
  constructor(
    readonly code:
      | 'INVALID_DEFINITION'
      | 'UNSUPPORTED_VERSION'
      | 'FORBIDDEN_REFERENCE'
      | 'INVALID_FACT_SNAPSHOT'
      | 'TYPE_MISMATCH'
      | 'TIME_AMBIGUOUS',
    message: string,
  ) {
    super(message);
    this.name = 'C360SegmentContractError';
  }
}

function objectValue(
  value: unknown,
  field: string,
  code: C360SegmentContractError['code'],
): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new C360SegmentContractError(code, `${field} ต้องเป็น object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  field: string,
  keys: readonly string[],
  code: C360SegmentContractError['code'],
): void {
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new C360SegmentContractError(code, `${field}.${key} ไม่อยู่ใน closed contract`);
    }
  }
  for (const key of keys) {
    if (!(key in value)) {
      throw new C360SegmentContractError(code, `${field}.${key} จำเป็นต้องระบุ`);
    }
  }
}

function validateExpressionNode(value: unknown, field: string): asserts value is ExpressionNode {
  const node = objectValue(value, field, 'INVALID_DEFINITION');
  if (typeof node.type !== 'string') {
    throw new C360SegmentContractError('INVALID_DEFINITION', `${field}.type ไม่รองรับ`);
  }

  switch (node.type) {
    case 'literal':
      exactKeys(node, field, ['type', 'value'], 'INVALID_DEFINITION');
      if (
        node.value !== null &&
        typeof node.value !== 'string' &&
        typeof node.value !== 'number' &&
        typeof node.value !== 'boolean'
      ) {
        throw new C360SegmentContractError('INVALID_DEFINITION', `${field}.value ต้องเป็น scalar`);
      }
      if (typeof node.value === 'number' && !Number.isFinite(node.value)) {
        throw new C360SegmentContractError(
          'INVALID_DEFINITION',
          `${field}.value ต้องเป็น finite number`,
        );
      }
      return;
    case 'ref': {
      exactKeys(node, field, ['type', 'path'], 'INVALID_DEFINITION');
      if (
        !Array.isArray(node.path) ||
        node.path.length < 2 ||
        !node.path.every((part) => typeof part === 'string' && part.length > 0)
      ) {
        throw new C360SegmentContractError(
          'INVALID_DEFINITION',
          `${field}.path ต้องชี้ typed fact อย่างน้อยหนึ่ง field`,
        );
      }
      const root = node.path[0] as ExpressionReferenceRoot;
      if (root !== 'contact' && root !== 'vars') {
        throw new C360SegmentContractError(
          'FORBIDDEN_REFERENCE',
          `${field}.path อ้างได้เฉพาะ contact หรือ vars`,
        );
      }
      if (node.path.some((part) => ['__proto__', 'prototype', 'constructor'].includes(part))) {
        throw new C360SegmentContractError(
          'FORBIDDEN_REFERENCE',
          `${field}.path มี segment ที่ห้ามใช้`,
        );
      }
      return;
    }
    case 'and':
    case 'or':
      exactKeys(node, field, ['type', 'operands'], 'INVALID_DEFINITION');
      if (!Array.isArray(node.operands)) {
        throw new C360SegmentContractError(
          'INVALID_DEFINITION',
          `${field}.operands ต้องเป็น array`,
        );
      }
      node.operands.forEach((child, index) =>
        validateExpressionNode(child, `${field}.operands[${index}]`),
      );
      return;
    case 'not':
    case 'isNull':
      exactKeys(node, field, ['type', 'operand'], 'INVALID_DEFINITION');
      validateExpressionNode(node.operand, `${field}.operand`);
      return;
    case 'comparison':
      exactKeys(node, field, ['type', 'operator', 'left', 'right'], 'INVALID_DEFINITION');
      if (!['eq', 'ne', 'gt', 'gte', 'lt', 'lte'].includes(String(node.operator))) {
        throw new C360SegmentContractError('INVALID_DEFINITION', `${field}.operator ไม่รองรับ`);
      }
      validateExpressionNode(node.left, `${field}.left`);
      validateExpressionNode(node.right, `${field}.right`);
      return;
    case 'in':
      exactKeys(node, field, ['type', 'value', 'items'], 'INVALID_DEFINITION');
      if (!Array.isArray(node.items)) {
        throw new C360SegmentContractError('INVALID_DEFINITION', `${field}.items ต้องเป็น array`);
      }
      validateExpressionNode(node.value, `${field}.value`);
      node.items.forEach((child, index) =>
        validateExpressionNode(child, `${field}.items[${index}]`),
      );
      return;
    case 'coalesce':
      exactKeys(node, field, ['type', 'operands'], 'INVALID_DEFINITION');
      if (!Array.isArray(node.operands) || node.operands.length === 0) {
        throw new C360SegmentContractError(
          'INVALID_DEFINITION',
          `${field}.operands ต้องเป็น non-empty array`,
        );
      }
      node.operands.forEach((child, index) =>
        validateExpressionNode(child, `${field}.operands[${index}]`),
      );
      return;
    default:
      throw new C360SegmentContractError(
        'INVALID_DEFINITION',
        `${field}.type ไม่รองรับ: ${node.type}`,
      );
  }
}

export function validateSegmentDefinitionContent(value: unknown): C360SegmentDefinitionContentV1 {
  const content = objectValue(value, 'definition', 'INVALID_DEFINITION');
  exactKeys(content, 'definition', ['contractVersion', 'name', 'expression'], 'INVALID_DEFINITION');
  if (content.contractVersion !== C360_SEGMENT_DEFINITION_CONTRACT_VERSION) {
    throw new C360SegmentContractError(
      'UNSUPPORTED_VERSION',
      `ไม่รองรับ definition contractVersion: ${String(content.contractVersion)}`,
    );
  }
  if (typeof content.name !== 'string' || content.name.trim().length === 0) {
    throw new C360SegmentContractError('INVALID_DEFINITION', 'definition.name ต้องไม่ว่าง');
  }
  if (content.name.length > 160) {
    throw new C360SegmentContractError(
      'INVALID_DEFINITION',
      'definition.name ยาวเกิน 160 ตัวอักษร',
    );
  }
  const document = objectValue(content.expression, 'definition.expression', 'INVALID_DEFINITION');
  exactKeys(
    document,
    'definition.expression',
    ['language', 'version', 'expression'],
    'INVALID_DEFINITION',
  );
  if (document.language !== 'DC_EXPR') {
    throw new C360SegmentContractError(
      'INVALID_DEFINITION',
      'definition.expression.language ต้องเป็น DC_EXPR',
    );
  }
  if (document.version !== 1) {
    throw new C360SegmentContractError(
      'UNSUPPORTED_VERSION',
      `ไม่รองรับ DC_EXPR version: ${String(document.version)}`,
    );
  }
  validateExpressionNode(document.expression, 'definition.expression.expression');
  return {
    contractVersion: C360_SEGMENT_DEFINITION_CONTRACT_VERSION,
    name: content.name.trim().normalize('NFC'),
    expression: structuredClone(document) as unknown as ExpressionDocument,
  };
}

function validateFactValue(value: unknown, field: string): ExpressionValue {
  const fact = objectValue(value, field, 'INVALID_FACT_SNAPSHOT');
  exactKeys(fact, field, ['type', 'value'], 'INVALID_FACT_SNAPSHOT');
  switch (fact.type) {
    case 'STRING':
      if (typeof fact.value !== 'string') {
        throw new C360SegmentContractError('TYPE_MISMATCH', `${field}.value ต้องเป็น string`);
      }
      return fact.value.normalize('NFC');
    case 'NUMBER':
      if (typeof fact.value !== 'number' || !Number.isFinite(fact.value)) {
        throw new C360SegmentContractError(
          'TYPE_MISMATCH',
          `${field}.value ต้องเป็น finite number`,
        );
      }
      return Object.is(fact.value, -0) ? 0 : fact.value;
    case 'BOOLEAN':
      if (typeof fact.value !== 'boolean') {
        throw new C360SegmentContractError('TYPE_MISMATCH', `${field}.value ต้องเป็น boolean`);
      }
      return fact.value;
    case 'TIMESTAMP': {
      if (typeof fact.value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(fact.value)) {
        throw new C360SegmentContractError(
          'TIME_AMBIGUOUS',
          `${field}.value ต้องเป็น ISO-8601 timestamp ที่มี timezone`,
        );
      }
      const instant = new Date(fact.value);
      if (Number.isNaN(instant.getTime()) || !/(Z|[+-]\d{2}:\d{2})$/.test(fact.value)) {
        throw new C360SegmentContractError(
          'TIME_AMBIGUOUS',
          `${field}.value ต้องเป็น ISO-8601 timestamp ที่มี timezone`,
        );
      }
      return instant.toISOString();
    }
    case 'NULL':
      if (fact.value !== null) {
        throw new C360SegmentContractError('TYPE_MISMATCH', `${field}.value ต้องเป็น null`);
      }
      return null;
    default:
      throw new C360SegmentContractError(
        'INVALID_FACT_SNAPSHOT',
        `${field}.type ไม่รองรับ: ${String(fact.type)}`,
      );
  }
}

function normalizeFactMap(
  value: unknown,
  field: string,
): Readonly<Record<string, ExpressionValue>> {
  const facts = objectValue(value, field, 'INVALID_FACT_SNAPSHOT');
  const normalized: Record<string, ExpressionValue> = {};
  for (const key of Object.keys(facts).sort()) {
    if (
      !/^[A-Za-z][A-Za-z0-9_.-]{0,127}$/.test(key) ||
      ['__proto__', 'prototype', 'constructor'].includes(key)
    ) {
      throw new C360SegmentContractError(
        'INVALID_FACT_SNAPSHOT',
        `${field}.${key} ไม่ใช่ typed fact key ที่รองรับ`,
      );
    }
    normalized[key] = validateFactValue(facts[key], `${field}.${key}`);
  }
  return Object.freeze(normalized);
}

export function normalizeFactSnapshot(value: unknown): C360NormalizedFactSnapshot {
  const snapshot = objectValue(value, 'snapshot', 'INVALID_FACT_SNAPSHOT');
  exactKeys(
    snapshot,
    'snapshot',
    ['attributes', 'computed', 'sourceCutoffAt'],
    'INVALID_FACT_SNAPSHOT',
  );
  if (
    typeof snapshot.sourceCutoffAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(snapshot.sourceCutoffAt) ||
    !/(Z|[+-]\d{2}:\d{2})$/.test(snapshot.sourceCutoffAt)
  ) {
    throw new C360SegmentContractError(
      'TIME_AMBIGUOUS',
      'snapshot.sourceCutoffAt ต้องเป็น ISO-8601 timestamp ที่มี timezone',
    );
  }
  const sourceCutoffAt = new Date(snapshot.sourceCutoffAt);
  if (Number.isNaN(sourceCutoffAt.getTime())) {
    throw new C360SegmentContractError(
      'TIME_AMBIGUOUS',
      'snapshot.sourceCutoffAt ต้องเป็น ISO-8601 timestamp ที่มี timezone',
    );
  }
  return {
    attributes: normalizeFactMap(snapshot.attributes, 'snapshot.attributes'),
    computed: normalizeFactMap(snapshot.computed, 'snapshot.computed'),
    sourceCutoffAt: sourceCutoffAt.toISOString(),
  };
}

export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new C360SegmentContractError('TYPE_MISMATCH', 'canonical value ต้องเป็น finite number');
    }
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      // ห้ามใช้ localeCompare: ผลเรียงขึ้นกับ locale/ICU ของ runtime และทำให้ digest
      // เดียวกันต่างกันได้ข้าม host. เปรียบเทียบ Unicode code units โดยตรงแทน
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new C360SegmentContractError(
    'TYPE_MISMATCH',
    `canonical value ไม่รองรับ type ${typeof value}`,
  );
}

export function stableDigest(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function segmentDefinitionContentDigest(value: unknown): string {
  return stableDigest(validateSegmentDefinitionContent(value));
}
