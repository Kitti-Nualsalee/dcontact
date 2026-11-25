/**
 * J5.1 (#339): versioned authoring contract of the Journey visual canvas (Phase Contract #334,
 * Phase Spec #337 §1, §4–§6)
 *
 * The canvas is an authoring projection, not a new runtime DSL: compiling must end only at the existing
 * `JourneyDefinitionContent` of `apps/journey`, so this file does not redefine the runtime type:
 * `CompileArtifactV1` takes the runtime type as a generic for the Journey owner to bind itself
 *
 * Fixed prohibitions (#328-#331):
 * - nodes/ports/triggers are closed sets; no plugin or UI may add more
 * - `step.id = nodeId` 1:1 to preserve `actionKey = enrollmentId:journeyVersion:stepId`
 * - conditions use only `DC_EXPR:1`; no JavaScript/eval/new DSL
 * - layout/viewport is not in the runtime hash, and the document/DTO has no PII or credential
 * - tenant does not come from the client: no request DTO has a `tenantId`
 */
import type { ContactChannel } from './contact-governance.js';
import type { ExpressionDocument } from './expression.js';
import type { JourneyDiagnosticV1 } from './journey-authoring-errors-v1.js';

export const JOURNEY_AUTHORING_SCHEMA_VERSION = 'J5_AUTHORING_V1' as const;
export const JOURNEY_AUTHORING_REGISTRY_VERSION = 'J5_PALETTE_V1' as const;
export const JOURNEY_COMPILE_ARTIFACT_VERSION = 1 as const;

export type JourneyAuthoringSchemaVersion = typeof JOURNEY_AUTHORING_SCHEMA_VERSION;
export type JourneyAuthoringRegistryVersion = typeof JOURNEY_AUTHORING_REGISTRY_VERSION;

/** V1 limits (#329): there is no loop/iteration contract, so cycles and oversized graphs are rejected */
export const JOURNEY_AUTHORING_LIMITS = Object.freeze({
  runtimeSteps: 256,
  controlEdges: 512,
  compiledRuntimeBytes: 256 * 1024,
  simulationTransitions: 1_024,
} as const);

// ── Node and port catalog (#328) ─────────────────────────────────────────────

export const JOURNEY_TRIGGER_NODE_TYPES = Object.freeze([
  'EVENT_TRIGGER',
  'SCHEDULE_TRIGGER',
  'INTERACTION_OUTCOME_TRIGGER',
  'SEGMENT_ENTRY_TRIGGER',
] as const);
export type JourneyTriggerNodeType = (typeof JOURNEY_TRIGGER_NODE_TYPES)[number];

export const JOURNEY_RUNTIME_NODE_TYPES = Object.freeze([
  'SEND',
  'WAIT',
  'BRANCH',
  'EXIT',
] as const);

/** J2 owner action: may be placed only as the entry step after INTERACTION_OUTCOME_TRIGGER (#328 §4) */
export const JOURNEY_RESTRICTED_NODE_TYPES = Object.freeze([
  'ENSURE_CASE',
  'ADMIT_CAMPAIGN_TARGET',
  'SCHEDULE_CALLBACK',
] as const);

export type JourneyRuntimeNodeType = (typeof JOURNEY_RUNTIME_NODE_TYPES)[number];
export type JourneyRestrictedNodeType = (typeof JOURNEY_RESTRICTED_NODE_TYPES)[number];
export type JourneyStepNodeType = JourneyRuntimeNodeType | JourneyRestrictedNodeType;

export const JOURNEY_PORT_IDS = Object.freeze([
  'start',
  'in',
  'next',
  'true',
  'false_or_error',
  'accepted',
  'rejected',
] as const);
export type JourneyPortId = (typeof JOURNEY_PORT_IDS)[number];

/**
 * ports of each node with the runtime field an output port compiles into: one output port per
 * single target because the runtime field is a scalar; a restricted action uses `next`/`onReject`
 */
