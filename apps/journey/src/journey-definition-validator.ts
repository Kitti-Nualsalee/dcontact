import type { ExpressionEvaluator } from '@d-contact/cxa-contracts';
import {
  INTERACTION_OUTCOME_TYPES,
  type JourneyDefinitionContent,
  type JourneyDefinitionValidationCode,
  type JourneyGraph,
  type JourneyGraphStep,
} from './journey-definition.js';

const MAX_DURATION_DAYS = 3650;
const KNOWN_EXIT_RULE_KINDS = new Set(['GOAL', 'EVENT', 'HIGHER_PRIORITY_JOURNEY']);
const KNOWN_OUTCOME_TYPES = new Set<string>(INTERACTION_OUTCOME_TYPES);

/** opaque internal ID only — rejects free text, email, phone number or whitespace (#121) */
const OPAQUE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isOpaqueId(value: unknown): value is string {
  return typeof value === 'string' && OPAQUE_ID_PATTERN.test(value);
}

const OUTCOME_TRIGGER_FIELDS = new Set(['kind', 'outcomeType', 'outcomeCode', 'coalescingPolicy']);
const SEGMENT_TRIGGER_FIELDS = new Set(['kind', 'segmentId', 'coalescingPolicy']);

/**
 * J3.4 (#215): a trigger must be a closed shape — an unknown field counts as failing.
 *
 * This is not just formal strictness but a trust boundary: if let through, a caller could attach
 * a segment expression, member list, raw attribute values or a snapshot it computed itself to the
 * trigger, and those would be persisted into the definition and carried along with the published version
 * forever, even though Journey does not own the segment definition and must not keep PII (#215)
 *
 * silently dropping a foreign field is not an option either, because the content hash is computed from what the caller sent, so
 * the caller would believe the attached data has an effect when the system never reads it at all
 */
function unknownTriggerFields(
  trigger: object,
  allowed: ReadonlySet<string>,
): JourneyDefinitionValidationCode[] {
  return Object.keys(trigger).every((key) => allowed.has(key)) ? [] : ['TRIGGER_INVALID'];
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
  if (trigger.kind === 'INTERACTION_OUTCOME') {
    if (!KNOWN_OUTCOME_TYPES.has(trigger.outcomeType)) return ['TRIGGER_INVALID'];
    if (trigger.outcomeCode !== undefined && !isOpaqueId(trigger.outcomeCode)) {
      return ['TRIGGER_INVALID'];
    }
    if (trigger.coalescingPolicy !== 'PER_LOGICAL_OUTCOME') return ['TRIGGER_INVALID'];
    return unknownTriggerFields(trigger, OUTCOME_TRIGGER_FIELDS);
  }
  if (trigger.kind === 'SEGMENT_ENTRY') {
    if (!isOpaqueId(trigger.segmentId)) return ['TRIGGER_INVALID'];
    if (trigger.coalescingPolicy !== 'PER_SEGMENT_ENTRY') return ['TRIGGER_INVALID'];
    return unknownTriggerFields(trigger, SEGMENT_TRIGGER_FIELDS);
  }
  return ['TRIGGER_INVALID'];
}

function validateGoal(goal: JourneyDefinitionContent['goal']): JourneyDefinitionValidationCode[] {
  return goal.kind === 'EVENT' && isNonEmptyString(goal.eventType) ? [] : ['GOAL_INVALID'];
}

function validateDeliveryDefaults(
  content: JourneyDefinitionContent,
): JourneyDefinitionValidationCode[] {
  return isNonEmptyString(content.purpose) && isNonEmptyString(content.senderIdentityId)
    ? []
    : ['DELIVERY_DEFAULTS_INVALID'];
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
    case 'ENSURE_CASE':
      return (
        isNonEmptyString(step.caseTypeId) &&
        isNonEmptyString(step.routingIntentRef) &&
        isNonEmptyString(step.targetOwnerTeamId) &&
        isNonEmptyString(step.next) &&
        isNonEmptyString(step.onReject)
      );
    case 'ADMIT_CAMPAIGN_TARGET':
      return (
        isNonEmptyString(step.campaignId) &&
        isNonEmptyString(step.targetOwnerTeamId) &&
        isNonEmptyString(step.next) &&
        isNonEmptyString(step.onReject)
      );
    case 'SCHEDULE_CALLBACK':
      return (
        Number.isFinite(step.requestedInSeconds) &&
        step.requestedInSeconds >= 0 &&
        isNonEmptyString(step.queueId) &&
        isNonEmptyString(step.targetOwnerTeamId) &&
        isNonEmptyString(step.next) &&
        isNonEmptyString(step.onReject)
      );
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
    case 'ENSURE_CASE':
    case 'ADMIT_CAMPAIGN_TARGET':
    case 'SCHEDULE_CALLBACK':
      return [step.next, step.onReject];
  }
}

