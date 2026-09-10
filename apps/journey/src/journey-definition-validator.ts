import type { ExpressionEvaluator } from '@d-contact/cxa-contracts';
import type {
  JourneyDefinitionContent,
  JourneyDefinitionValidationCode,
  JourneyGraph,
  JourneyGraphStep,
} from './journey-definition.js';

const MAX_DURATION_DAYS = 3650;
const KNOWN_EXIT_RULE_KINDS = new Set(['GOAL', 'EVENT', 'HIGHER_PRIORITY_JOURNEY']);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateTrigger(
  trigger: JourneyDefinitionContent['trigger'],
): JourneyDefinitionValidationCode[] {
  if (trigger.kind === 'EVENT') {
    return isNonEmptyString(trigger.eventType) ? [] : ['TRIGGER_INVALID'];
  }
  if (trigger.kind === 'SCHEDULE') {
    return isNonEmptyString(trigger.cron) && isNonEmptyString(trigger.timezone)
      ? []
      : ['TRIGGER_INVALID'];
  }
  return ['TRIGGER_INVALID'];
}

function validateGoal(goal: JourneyDefinitionContent['goal']): JourneyDefinitionValidationCode[] {
  return goal.kind === 'EVENT' && isNonEmptyString(goal.eventType) ? [] : ['GOAL_INVALID'];
}

function validateExitRules(
  exitRules: JourneyDefinitionContent['exitRules'],
): JourneyDefinitionValidationCode[] {
  if (!Array.isArray(exitRules) || exitRules.length === 0) return ['EXIT_RULE_INVALID'];
  for (const rule of exitRules) {
    if (!rule || !KNOWN_EXIT_RULE_KINDS.has(rule.kind)) return ['EXIT_RULE_INVALID'];
    if (rule.kind === 'EVENT' && !isNonEmptyString(rule.eventType)) return ['EXIT_RULE_INVALID'];
  }
  return [];
}

function validateMaxDuration(maxDurationDays: number): JourneyDefinitionValidationCode[] {
  return Number.isInteger(maxDurationDays) &&
    maxDurationDays > 0 &&
    maxDurationDays <= MAX_DURATION_DAYS
    ? []
    : ['MAX_DURATION_INVALID'];
}

function stepShapeValid(step: JourneyGraphStep): boolean {
  if (!isNonEmptyString(step.id)) return false;
  switch (step.type) {
    case 'SEND':
      return (
        isNonEmptyString(step.channel) &&
        isNonEmptyString(step.contentRef) &&
        isNonEmptyString(step.next)
      );
    case 'WAIT':
      return (
        Number.isFinite(step.waitSeconds) && step.waitSeconds > 0 && isNonEmptyString(step.next)
      );
    case 'BRANCH':
      return (
        Boolean(step.expression) &&
        isNonEmptyString(step.whenTrue) &&
        isNonEmptyString(step.whenFalse)
      );
    case 'EXIT':
      return isNonEmptyString(step.reason);
    default:
      return false;
  }
}

function stepSuccessors(step: JourneyGraphStep): string[] {
  switch (step.type) {
    case 'SEND':
    case 'WAIT':
      return [step.next];
    case 'BRANCH':
      return [step.whenTrue, step.whenFalse];
    case 'EXIT':
      return [];
  }
}