export const JOURNEY_NODE_PORTS = Object.freeze({
  EVENT_TRIGGER: { input: null, outputs: { start: 'entryStepId' } },
  SCHEDULE_TRIGGER: { input: null, outputs: { start: 'entryStepId' } },
  INTERACTION_OUTCOME_TRIGGER: { input: null, outputs: { start: 'entryStepId' } },
  SEGMENT_ENTRY_TRIGGER: { input: null, outputs: { start: 'entryStepId' } },
  SEND: { input: 'in', outputs: { next: 'next' } },
  WAIT: { input: 'in', outputs: { next: 'next' } },
  BRANCH: { input: 'in', outputs: { true: 'whenTrue', false_or_error: 'whenFalse' } },
  EXIT: { input: 'in', outputs: {} },
  ENSURE_CASE: { input: 'in', outputs: { accepted: 'next', rejected: 'onReject' } },
  ADMIT_CAMPAIGN_TARGET: { input: 'in', outputs: { accepted: 'next', rejected: 'onReject' } },
  SCHEDULE_CALLBACK: { input: 'in', outputs: { accepted: 'next', rejected: 'onReject' } },
} as const satisfies Readonly<
  Record<
    JourneyTriggerNodeType | JourneyStepNodeType,
    { input: 'in' | null; outputs: Readonly<Partial<Record<JourneyPortId, string>>> }
  >
>);

export const JOURNEY_INTERACTION_OUTCOME_TYPES = Object.freeze([
  'INTERACTION_ABANDONED',
  'INTERACTION_DISPOSITION_RECORDED',
  'FEEDBACK_DETRACTOR_RECORDED',
] as const);

// ── Authoring document (Phase Spec §4) ───────────────────────────────────────

export type AuthoringTriggerNodeV1 = {
  readonly nodeId: string;
  readonly label?: string;
} & (
  | { readonly type: 'EVENT_TRIGGER'; readonly config: { readonly eventType: string } }
  | {
      readonly type: 'SCHEDULE_TRIGGER';
      readonly config: { readonly cron: string; readonly timezone: string };
    }
  | {
      readonly type: 'INTERACTION_OUTCOME_TRIGGER';
      readonly config: {
        readonly outcomeType: (typeof JOURNEY_INTERACTION_OUTCOME_TYPES)[number];
        readonly outcomeCode?: string;
        readonly coalescingPolicy: 'PER_LOGICAL_OUTCOME';
      };
    }
  | {
      readonly type: 'SEGMENT_ENTRY_TRIGGER';
      readonly config: {
        readonly segmentId: string;
        readonly coalescingPolicy: 'PER_SEGMENT_ENTRY';
      };
    }
);

interface AuthoringStepNodeBase {
  readonly nodeId: string;
  readonly label?: string;
  /** stable key from the template for provenance/upgrade: not a runtime identity */
  readonly templateNodeKey?: string;
}

/** a step's fields are runtime fields that are not transitions: transitions come only from edges */
export type AuthoringStepNodeV1 = AuthoringStepNodeBase &
  (
    | {
        readonly type: 'SEND';
        readonly config: { readonly channel: ContactChannel; readonly contentRef: string };
      }
    | { readonly type: 'WAIT'; readonly config: { readonly waitSeconds: number } }
    | { readonly type: 'BRANCH'; readonly config: { readonly expression: ExpressionDocument } }
    | { readonly type: 'EXIT'; readonly config: { readonly reason: string } }
    | {
        readonly type: 'ENSURE_CASE';
        readonly config: {
          readonly caseTypeId: string;
          readonly routingIntentRef: string;
          readonly targetOwnerTeamId: string;
        };
      }
    | {
        readonly type: 'ADMIT_CAMPAIGN_TARGET';
        readonly config: { readonly campaignId: string; readonly targetOwnerTeamId: string };
      }
    | {
        readonly type: 'SCHEDULE_CALLBACK';
        readonly config: {
          readonly requestedInSeconds: number;
          readonly queueId: string;
          readonly agentId?: string;
          readonly targetOwnerTeamId: string;
        };
      }
  );

export type JourneyAuthoringJsonValue =
  | string
  | number
  | boolean
  | null
  | readonly JourneyAuthoringJsonValue[]
  | { readonly [key: string]: JourneyAuthoringJsonValue };

