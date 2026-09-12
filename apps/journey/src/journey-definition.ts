import type { ContactChannel } from '@d-contact/cxa-contracts';
import type { ExpressionDocument } from '@d-contact/cxa-contracts';

export type JourneyDefinitionStatus = 'DRAFT' | 'PUBLISHED';

/**
 * J2.2: allowlist ที่ยืนยันแล้วใน #120 — canonical business outcome เท่านั้น ไม่ใช่
 * interaction lifecycle/offer/queue event หรือ CG2 delivery/settlement outcome
 */
export const INTERACTION_OUTCOME_TYPES = [
  'INTERACTION_ABANDONED',
  'INTERACTION_DISPOSITION_RECORDED',
  'FEEDBACK_DETRACTOR_RECORDED',
] as const;

export type InteractionOutcomeType = (typeof INTERACTION_OUTCOME_TYPES)[number];

/** V1 รองรับ coalescing policy เดียวตาม #120; ค่าอื่นต้องกลับไป Phase Spec ก่อน */
export type JourneyOutcomeCoalescingPolicy = 'PER_LOGICAL_OUTCOME';

export type JourneyTrigger =
  | { kind: 'EVENT'; eventType: string }
  | { kind: 'SCHEDULE'; cron: string; timezone: string }
  | {
      kind: 'INTERACTION_OUTCOME';
      outcomeType: InteractionOutcomeType;
      /** disposition/outcome code ย่อยภายใน outcomeType (เช่น CALLBACK_REQUESTED); optional เมื่อ type ไม่มี sub-code */
      outcomeCode?: string;
      coalescingPolicy: JourneyOutcomeCoalescingPolicy;
    };

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

/**
 * J2.2 closed action intents — Journey ตัดสิน intent เท่านั้น owner (Cases/Dialer) เป็นผู้
 * เขียน state จริงตาม #121; ที่นี่เก็บเฉพาะ target reference รูปแบบ opaque internal ID
 * ห้าม raw contact data/free text และยังไม่สร้าง reservation หรือ dispatch command ใด ๆ
 */
export interface JourneyEnsureCaseStep {
  id: string;
  type: 'ENSURE_CASE';
  /** case-type/policy reference ที่ Cases ใช้เลือก dedupe/reopen policy — internal ID เท่านั้น */
  caseTypeId: string;
  /** routing intent reference ที่อนุญาตส่งต่อ Cases; optional ตาม #121 */
  routingIntentRef?: string;
  /** transition เมื่อได้ CREATED/LINKED/REOPENED */
  next: string;
  /** transition เมื่อ Cases ตอบ REJECTED */
  onReject: string;
}

export interface JourneyAdmitCampaignTargetStep {
  id: string;
  type: 'ADMIT_CAMPAIGN_TARGET';
  /** Campaign ที่มีอยู่แล้วเท่านั้น — ห้ามสร้าง/แก้ Campaign จาก Journey ตาม #121 */
  campaignId: string;
  /** transition เมื่อได้ ADMITTED/ALREADY_ADMITTED */
  next: string;
  /** transition เมื่อ Dialer ตอบ REJECTED */
  onReject: string;
}

export interface JourneyScheduleCallbackStep {
  id: string;
  type: 'SCHEDULE_CALLBACK';
  /** เวลาที่ขอ callback แบบ relative จาก trigger — definition เป็น declarative ล่วงหน้า */
  requestedInSeconds: number;
  /** queue/agent affinity reference; optional ตาม #121 */
  queueId?: string;
  agentId?: string;
  /** transition เมื่อได้ SCHEDULED/ALREADY_SCHEDULED */
  next: string;
  /** transition เมื่อ Dialer ตอบ REJECTED */
  onReject: string;
}

export type JourneyActionIntentStep =
  JourneyEnsureCaseStep | JourneyAdmitCampaignTargetStep | JourneyScheduleCallbackStep;

export type JourneyGraphStep =
  JourneySendStep | JourneyWaitStep | JourneyBranchStep | JourneyExitStep | JourneyActionIntentStep;

export interface JourneyGraph {
  entryStepId: string;
  steps: readonly JourneyGraphStep[];
}

export interface JourneyDefinitionContent {
  name: string;
  ownerTeamId: string;
  /** consent/policy purpose (เช่น MARKETING, SERVICE) ที่ SEND ทุก step ในเวอร์ชันนี้ใช้ร่วมกัน */
  purpose: string;
  /** sender identity ที่ผูกกับ delivery binding ของ SEND ทุก step — C1 เป็น TEST_ADAPTER เท่านั้น */
  senderIdentityId: string;
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
  | 'DELIVERY_DEFAULTS_INVALID'
  | 'EXIT_RULE_INVALID'
  | 'MAX_DURATION_INVALID'
  | 'GRAPH_ENTRY_MISSING'
  | 'GRAPH_STEP_ID_DUPLICATE'
  | 'GRAPH_STEP_REFERENCE_MISSING'
  | 'GRAPH_STEP_UNREACHABLE'
  | 'GRAPH_NO_TERMINAL_REACHABLE'
  | 'GRAPH_STEP_SHAPE_INVALID'
  | 'BRANCH_EXPRESSION_INVALID'
  | 'ACTION_INTENT_REFERENCE_INVALID'
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
