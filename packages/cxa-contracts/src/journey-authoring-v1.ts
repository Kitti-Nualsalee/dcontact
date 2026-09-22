/**
 * J5.1 (#339): versioned authoring contract ของ Journey visual canvas (Phase Contract #334,
 * Phase Spec #337 §1, §4–§6)
 *
 * canvas เป็น authoring projection ไม่ใช่ runtime DSL ใหม่ — compile แล้วต้องลงท้ายที่
 * `JourneyDefinitionContent` เดิมของ `apps/journey` เท่านั้น ไฟล์นี้จึงไม่นิยาม runtime type ซ้ำ:
 * `CompileArtifactV1` รับ runtime type เป็น generic ให้ owner ฝั่ง Journey ผูกเอง
 *
 * ข้อห้ามที่ตรึงไว้ (#328–#331):
 * - node/port/trigger เป็นชุดปิด ห้าม plugin หรือ UI สร้างเพิ่ม
 * - `step.id = nodeId` แบบ 1:1 เพื่อรักษา `actionKey = enrollmentId:journeyVersion:stepId`
 * - เงื่อนไขใช้ `DC_EXPR:1` เท่านั้น ไม่มี JavaScript/eval/DSL ใหม่
 * - layout/viewport ไม่อยู่ใน runtime hash และ document/DTO ไม่มี PII หรือ credential
 * - tenant ไม่มาจาก client: request DTO ทุกตัวไม่มี `tenantId`
 */
import type { ContactChannel } from './contact-governance.js';
import type { ExpressionDocument } from './expression.js';
import type { JourneyDiagnosticV1 } from './journey-authoring-errors-v1.js';

export const JOURNEY_AUTHORING_SCHEMA_VERSION = 'J5_AUTHORING_V1' as const;
export const JOURNEY_AUTHORING_REGISTRY_VERSION = 'J5_PALETTE_V1' as const;
export const JOURNEY_COMPILE_ARTIFACT_VERSION = 1 as const;

export type JourneyAuthoringSchemaVersion = typeof JOURNEY_AUTHORING_SCHEMA_VERSION;
export type JourneyAuthoringRegistryVersion = typeof JOURNEY_AUTHORING_REGISTRY_VERSION;

/** ขีดจำกัดของ V1 (#329): ไม่มี loop/iteration contract จึงปฏิเสธ cycle และกราฟที่ใหญ่เกิน */
export const JOURNEY_AUTHORING_LIMITS = Object.freeze({
  runtimeSteps: 256,
  controlEdges: 512,
  compiledRuntimeBytes: 256 * 1024,
  simulationTransitions: 1_024,
} as const);

// ── Node และ port catalog (#328) ─────────────────────────────────────────────

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

/** J2 owner action: วางได้เฉพาะ entry step หลัง INTERACTION_OUTCOME_TRIGGER (#328 §4) */
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
 * port ของแต่ละ node พร้อม runtime field ที่ output port compile ลงไป — output หนึ่ง port ต่อ
 * target เดียวเพราะ runtime field เป็น scalar; restricted action ใช้ `next`/`onReject`
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
  /** key คงที่จาก template สำหรับ provenance/upgrade — ไม่ใช่ runtime identity */
  readonly templateNodeKey?: string;
}