/**
 * a node this registry version does not recognize (legacy/future) must open read-only with its original source kept
 * intact: never drop/normalize/overwrite, and publish fails closed (#328 §10)
 */
export interface AuthoringUnsupportedNodeV1 {
  readonly nodeId: string;
  readonly type: 'UNSUPPORTED';
  readonly sourceType: string;
  readonly source: JourneyAuthoringJsonValue;
}

export interface AuthoringEdgeV1 {
  /** id for authoring/collaboration only; does not compile into a runtime identity */
  readonly edgeId: string;
  readonly source: { readonly nodeId: string; readonly portId: JourneyPortId };
  readonly target: { readonly nodeId: string };
}

/** Journey-level values the runtime shares across all steps: the owner team is on the head, not in the document */
export interface AuthoringSettingsV1 {
  readonly name: string;
  readonly purpose: string;
  readonly senderIdentityId: string;
  readonly goal: { readonly kind: 'EVENT'; readonly eventType: string };
  readonly exitRules: ReadonlyArray<
    | { readonly kind: 'GOAL' }
    | { readonly kind: 'EVENT'; readonly eventType: string }
    | { readonly kind: 'HIGHER_PRIORITY_JOURNEY' }
  >;
  readonly maxDurationDays: number;
}

/** layout is visual-only: the compiler must not read it, and it does not affect the runtime hash */
export interface AuthoringLayoutV1 {
  readonly nodes: Readonly<Record<string, { readonly x: number; readonly y: number }>>;
  readonly viewport?: { readonly x: number; readonly y: number; readonly zoom: number };
}

export interface AuthoringDocumentV1 {
  readonly schemaVersion: JourneyAuthoringSchemaVersion;
  readonly registryVersion: JourneyAuthoringRegistryVersion;
  readonly trigger: AuthoringTriggerNodeV1;
  readonly nodes: ReadonlyArray<AuthoringStepNodeV1 | AuthoringUnsupportedNodeV1>;
  readonly edges: readonly AuthoringEdgeV1[];
  readonly settings: AuthoringSettingsV1;
  readonly layout: AuthoringLayoutV1;
}

// ── Compile artifact (Phase Spec §4 — fields exact) ──────────────────────────

/**
 * `TRuntime` is `JourneyDefinitionContent` of `apps/journey`: the contract does not duplicate the runtime type
 * `compileDigest` = SHA-256 of the canonical artifact excluding its own field
 */
export interface CompileArtifactV1<TRuntime = unknown> {
  readonly artifactVersion: typeof JOURNEY_COMPILE_ARTIFACT_VERSION;
  readonly schemaVersion: JourneyAuthoringSchemaVersion;
  readonly compilerVersion: string;
  readonly authoringRegistryVersion: JourneyAuthoringRegistryVersion;
  readonly tenantId: string;
  readonly journeyId: string;
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly baseHeadVersion: number;
  readonly referenceDigest: string;
  readonly capabilityDigest: string;
  readonly runtimeDefinition: TRuntime;
  readonly runtimeHash: string;
  readonly diagnosticDigest: string;
  readonly compileDigest: string;
}

export interface CompileJourneyResultV1<TRuntime = unknown> {
  readonly artifact: CompileArtifactV1<TRuntime> | null;
  readonly diagnostics: readonly JourneyDiagnosticV1[];
  /** a compile of an old revision that finished after the draft moved on: must not be used to open a publish (#329 §5) */
  readonly stale: boolean;
}

// ── Preview and simulation (#329 §6-§8) ─────────────────────────────────────

export interface PlanPreviewStepV1 {
  readonly nodeId: string;
  readonly type: JourneyStepNodeType;
  readonly next: ReadonlyArray<{ readonly portId: JourneyPortId; readonly nodeId: string }>;
  readonly capability: 'AVAILABLE' | 'RUNTIME_CAPABILITY_UNAVAILABLE';
}

export interface PlanPreviewV1 {
  readonly compileDigest: string;
  readonly entryNodeId: string;
  readonly steps: readonly PlanPreviewStepV1[];
  readonly diagnostics: readonly JourneyDiagnosticV1[];
}

