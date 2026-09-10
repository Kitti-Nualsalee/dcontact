import type { ContactChannel } from '@d-contact/cxa-contracts';
import type { ExpressionDocument } from '@d-contact/cxa-contracts';

export type JourneyDefinitionStatus = 'DRAFT' | 'PUBLISHED';

export type JourneyTrigger =
  { kind: 'EVENT'; eventType: string } | { kind: 'SCHEDULE'; cron: string; timezone: string };

export type JourneyGoal = { kind: 'EVENT'; eventType: string };

export type JourneyExitRule =
  { kind: 'GOAL' } | { kind: 'EVENT'; eventType: string } | { kind: 'HIGHER_PRIORITY_JOURNEY' };

export interface JourneySendStep {
  id: string;
  type: 'SEND';
  channel: ContactChannel;
  contentRef: string;
  next: string;
}

export interface JourneyWaitStep {
  id: string;
  type: 'WAIT';
  waitSeconds: number;
  next: string;
}

export interface JourneyBranchStep {
  id: string;
  type: 'BRANCH';
  expression: ExpressionDocument;
  whenTrue: string;
  whenFalse: string;
}

export interface JourneyExitStep {
  id: string;
  type: 'EXIT';
  reason: string;
}

export type JourneyGraphStep =
  JourneySendStep | JourneyWaitStep | JourneyBranchStep | JourneyExitStep;

export interface JourneyGraph {
  entryStepId: string;
  steps: readonly JourneyGraphStep[];
}

export interface JourneyDefinitionContent {
  name: string;
  ownerTeamId: string;
  trigger: JourneyTrigger;
  graph: JourneyGraph;
  goal: JourneyGoal;
  exitRules: readonly JourneyExitRule[];
  maxDurationDays: number;
}

export interface CreateJourneyVersionInput extends JourneyDefinitionContent {
  tenantId: string;
  journeyId: string;
  version: number;
  correlationId: string;
}

export interface JourneyVersionSnapshot extends JourneyDefinitionContent {
  tenantId: string;
  journeyId: string;
  version: number;
  status: JourneyDefinitionStatus;
  contentHash: string;
  publishedAt?: string;
  createdAt: string;
}

export interface PublishJourneyVersionInput {
  tenantId: string;
  journeyId: string;
  version: number;
  expectedContentHash: string;
  correlationId: string;
}

/** ระบุจุดเดียวที่ definition ไม่ผ่านโครงสร้าง/สัญญาที่บังคับก่อน publish ได้ */
export type JourneyDefinitionValidationCode =
  | 'TRIGGER_INVALID'
  | 'GOAL_INVALID'
  | 'EXIT_RULE_INVALID'
  | 'MAX_DURATION_INVALID'
  | 'GRAPH_ENTRY_MISSING'
  | 'GRAPH_STEP_ID_DUPLICATE'
  | 'GRAPH_STEP_REFERENCE_MISSING'
  | 'GRAPH_STEP_UNREACHABLE'
  | 'GRAPH_NO_TERMINAL_REACHABLE'
  | 'GRAPH_STEP_SHAPE_INVALID'
  | 'BRANCH_EXPRESSION_INVALID'
  | 'OWNER_TEAM_UNTRUSTED';

export class JourneyDefinitionValidationError extends Error {
  readonly code = 'DEFINITION_INVALID' as const;

  constructor(readonly reasonCodes: readonly JourneyDefinitionValidationCode[]) {
    super(`Journey definition ไม่ผ่านการตรวจ: ${reasonCodes.join(', ')}`);
    this.name = 'JourneyDefinitionValidationError';
  }
}

export class JourneyVersionConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(
    readonly journeyId: string,
    readonly version: number,
  ) {
    super(`Journey version มีอยู่แล้วด้วยเนื้อหาต่างกัน: ${journeyId}:${version}`);
    this.name = 'JourneyVersionConflictError';
  }
}

export class JourneyVersionSequenceError extends Error {
  readonly code = 'NON_SEQUENTIAL_VERSION' as const;

  constructor(
    readonly journeyId: string,
    readonly version: number,
    readonly expected: number,
  ) {
    super(`Journey version ต้องต่อเนื่อง: ${journeyId} ส่ง ${version} แต่คาดหวัง ${expected}`);
    this.name = 'JourneyVersionSequenceError';
  }
}

export class JourneyVersionNotFoundError extends Error {
  readonly code = 'VERSION_NOT_FOUND' as const;

  constructor(
    readonly journeyId: string,
    readonly version: number,
  ) {
    super(`ไม่พบ Journey version: ${journeyId}:${version}`);
    this.name = 'JourneyVersionNotFoundError';
  }
}
