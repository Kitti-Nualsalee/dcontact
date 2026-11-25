import type { ContactChannel } from '@d-contact/cxa-contracts';
import type { ExpressionDocument } from '@d-contact/cxa-contracts';

export type JourneyDefinitionStatus = 'DRAFT' | 'PUBLISHED';

/**
 * J2.2: the allowlist confirmed in #120 — canonical business outcomes only, not
 * interaction lifecycle/offer/queue events or CG2 delivery/settlement outcomes
 */
export const INTERACTION_OUTCOME_TYPES = [
  'INTERACTION_ABANDONED',
  'INTERACTION_DISPOSITION_RECORDED',
  'FEEDBACK_DETRACTOR_RECORDED',
] as const;

export type InteractionOutcomeType = (typeof INTERACTION_OUTCOME_TYPES)[number];

/** V1 supports a single coalescing policy per #120; other values must go back to the Phase Spec first */
export type JourneyOutcomeCoalescingPolicy = 'PER_LOGICAL_OUTCOME';

/**
 * J3.4 (#215): SEGMENT_ENTRY coalesces per "one segment entry", not per membership
 * revision — correcting (CORRECTED) the values of an existing entry is therefore not a new trigger. Other values must go back to
 * the Phase Spec first, just like PER_LOGICAL_OUTCOME
 */
export type JourneySegmentCoalescingPolicy = 'PER_SEGMENT_ENTRY';

export type JourneyTrigger =
  | { kind: 'EVENT'; eventType: string }
  | { kind: 'SCHEDULE'; cron: string; timezone: string }
  | {
      kind: 'INTERACTION_OUTCOME';
      outcomeType: InteractionOutcomeType;
      /** sub disposition/outcome code within outcomeType (e.g. CALLBACK_REQUESTED); optional when the type has no sub-code */
      outcomeCode?: string;
      coalescingPolicy: JourneyOutcomeCoalescingPolicy;
    }
  /**
   * J3.4 (#215): a trigger from the canonical segment membership of Customer 360
   *
   * Can only keep an opaque segmentId — no raw attributes, segment expression,
   * member list or snapshot sent by the caller, because Journey does not own the segment definition and
   * embedding the definition here would leave a published version stuck on an old definition that Customer 360 has since changed
   * (see the stop condition of #215). Deciding whether a contact is really in a segment belongs to
   * Customer 360 at runtime only
   */
  | {
      kind: 'SEGMENT_ENTRY';
      segmentId: string;
      coalescingPolicy: JourneySegmentCoalescingPolicy;
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
 * J2.2 closed action intents — Journey decides the intent only; the owner (Cases/Dialer) is the one that
 * writes the real state per #121; only the target reference in opaque internal ID form is kept here,
 * no raw contact data/free text, and no reservation is created and no command is dispatched yet
 */
export interface JourneyEnsureCaseStep {
  id: string;
  type: 'ENSURE_CASE';
  /** case-type/policy reference Cases uses to choose the dedupe/reopen policy — internal ID only */
  caseTypeId: string;
  /** routing intent reference allowed to be forwarded to Cases — required per J2OwnerCommandPayloadV1.intent (#131) */
  routingIntentRef: string;
  /** target owner team of this command (#122) — pinned from the same published version as ownerTeamId */
  targetOwnerTeamId: string;
  /** transition when CREATED/LINKED/REOPENED is received */
  next: string;
  /** transition when Cases answers REJECTED */
  onReject: string;
}

export interface JourneyAdmitCampaignTargetStep {
  id: string;
  type: 'ADMIT_CAMPAIGN_TARGET';
  /** An existing Campaign only — Journey must not create/edit a Campaign, per #121 */
  campaignId: string;
  /** target owner team of this command (#122) — pinned from the same published version as ownerTeamId */
  targetOwnerTeamId: string;
  /** transition when ADMITTED/ALREADY_ADMITTED is received */
  next: string;
  /** transition when Dialer answers REJECTED */
  onReject: string;
}

export interface JourneyScheduleCallbackStep {
  id: string;
  type: 'SCHEDULE_CALLBACK';
  /** time of the callback request, relative to the trigger — the definition is declarative in advance */
  requestedInSeconds: number;
  /** queue affinity reference — required per J2OwnerCommandPayloadV1.intent (#131) */
  queueId: string;
  agentId?: string;
  /** target owner team of this command (#122) — pinned from the same published version as ownerTeamId */
  targetOwnerTeamId: string;
  /** transition when SCHEDULED/ALREADY_SCHEDULED is received */
  next: string;
  /** transition when Dialer answers REJECTED */
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
  /** consent/policy purpose (e.g. MARKETING, SERVICE) shared by every SEND step in this version */
  purpose: string;
  /** sender identity bound to the delivery binding of every SEND step — C1 is TEST_ADAPTER only */
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

/** Identifies the single place where a definition fails the structure/contract enforced before publish */
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
  | 'OWNER_TEAM_UNTRUSTED'
  | 'TARGET_TEAM_UNTRUSTED'
  | 'ENTRY_STEP_ACTION_INTENT_REQUIRED'
  /**
   * J3.4 (#215): the referenced segment is not a segment published in this tenant
   *
   * One code deliberately covers "does not exist", "belongs to another tenant" and "exists but not yet published"
   * — with separate codes a caller could guess whether a segmentId they tried exists in another tenant,
   * which would leak existence across tenants
   */
  | 'SEGMENT_REFERENCE_UNTRUSTED';

export class JourneyDefinitionValidationError extends Error {
  readonly code = 'DEFINITION_INVALID' as const;

  constructor(readonly reasonCodes: readonly JourneyDefinitionValidationCode[]) {
    super(`Journey definition failed validation: ${reasonCodes.join(', ')}`);
    this.name = 'JourneyDefinitionValidationError';
  }
}

export class JourneyVersionConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT' as const;

  constructor(
    readonly journeyId: string,
    readonly version: number,
  ) {
    super(`Journey version already exists with different content: ${journeyId}:${version}`);
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
    super(
      `Journey version must be contiguous: ${journeyId} sent ${version} but expected ${expected}`,
    );
    this.name = 'JourneyVersionSequenceError';
  }
}

export class JourneyVersionNotFoundError extends Error {
  readonly code = 'VERSION_NOT_FOUND' as const;

  constructor(
    readonly journeyId: string,
    readonly version: number,
  ) {
    super(`Journey version not found: ${journeyId}:${version}`);
    this.name = 'JourneyVersionNotFoundError';
  }
}