/**
 * pre-declared synthetic fixtures: the results of SEND and owner actions come only from fixtures
 * values in the context are synthetic scalars; no raw customer context/PII
 */
export interface SimulationFixtureV1 {
  readonly fixtureId: string;
  readonly startAt: string;
  readonly seed: string;
  readonly context: Readonly<Record<string, string | number | boolean | null>>;
  readonly sendOutcomes?: Readonly<Record<string, 'SENT' | 'SUPPRESSED' | 'SCOPE_DENIED'>>;
  readonly ownerOutcomes?: Readonly<Record<string, 'ACCEPTED' | 'REJECTED'>>;
}

export interface SimulationTransitionV1 {
  readonly sequence: number;
  readonly nodeId: string;
  readonly portId: JourneyPortId | null;
  readonly virtualAt: string;
}

export interface SimulationResultV1 {
  readonly compileDigest: string;
  readonly fixtureId: string;
  readonly profile: 'SIMULATION_ONLY';
  readonly transitions: readonly SimulationTransitionV1[];
  readonly terminal: 'EXIT' | 'MAX_DURATION' | 'TRANSITION_LIMIT' | 'CAPABILITY_UNAVAILABLE';
  readonly diagnostics: readonly JourneyDiagnosticV1[];
}

// ── Lifecycle and state (Phase Contract §5, Phase Spec §2) ───────────────────

export const JOURNEY_LIFECYCLES = Object.freeze([
  'DRAFT_ONLY',
  'ACTIVE',
  'PAUSED',
  'DEPRECATED',
] as const);
export type JourneyLifecycle = (typeof JOURNEY_LIFECYCLES)[number];

/** PAUSED/DEPRECATED stop only new enrollments; a publish while PAUSED does not resume */
export const JOURNEY_LIFECYCLE_TRANSITIONS = Object.freeze({
  DRAFT_ONLY: ['ACTIVE'],
  ACTIVE: ['PAUSED', 'DEPRECATED'],
  PAUSED: ['ACTIVE', 'DEPRECATED'],
  DEPRECATED: [],
} as const satisfies Readonly<Record<JourneyLifecycle, readonly JourneyLifecycle[]>>);

export const JOURNEY_AUTHORING_RESOURCE_KINDS = Object.freeze(['JOURNEY', 'TEMPLATE'] as const);
export type JourneyAuthoringResourceKind = (typeof JOURNEY_AUTHORING_RESOURCE_KINDS)[number];

export const JOURNEY_AUTHORING_RECEIPT_STATES = Object.freeze([
  'PENDING',
  'COMMITTED',
  'FAILED',
] as const);
export type JourneyAuthoringReceiptState = (typeof JOURNEY_AUTHORING_RECEIPT_STATES)[number];

export const JOURNEY_REVIEW_STATES = Object.freeze([
  'IN_REVIEW',
  'APPROVED',
  'CHANGES_REQUESTED',
  'REJECTED',
  'SUPERSEDED',
] as const);
export type JourneyReviewState = (typeof JOURNEY_REVIEW_STATES)[number];

export const JOURNEY_REVIEW_DECISIONS = Object.freeze([
  'APPROVE',
  'REQUEST_CHANGES',
  'REJECT',
] as const);
export type JourneyReviewDecision = (typeof JOURNEY_REVIEW_DECISIONS)[number];

export const JOURNEY_AUTHORING_OUTBOX_STATES = Object.freeze([
  'PENDING',
  'PROCESSING',
  'SENT',
  'FAILED',
] as const);

/** a stage only moves forward; rollback is freezing/turning off the flag, not stepping back a stage (Phase Spec §9) */
export const JOURNEY_AUTHORING_ROLLOUT_STAGES = Object.freeze([
  'DISABLED',
  'INTERNAL_SYNTHETIC',
  'SELECTED_TENANT',
  'CONTROLLED_AUTHORING',
] as const);
export type JourneyAuthoringRolloutStage = (typeof JOURNEY_AUTHORING_ROLLOUT_STAGES)[number];

