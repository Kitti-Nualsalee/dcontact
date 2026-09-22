/**
 * J5.1 (#339): versioned template contract ของ Journey (คำตัดสิน #330, Phase Spec #337 §7)
 *
 * template เป็น immutable authoring package ไม่ใช่ runtime pointer/subflow — ต้อง instantiate เป็น
 * Journey draft ของ tenant ก่อน validate/compile/publish และไม่มี live link กลับไปที่ source
 *
 * ข้อห้าม:
 * - owner class มีแค่ `PLATFORM_BUILTIN` และ `TENANT`; ไม่มี marketplace/cross-tenant sharing
 * - built-in ไม่มี tenant row แบบ nullable/sentinel — resolve จาก release asset ที่ digest อยู่ใน allowlist
 * - parameter เป็นชุดปิด ไม่มี SECRET/CREDENTIAL/arbitrary JSON/raw HTML/script
 * - bind target เป็น JSON pointer ไปยัง scalar slot ที่ registry อนุญาตเท่านั้น เปลี่ยน node/edge/operator ไม่ได้
 * - ค่า parameter ไม่เข้า audit/outbox/evidence เก็บได้เพียง digest
 */
import type {
  AuthoringDocumentV1,
  JourneyAuthoringRegistryVersion,
  JourneyAuthoringSchemaVersion,
} from './journey-authoring-v1.js';

export const JOURNEY_TEMPLATE_SCHEMA_VERSION = 'J5_TEMPLATE_V1' as const;

export const JOURNEY_TEMPLATE_ORIGINS = Object.freeze(['TENANT', 'PLATFORM_BUILTIN'] as const);
export type JourneyTemplateOrigin = (typeof JOURNEY_TEMPLATE_ORIGINS)[number];

export const JOURNEY_TEMPLATE_VISIBILITIES = Object.freeze(['TEAM', 'TENANT'] as const);
export type JourneyTemplateVisibility = (typeof JOURNEY_TEMPLATE_VISIBILITIES)[number];

/** DEPRECATED ห้าม instantiate/fork ใหม่; version เดิมยัง resolve provenance/diff ได้ */
export const JOURNEY_TEMPLATE_LIFECYCLES = Object.freeze([
  'DRAFT_ONLY',
  'ACTIVE',
  'DEPRECATED',
  'ARCHIVED',
] as const);
export type JourneyTemplateLifecycle = (typeof JOURNEY_TEMPLATE_LIFECYCLES)[number];

/** Restore คืนจาก ARCHIVED เป็น DEPRECATED เท่านั้น ไม่กลับเป็น ACTIVE โดยตรง */
export const JOURNEY_TEMPLATE_LIFECYCLE_TRANSITIONS = Object.freeze({
  DRAFT_ONLY: ['ACTIVE'],
  ACTIVE: ['DEPRECATED'],
  DEPRECATED: ['ARCHIVED'],
  ARCHIVED: ['DEPRECATED'],
} as const satisfies Readonly<
  Record<JourneyTemplateLifecycle, readonly JourneyTemplateLifecycle[]>
>);

export const JOURNEY_TEMPLATE_UPGRADE_STATES = Object.freeze([
  'PROPOSED',
  'APPLIED',
  'STALE',
] as const);
export type JourneyTemplateUpgradeState = (typeof JOURNEY_TEMPLATE_UPGRADE_STATES)[number];

// ── Parameter schema (#330 §5) ───────────────────────────────────────────────

export const JOURNEY_TEMPLATE_PARAMETER_TYPES = Object.freeze([
  'BOOLEAN',
  'INTEGER',
  'DURATION_SECONDS',
  'ENUM',
  'CANONICAL_EVENT_TYPE',
  'TIMEZONE',
  'CRON',
  'OPAQUE_RESOURCE_REF',
  'SAFE_LITERAL',
] as const);
export type JourneyTemplateParameterType = (typeof JOURNEY_TEMPLATE_PARAMETER_TYPES)[number];

/** reference ที่ runtime contract มีอยู่จริงเท่านั้น — ตรวจ tenant/scope ใหม่ทุกครั้งที่ instantiate/publish */
export const JOURNEY_TEMPLATE_RESOURCE_KINDS = Object.freeze([
  'OWNER_TEAM',
  'TARGET_TEAM',
  'SEGMENT',
  'CONTENT',
  'SENDER_IDENTITY',
  'CASE_TYPE',
  'ROUTING_INTENT',
  'CAMPAIGN',
  'QUEUE',
  'AGENT',
] as const);
export type JourneyTemplateResourceKind = (typeof JOURNEY_TEMPLATE_RESOURCE_KINDS)[number];

/**
 * key สงวนของ bind target นอกเหนือจาก `templateNodeKey` ของ step: `@trigger` ชี้ config ของ trigger
 * (เช่น `/config/segmentId`) และ `@settings` ชี้ค่าระดับ Journey (เช่น `/config/senderIdentityId`)
 * เพราะ reference เฉพาะ tenant ทุกตัวต้องมาทาง parameter ห้ามฝังใน graph (#330 §4)
 */
