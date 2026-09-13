import type {
  ExpressionErrorCode,
  ExpressionEvaluator,
  ExpressionValue,
} from '@d-contact/cxa-contracts';
import {
  C360_SEGMENT_EVALUATOR_VERSION,
  stableDigest,
  validateSegmentDefinitionContent,
  type C360NormalizedFactSnapshot,
  type C360SegmentDefinitionContentV1,
} from './segment-definition.js';

export interface EvaluateC360SegmentInput {
  tenantId: string;
  contactId: string;
  segmentId: string;
  segmentDefinitionVersion: number;
  snapshotVersion: number;
  definition: C360SegmentDefinitionContentV1;
  snapshot: C360NormalizedFactSnapshot;
}

export type C360SegmentEvaluationOutcome = 'MATCH' | 'NO_MATCH' | 'ERROR';

export type C360SegmentEvaluation = Readonly<{
  outcome: C360SegmentEvaluationOutcome;
  matched: boolean;
  errorCode?: ExpressionErrorCode;
  inputDigest: string;
  evaluationDigest: string;
  evaluatorVersion: typeof C360_SEGMENT_EVALUATOR_VERSION;
}>;

function sensitivePaths(
  root: 'contact' | 'vars',
  values: Readonly<Record<string, ExpressionValue>>,
): readonly (readonly string[])[] {
  return Object.keys(values).map((key) => [root, key] as const);
}

/**
 * Pure evaluator ของ Customer 360: รับเฉพาะ definition กับ typed snapshot ที่ถูก sync
 * เข้ามาแล้วและคืนเฉพาะ digest/result ไม่มี raw attribute หรือ trace หลุดออกจาก owner boundary
 */
export class C360SegmentEvaluator {
  constructor(private readonly expressionEvaluator: ExpressionEvaluator) {}

  evaluate(input: EvaluateC360SegmentInput): C360SegmentEvaluation {
    const definition = validateSegmentDefinitionContent(input.definition);
    const snapshot = input.snapshot;
    const inputDigest = stableDigest({
      tenantId: input.tenantId,
      contactId: input.contactId,
      segmentId: input.segmentId,
      segmentDefinitionVersion: input.segmentDefinitionVersion,
      snapshotVersion: input.snapshotVersion,
      evaluatorVersion: C360_SEGMENT_EVALUATOR_VERSION,
      definition,
      snapshot,
    });
    const result = this.expressionEvaluator.evaluate({
      document: definition.expression,
      context: { contact: snapshot.attributes, vars: snapshot.computed },
      expectedType: 'boolean',
      sensitivePaths: [
        ...sensitivePaths('contact', snapshot.attributes),
        ...sensitivePaths('vars', snapshot.computed),
      ],
    });
    const outcome: C360SegmentEvaluationOutcome =
      result.status === 'ERROR' ? 'ERROR' : result.value ? 'MATCH' : 'NO_MATCH';
    const errorCode = result.status === 'ERROR' ? result.code : undefined;
    const matched = outcome === 'MATCH';
    return {
      outcome,
      matched,
      ...(errorCode ? { errorCode } : {}),
      inputDigest,
      evaluationDigest: stableDigest({ inputDigest, outcome, errorCode: errorCode ?? null }),
      evaluatorVersion: C360_SEGMENT_EVALUATOR_VERSION,
    };
  }
}