/**
 * Checks the target reference of an action intent step separately from shape because they mean different things:
 * a wrong shape (missing field) versus a correct shape whose value is not an opaque internal ID (e.g. free text
 * or PII) need separate reason codes so the operator fixes the right thing (#121 internal-ID shape)
 */
function validateActionIntentReferences(
  steps: readonly JourneyGraphStep[],
): JourneyDefinitionValidationCode[] {
  for (const step of steps) {
    if (step.type === 'ENSURE_CASE') {
      if (!isOpaqueId(step.caseTypeId)) return ['ACTION_INTENT_REFERENCE_INVALID'];
      if (!isOpaqueId(step.routingIntentRef)) return ['ACTION_INTENT_REFERENCE_INVALID'];
      if (!isOpaqueId(step.targetOwnerTeamId)) return ['ACTION_INTENT_REFERENCE_INVALID'];
    } else if (step.type === 'ADMIT_CAMPAIGN_TARGET') {
      if (!isOpaqueId(step.campaignId)) return ['ACTION_INTENT_REFERENCE_INVALID'];
      if (!isOpaqueId(step.targetOwnerTeamId)) return ['ACTION_INTENT_REFERENCE_INVALID'];
    } else if (step.type === 'SCHEDULE_CALLBACK') {
      if (!isOpaqueId(step.queueId)) return ['ACTION_INTENT_REFERENCE_INVALID'];
      if (step.agentId !== undefined && !isOpaqueId(step.agentId)) {
        return ['ACTION_INTENT_REFERENCE_INVALID'];
      }
      if (!isOpaqueId(step.targetOwnerTeamId)) return ['ACTION_INTENT_REFERENCE_INVALID'];
    }
  }
  return [];
}

const ACTION_INTENT_STEP_TYPES = new Set([
  'ENSURE_CASE',
  'ADMIT_CAMPAIGN_TARGET',
  'SCHEDULE_CALLBACK',
]);

/**
 * J2.7: the enrollment/action intent must be created atomically with the receipt transition — bind
 * the entry step of this trigger type directly to an action-intent step, instead of building a second step
 * runner for a mid-graph action intent, which is outside the scope of J2.7 (see #135)
 */
function validateOutcomeTriggerEntryStep(
  content: JourneyDefinitionContent,
): JourneyDefinitionValidationCode[] {
  if (content.trigger.kind !== 'INTERACTION_OUTCOME') return [];
  const entryStep = content.graph.steps.find((step) => step.id === content.graph.entryStepId);
  return entryStep && ACTION_INTENT_STEP_TYPES.has(entryStep.type)
    ? []
    : ['ENTRY_STEP_ACTION_INTENT_REQUIRED'];
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
 * Checks DC_EXPR:1 of every BRANCH step through the central evaluator without a real context —
 * grammar/version/limit/forbidden-reference are all checked before evaluateNode always runs
 * (see `packages/expression/src/evaluator.ts`), so these error codes are used as a signal of a
 * broken structure, while TYPE_MISMATCH/EVALUATION_TIMEOUT caused by an empty context are not evidence that the
 * expression is structurally wrong, so they are not rejected on that basis alone
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
    ...validateDeliveryDefaults(content),
    ...validateExitRules(content.exitRules),
    ...validateMaxDuration(content.maxDurationDays),
    ...graphCodes,
    ...(graphCodes.length === 0
      ? [
          ...validateBranchExpressions(branchSteps, evaluator),
          ...validateActionIntentReferences(content.graph.steps),
          ...validateOutcomeTriggerEntryStep(content),
        ]
      : []),
  ];
  return dedupe(codes);
}