export const JOURNEY_TEMPLATE_RESERVED_NODE_KEYS = Object.freeze([
  '@trigger',
  '@settings',
] as const);

/** ชี้ไปยัง scalar field ของ node ที่มี `templateNodeKey` นี้ เช่น `/config/waitSeconds` */
export interface JourneyTemplateBindTargetV1 {
  readonly templateNodeKey: string;
  readonly pointer: string;
}

interface TemplateParameterBase {
  readonly parameterKey: string;
  readonly labelKey: string;
  readonly descriptionKey?: string;
  readonly required: boolean;
  readonly bindTargets: readonly JourneyTemplateBindTargetV1[];
}

/**
 * default มีได้เฉพาะชนิดที่ไม่ใช่ resource reference — built-in ห้ามมี default ของ reference และ
 * tenant template ก็ห้ามเก็บ reference ที่ resolve แล้วเป็น default (#330 §5)
 */
export type JourneyTemplateParameterV1 = TemplateParameterBase &
  (
    | { readonly type: 'BOOLEAN'; readonly default?: boolean }
    | {
        readonly type: 'INTEGER' | 'DURATION_SECONDS';
        readonly min: number;
        readonly max: number;
        readonly default?: number;
      }
    | { readonly type: 'ENUM'; readonly values: readonly string[]; readonly default?: string }
    | { readonly type: 'CANONICAL_EVENT_TYPE' | 'TIMEZONE' | 'CRON'; readonly default?: string }
    | { readonly type: 'OPAQUE_RESOURCE_REF'; readonly resourceKind: JourneyTemplateResourceKind }
    | {
        readonly type: 'SAFE_LITERAL';
        readonly maxLength: number;
        readonly pattern?: string;
        readonly default?: string;
      }
  );

export type JourneyTemplateParameterValue = string | number | boolean;

// ── Template content และ identity (#330 §3) ──────────────────────────────────

/** identity ที่อ้างข้ามระบบ: `(origin, templateId, version, contentDigest)` — tenant มาจาก context */
export interface JourneyTemplateRefV1 {
  readonly origin: JourneyTemplateOrigin;
  readonly templateId: string;
  readonly version: number;
  readonly contentDigest: string;
}

export interface JourneyTemplateContentV1 {
  readonly templateSchemaVersion: typeof JOURNEY_TEMPLATE_SCHEMA_VERSION;
  readonly authoringSchemaVersion: JourneyAuthoringSchemaVersion;
  readonly registryVersion: JourneyAuthoringRegistryVersion;
  /** graph skeleton — ทุก node ต้องมี `templateNodeKey` และ reference ต้องมาทาง parameter เท่านั้น */
  readonly document: AuthoringDocumentV1;
  readonly parameterSchema: readonly JourneyTemplateParameterV1[];
  readonly requiredCapabilities: readonly string[];
}

export interface JourneyTemplateVersionViewV1 extends JourneyTemplateRefV1 {
  readonly name: string;
  readonly visibility: JourneyTemplateVisibility;
  readonly ownerTeamId: string | null;
  readonly lifecycle: JourneyTemplateLifecycle;
  readonly content: JourneyTemplateContentV1;
  readonly compileDigest: string;
  readonly nodeMappingDigest: string;
  readonly publishedAt: string;
}

// ── Provenance (#330 §7) ─────────────────────────────────────────────────────

/** อธิบายที่มาและเป็นฐานของ upgrade เท่านั้น ไม่ใช่ runtime dependency */
export interface JourneyTemplateProvenanceV1 {
  readonly source: JourneyTemplateRefV1;
  readonly journeyId: string;
  readonly draftRevision: number;
  readonly bindingDigest: string;
  readonly nodeMapping: Readonly<Record<string, string>>;
  readonly nodeMappingDigest: string;
}

// ── Three-way upgrade (#330 §10, Phase Spec §7) ──────────────────────────────

export const JOURNEY_TEMPLATE_CONFLICT_KINDS = Object.freeze([
  'FIELD_CHANGED_BOTH',
  'EDGE_CHANGED_BOTH',
  'NODE_REMOVED_BUT_EDITED',
  'PARAMETER_BREAKING',
  'PARAMETER_REQUIRED_UNBOUND',
  'UNKNOWN_NODE_OR_CAPABILITY',
] as const);
export type JourneyTemplateConflictKind = (typeof JOURNEY_TEMPLATE_CONFLICT_KINDS)[number];

/** conflict ที่ block แก้ด้วยการเลือกไม่ได้ ต้อง bind/แก้ต้นทางก่อน */
export const JOURNEY_TEMPLATE_BLOCKING_CONFLICT_KINDS = Object.freeze([
  'PARAMETER_REQUIRED_UNBOUND',
  'UNKNOWN_NODE_OR_CAPABILITY',
] as const satisfies readonly JourneyTemplateConflictKind[]);

export interface JourneyTemplateConflictV1 {
  readonly conflictId: string;
  readonly kind: JourneyTemplateConflictKind;
  readonly templateNodeKey?: string;
  readonly nodeId?: string;
  readonly field?: string;
  readonly parameterKey?: string;
}

export type JourneyTemplateConflictResolution = 'KEEP_LOCAL' | 'TAKE_TEMPLATE';