/** field ของ step คือ runtime field ที่ไม่ใช่ transition — transition มาจาก edge เท่านั้น */
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
 * node ที่ registry รุ่นนี้ไม่รู้จัก (legacy/future) ต้องเปิดแบบ read-only และเก็บ source เดิมไว้
 * ครบ — ห้าม drop/normalize/บันทึกทับ และ publish fail closed (#328 §10)
 */
export interface AuthoringUnsupportedNodeV1 {
  readonly nodeId: string;
  readonly type: 'UNSUPPORTED';
  readonly sourceType: string;
  readonly source: JourneyAuthoringJsonValue;
}

export interface AuthoringEdgeV1 {
  /** id สำหรับ authoring/collaboration เท่านั้น ไม่ compile เป็น runtime identity */
  readonly edgeId: string;
  readonly source: { readonly nodeId: string; readonly portId: JourneyPortId };
  readonly target: { readonly nodeId: string };
}

/** ค่าระดับ Journey ที่ runtime ใช้ร่วมทุก step — owner team อยู่ที่ head ไม่ใช่ใน document */
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

/** layout เป็น visual-only: compiler ห้ามอ่าน และไม่มีผลต่อ runtime hash */
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
 * `TRuntime` คือ `JourneyDefinitionContent` ของ `apps/journey` — contract ไม่ duplicate runtime type
 * `compileDigest` = SHA-256 ของ canonical artifact โดยเว้น field ตัวเอง
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
  /** compile ของ revision เก่าที่เสร็จหลัง draft ขยับแล้ว — ห้ามนำไปเปิด publish (#329 §5) */
  readonly stale: boolean;
}

// ── Preview และ simulation (#329 §6–§8) ─────────────────────────────────────

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
 * fixture สังเคราะห์ที่ประกาศล่วงหน้า — ผลของ SEND และ owner action มาจาก fixture เท่านั้น
 * ค่าใน context เป็น scalar สังเคราะห์ ห้าม raw customer context/PII
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

// ── Lifecycle และ state (Phase Contract §5, Phase Spec §2) ───────────────────

export const JOURNEY_LIFECYCLES = Object.freeze([
  'DRAFT_ONLY',
  'ACTIVE',
  'PAUSED',
  'DEPRECATED',
] as const);
export type JourneyLifecycle = (typeof JOURNEY_LIFECYCLES)[number];

/** PAUSED/DEPRECATED หยุด enrollment ใหม่เท่านั้น; publish ขณะ PAUSED ไม่ resume */
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

/** stage เดินหน้าอย่างเดียว; rollback คือ freeze/ปิด flag ไม่ใช่ถอย stage (Phase Spec §9) */
export const JOURNEY_AUTHORING_ROLLOUT_STAGES = Object.freeze([
  'DISABLED',
  'INTERNAL_SYNTHETIC',
  'SELECTED_TENANT',
  'CONTROLLED_AUTHORING',
] as const);
export type JourneyAuthoringRolloutStage = (typeof JOURNEY_AUTHORING_ROLLOUT_STAGES)[number];

/** publish ที่ timeout: resolve ด้วย key เดิมเท่านั้น ห้าม mint key ใหม่หรือ republish (#329 §10) */
export const JOURNEY_PUBLISH_OUTCOMES = Object.freeze([
  'UNKNOWN',
  'PUBLISHED',
  'NOT_COMMITTED',
  'CONFLICT',
] as const);
export type JourneyPublishOutcome = (typeof JOURNEY_PUBLISH_OUTCOMES)[number];

// ── Capability และ scope (#331 §2, §4, §6) ───────────────────────────────────

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

/** delegation จำกัด read/edit(รวม submit) — ห้าม approve/publish/lifecycle/visibility/transfer/audit */
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

// ── Commands และ REST DTOs (Phase Contract §9, Phase Spec §5) ────────────────

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

/** CAS ของ draft ทั้งฉบับ (#331 §7): stale ตอบ revision/digest ปัจจุบัน ไม่มี auto-merge */
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

/** review candidate pin ทุก digest; อะไรเปลี่ยนหลัง submit ทำให้ candidate SUPERSEDED */
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
  /** key เดิมของ publish ที่ไม่รู้ผล — ห้ามสร้าง key ใหม่ */
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
  } | null;
}

/** receipt เก็บเฉพาะ metadata ที่ปลอดภัย — ไม่มี document/graph/parameter value */
export interface JourneyCommandReceiptV1 {
  readonly receiptId: string;
  /** ชื่อจาก `JOURNEY_AUTHORING_COMMANDS` หรือ `JOURNEY_TEMPLATE_COMMANDS` */
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