function validateGraphStructure(graph: JourneyGraph): {
  codes: JourneyDefinitionValidationCode[];
  branchSteps: JourneyGraphStep[];
} {
  const codes: JourneyDefinitionValidationCode[] = [];
  const branchSteps: JourneyGraphStep[] = [];

  if (
    !isNonEmptyString(graph.entryStepId) ||
    !Array.isArray(graph.steps) ||
    graph.steps.length === 0
  ) {
    return { codes: ['GRAPH_ENTRY_MISSING'], branchSteps };
  }

  const stepsById = new Map<string, JourneyGraphStep>();
  for (const step of graph.steps) {
    if (stepsById.has(step.id)) {
      codes.push('GRAPH_STEP_ID_DUPLICATE');
      continue;
    }
    stepsById.set(step.id, step);
    if (step.type === 'BRANCH') branchSteps.push(step);
  }

  if (!stepsById.has(graph.entryStepId)) codes.push('GRAPH_ENTRY_MISSING');

  for (const step of graph.steps) {
    if (!stepShapeValid(step)) {
      codes.push('GRAPH_STEP_SHAPE_INVALID');
      continue;
    }
    for (const successorId of stepSuccessors(step)) {
      if (!stepsById.has(successorId)) codes.push('GRAPH_STEP_REFERENCE_MISSING');
    }
  }

  if (codes.length > 0) return { codes: dedupe(codes), branchSteps };

  const reachable = new Set<string>();
  const queue: string[] = [graph.entryStepId];
  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    if (reachable.has(currentId)) continue;
    reachable.add(currentId);
    const current = stepsById.get(currentId);
    if (!current) continue;
    for (const successorId of stepSuccessors(current)) {
      if (!reachable.has(successorId)) queue.push(successorId);
    }
  }

  const unreachable = graph.steps.some((step) => !reachable.has(step.id));
  if (unreachable) codes.push('GRAPH_STEP_UNREACHABLE');

  const hasReachableTerminal = graph.steps.some(
    (step) => step.type === 'EXIT' && reachable.has(step.id),
  );
  if (!hasReachableTerminal) codes.push('GRAPH_NO_TERMINAL_REACHABLE');

  return { codes: dedupe(codes), branchSteps };
}

function dedupe(codes: JourneyDefinitionValidationCode[]): JourneyDefinitionValidationCode[] {
  return [...new Set(codes)];
}

/**
 * ตรวจ DC_EXPR:1 ของทุก BRANCH step ผ่าน evaluator กลาง โดยไม่ใช้ context จริง —
 * grammar/version/limit/forbidden-reference ทุกอย่างถูกตรวจก่อน evaluateNode รันเสมอ
 * (ดู `packages/expression/src/evaluator.ts`) จึงใช้ error code เหล่านี้เป็นสัญญาณ
 * โครงสร้างพัง ส่วน TYPE_MISMATCH/EVALUATION_TIMEOUT ที่มาจาก context ว่างไม่ใช่หลักฐานว่า
 * expression ผิดโครงสร้างจึงไม่ reject ด้วยเหตุนี้อย่างเดียว
 */
function validateBranchExpressions(
  branchSteps: readonly JourneyGraphStep[],
  evaluator: ExpressionEvaluator,
): JourneyDefinitionValidationCode[] {
  const structuralErrorCodes = new Set([
    'INVALID_EXPRESSION',
    'UNSUPPORTED_VERSION',
    'LIMIT_EXCEEDED',
    'FORBIDDEN_REFERENCE',
  ]);
  for (const step of branchSteps) {
    if (step.type !== 'BRANCH') continue;
    const result = evaluator.evaluate({
      document: step.expression,
      context: {},
      expectedType: 'boolean',
    });
    if (result.status === 'ERROR' && structuralErrorCodes.has(result.code)) {
      return ['BRANCH_EXPRESSION_INVALID'];
    }
  }
  return [];
}

export function validateJourneyDefinitionStructure(
  content: JourneyDefinitionContent,
  evaluator: ExpressionEvaluator,
): readonly JourneyDefinitionValidationCode[] {
  const { codes: graphCodes, branchSteps } = validateGraphStructure(content.graph);
  const codes = [
    ...validateTrigger(content.trigger),
    ...validateGoal(content.goal),
    ...validateExitRules(content.exitRules),
    ...validateMaxDuration(content.maxDurationDays),
    ...graphCodes,
    ...(graphCodes.length === 0 ? validateBranchExpressions(branchSteps, evaluator) : []),
  ];
  return dedupe(codes);
}