/** a publish that timed out: resolve only with the original key; never mint a new key or republish (#329 §10) */
export const JOURNEY_PUBLISH_OUTCOMES = Object.freeze([
  'UNKNOWN',
  'PUBLISHED',
  'NOT_COMMITTED',
  'CONFLICT',
] as const);
export type JourneyPublishOutcome = (typeof JOURNEY_PUBLISH_OUTCOMES)[number];

// ── Capability and scope (#331 §2, §4, §6) ───────────────────────────────────

export const JOURNEY_AUTHORING_CAPABILITIES = Object.freeze([
  'journey.read',
  'journey.edit',
  'journey.review',
  'journey.publish',
  'journey.lifecycle',
  'journey.transfer',
  'template.read',
  'template.edit',
  'template.review',
  'template.publish',
  'template.lifecycle',
  'template.visibility',
  'template.upgrade',
] as const);
export type JourneyAuthoringCapability = (typeof JOURNEY_AUTHORING_CAPABILITIES)[number];

/** delegation is limited to read/edit (including submit): no approve/publish/lifecycle/visibility/transfer/audit */
export const JOURNEY_DELEGABLE_CAPABILITIES = Object.freeze([
  'journey.read',
  'journey.edit',
  'template.read',
  'template.edit',
] as const satisfies readonly JourneyAuthoringCapability[]);

export const JOURNEY_DELEGATION_MAX_SECONDS = 8 * 60 * 60;

export const JOURNEY_AUTHORING_SCOPE_KINDS = Object.freeze([
  'TENANT',
  'TEAM',
  'JOURNEY',
  'TEMPLATE',
] as const);
export type JourneyAuthoringScopeKind = (typeof JOURNEY_AUTHORING_SCOPE_KINDS)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(JOURNEY_AUTHORING_CAPABILITIES);

export function isJourneyAuthoringCapability(value: unknown): value is JourneyAuthoringCapability {
  return typeof value === 'string' && CAPABILITY_SET.has(value);
}

// ── Commands and REST DTOs (Phase Contract §9, Phase Spec §5) ────────────────

export const JOURNEY_AUTHORING_COMMANDS = Object.freeze([
  'CreateJourneyDraft',
  'UpdateJourneyDraft',
  'DiscardJourneyDraft',
  'SubmitJourneyReview',
  'ApproveJourneyReview',
  'RejectJourneyReview',
  'RequestJourneyChanges',
  'PublishJourneyDraft',
  'PauseJourney',
  'ResumeJourney',
  'DeprecateJourney',
  'TransferJourneyOwnership',
  'CreateRollForwardFromVersion',
  'CloneJourneyFromVersion',
] as const);
export type JourneyAuthoringCommand = (typeof JOURNEY_AUTHORING_COMMANDS)[number];

export const JOURNEY_AUTHORING_QUERIES = Object.freeze([
  'GetJourneyAuthoringState',
  'ListVisibleJourneys',
  'ValidateJourneyDraft',
  'CompileJourneyDraft',
  'PreviewJourneyPlan',
  'SimulateJourneyScenario',
  'ResolvePublish',
  'ListJourneyAudit',
] as const);
export type JourneyAuthoringQuery = (typeof JOURNEY_AUTHORING_QUERIES)[number];

/** CAS of the whole draft (#331 §7): stale answers with the current revision/digest; no auto-merge */
export interface JourneyDraftCasV1 {
  readonly expectedHeadVersion: number;
  readonly expectedDraftRevision: number;
  readonly expectedDraftDigest: string;
}

export interface CreateJourneyDraftRequestV1 {
  readonly ownerTeamId: string;
  readonly document: AuthoringDocumentV1;
}

export interface UpdateJourneyDraftRequestV1 extends JourneyDraftCasV1 {
  readonly document: AuthoringDocumentV1;
}

export interface DiscardJourneyDraftRequestV1 extends JourneyDraftCasV1 {
  readonly reasonCode: string;
}

export interface DraftBindingRequestV1 {
  readonly draftRevision: number;
  readonly draftDigest: string;
}

export type ValidateJourneyDraftRequestV1 = DraftBindingRequestV1;

export interface CompileJourneyDraftRequestV1 extends DraftBindingRequestV1 {
  readonly expectedHeadVersion: number;
}