export interface JourneyTemplateUpgradeProposalV1 {
  readonly journeyId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly baseDraftDigest: string;
  readonly localDraftDigest: string;
  readonly proposedDocument: AuthoringDocumentV1;
  readonly nodeMapping: Readonly<Record<string, string>>;
  readonly conflicts: readonly JourneyTemplateConflictV1[];
  readonly visualOnly: boolean;
  readonly proposalDigest: string;
  readonly conflictDigest: string;
}

// ── Commands และ REST DTOs (Phase Spec §5) ───────────────────────────────────

export const JOURNEY_TEMPLATE_COMMANDS = Object.freeze([
  'CreateTemplateDraft',
  'UpdateTemplateDraft',
  'DiscardTemplateDraft',
  'SubmitTemplateReview',
  'ApproveTemplateReview',
  'PublishTemplateVersion',
  'ChangeTemplateVisibility',
  'DeprecateTemplate',
  'ArchiveTemplate',
  'RestoreTemplate',
  'InstantiateTemplate',
  'ForkTemplate',
  'ApplyTemplateUpgrade',
] as const);
export type JourneyTemplateCommand = (typeof JOURNEY_TEMPLATE_COMMANDS)[number];

export const JOURNEY_TEMPLATE_QUERIES = Object.freeze([
  'ListVisibleTemplates',
  'GetTemplateVersion',
  'CheckTemplateUpgrade',
] as const);

export interface CreateTemplateDraftRequestV1 {
  readonly ownerTeamId: string;
  readonly visibility: JourneyTemplateVisibility;
  readonly name: string;
  readonly document: AuthoringDocumentV1;
  readonly parameterSchema: readonly JourneyTemplateParameterV1[];
}

export interface UpdateTemplateDraftRequestV1 {
  readonly expectedHeadVersion: number;
  readonly expectedDraftRevision: number;
  readonly expectedDraftDigest: string;
  readonly document: AuthoringDocumentV1;
  readonly parameterSchema: readonly JourneyTemplateParameterV1[];
}

export interface ChangeTemplateVisibilityRequestV1 {
  readonly expectedHeadVersion: number;
  readonly visibility: JourneyTemplateVisibility;
  readonly reasonCode: string;
}

export interface InstantiateTemplateRequestV1 {
  readonly expectedContentDigest: string;
  readonly bindings: Readonly<Record<string, JourneyTemplateParameterValue>>;
  readonly targetOwnerTeamId: string;
  readonly name: string;
}

export interface ForkTemplateRequestV1 {
  readonly expectedContentDigest: string;
  readonly targetOwnerTeamId: string;
  readonly name: string;
  readonly visibility: JourneyTemplateVisibility;
}

export interface CheckTemplateUpgradeRequestV1 {
  readonly draftRevision: number;
  readonly draftDigest: string;
  readonly targetVersion: number;
}

export interface ApplyTemplateUpgradeRequestV1 {
  /** version เป้าหมายที่ proposal ถูกคำนวณจาก — server คำนวณซ้ำแล้วต้องได้ digest เดิม */
  readonly targetVersion: number;
  readonly expectedHeadVersion: number;
  readonly expectedDraftRevision: number;
  readonly expectedDraftDigest: string;
  readonly proposalDigest: string;
  readonly conflictDigest: string;
  readonly resolutions: Readonly<Record<string, JourneyTemplateConflictResolution>>;
}

const PARAMETER_TYPE_SET: ReadonlySet<string> = new Set(JOURNEY_TEMPLATE_PARAMETER_TYPES);
const RESOURCE_KIND_SET: ReadonlySet<string> = new Set(JOURNEY_TEMPLATE_RESOURCE_KINDS);

export function isJourneyTemplateParameterType(
  value: unknown,
): value is JourneyTemplateParameterType {
  return typeof value === 'string' && PARAMETER_TYPE_SET.has(value);
}

/** การแจ้งเตือนเป็นข้อมูลเท่านั้น (#330 §9) — ไม่ auto-apply, ไม่ publish และไม่แตะ enrollment */
export const JOURNEY_TEMPLATE_NOTICE_KINDS = Object.freeze([
  'UPDATE_AVAILABLE',
  'DEPRECATED',
] as const);
export type JourneyTemplateNoticeKind = (typeof JOURNEY_TEMPLATE_NOTICE_KINDS)[number];

export interface JourneyTemplateNoticeV1 {
  readonly kind: JourneyTemplateNoticeKind;
  readonly journeyId: string;
  readonly source: JourneyTemplateRefV1;
  readonly latestVersion: number;
}

export function isJourneyTemplateResourceKind(
  value: unknown,
): value is JourneyTemplateResourceKind {
  return typeof value === 'string' && RESOURCE_KIND_SET.has(value);
}

/** bind target ชี้ได้แค่ `/config/<scalar field>` — ห้ามแตะ nodeId/type/edge หรือแทนทั้ง object */
export function isJourneyTemplateBindPointer(pointer: string): boolean {
  return /^\/config\/[A-Za-z][A-Za-z0-9]*$/.test(pointer);
}