export interface PreviewJourneyPlanRequestV1 {
  readonly compileDigest: string;
}

export interface SimulateJourneyScenarioRequestV1 {
  readonly compileDigest: string;
  readonly fixture: SimulationFixtureV1;
}

/** a review candidate pins every digest; anything that changes after submit makes the candidate SUPERSEDED */
export interface ReviewBindingV1 {
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly compileDigest: string;
  readonly referenceDigest: string;
  readonly capabilityDigest: string;
  readonly baseHeadVersion: number;
  readonly baseHeadDigest: string | null;
}

export type SubmitJourneyReviewRequestV1 = ReviewBindingV1;

export interface ReviewDecisionRequestV1 {
  readonly expectedReviewState: 'IN_REVIEW';
  readonly decision: JourneyReviewDecision;
  readonly reasonCode: string;
  readonly evidenceRef: string;
}

export interface PublishJourneyDraftRequestV1 extends ReviewBindingV1 {
  readonly reviewId: string;
  readonly expectedHeadVersion: number;
}

export interface ResolvePublishRequestV1 {
  /** the original key of a publish with unknown result: never create a new key */
  readonly originalIdempotencyKey: string;
}

export interface JourneyLifecycleRequestV1 {
  readonly expectedHeadVersion: number;
  readonly reasonCode: string;
}

export interface TransferJourneyOwnershipRequestV1 extends JourneyLifecycleRequestV1 {
  readonly targetTeamId: string;
}

export interface CreateRollForwardRequestV1 {
  readonly sourceVersion: number;
  readonly expectedHeadVersion: number;
}

export interface CloneJourneyRequestV1 {
  readonly targetOwnerTeamId: string;
  readonly name: string;
}

export interface JourneyHeadViewV1 {
  readonly journeyId: string;
  readonly name: string;
  readonly ownerTeamId: string;
  readonly lifecycle: JourneyLifecycle;
  readonly version: number;
  readonly currentDraftRevision: number;
  readonly currentDraftDigest: string;
  readonly activeVersion: number | null;
  readonly activeRuntimeHash: string | null;
}

export interface JourneyAuthoringStateV1 {
  readonly head: JourneyHeadViewV1;
  readonly draft: {
    readonly revision: number;
    readonly digest: string;
    readonly basePublishedVersion: number | null;
    readonly document: AuthoringDocumentV1;
  };
  readonly review: {
    readonly reviewId: string;
    readonly state: JourneyReviewState;
    readonly draftRevision: number;
    /** U1.3 (#431): the candidate that was submitted for review: the reviewer can check the exact candidate without guessing */
    readonly draftDigest: string;
    readonly compileDigest: string;
    readonly submittedAt: string;
    /** the caller is the submitter = cannot decide it themselves, another reviewer is needed (maker-checker) */
    readonly makerIsCaller: boolean;
  } | null;
  /**
   * U1.3 (#431): capabilities the caller holds on this Journey at read time: used only to show affordances
   * the server re-checks permission on every mutation
   */
  readonly permissions: {
    readonly edit: boolean;
    readonly review: boolean;
    readonly publish: boolean;
  };
}

/** U1.3 (#431): reviews the caller can decide: excludes candidates the caller submitted */
export interface JourneyPendingReviewV1 {
  readonly reviewId: string;
  readonly journeyId: string;
  readonly journeyName: string;
  readonly ownerTeamId: string;
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly compileDigest: string;
  readonly submittedAt: string;
}

/** the receipt keeps only safe metadata: no document/graph/parameter value */
export interface JourneyCommandReceiptV1 {
  readonly receiptId: string;
  /** name from `JOURNEY_AUTHORING_COMMANDS` or `JOURNEY_TEMPLATE_COMMANDS` */
  readonly commandName: string;
  readonly resourceKind: JourneyAuthoringResourceKind;
  readonly resourceId: string;
  readonly state: JourneyAuthoringReceiptState;
  readonly correlationId: string;
}

export interface PublishJourneyResultV1 {
  readonly outcome: JourneyPublishOutcome;
  readonly journeyId: string;
  readonly version: number | null;
  readonly runtimeHash: string | null;
  readonly receiptId: string;
}
