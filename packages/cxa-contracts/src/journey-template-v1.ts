/**
 * J5.1 (#339): versioned template contract of Journey (decision #330, Phase Spec #337 §7)
 *
 * A template is an immutable authoring package, not a runtime pointer/subflow: it must be instantiated into a
 * tenant's Journey draft before validate/compile/publish, and has no live link back to the source
 *
 * Prohibitions:
 * - there are only the owner classes `PLATFORM_BUILTIN` and `TENANT`; no marketplace/cross-tenant sharing
 * - a built-in has no nullable/sentinel tenant row: it is resolved from a release asset whose digest is in the allowlist
 * - parameters are a closed set: no SECRET/CREDENTIAL/arbitrary JSON/raw HTML/script
 * - a bind target is a JSON pointer to a scalar slot that the registry allows only; it cannot change a node/edge/operator
 * - parameter values do not enter audit/outbox/evidence; only the digest may be kept
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

/** DEPRECATED must not be instantiated/forked anew; existing versions can still resolve provenance/diff */
export const JOURNEY_TEMPLATE_LIFECYCLES = Object.freeze([
  'DRAFT_ONLY',
  'ACTIVE',
  'DEPRECATED',
  'ARCHIVED',
] as const);
export type JourneyTemplateLifecycle = (typeof JOURNEY_TEMPLATE_LIFECYCLES)[number];

/** Restore goes from ARCHIVED to DEPRECATED only, never straight back to ACTIVE */
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

/** only references that exist in the runtime contract: tenant/scope is re-checked on every instantiate/publish */
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
 * reserved bind-target keys besides the step's `templateNodeKey`: `@trigger` points to the trigger config
 * (e.g. `/config/segmentId`) and `@settings` points to Journey-level values (e.g. `/config/senderIdentityId`)
 * because every tenant-specific reference must come through a parameter and must not be embedded in the graph (#330 §4)
 */
export const JOURNEY_TEMPLATE_RESERVED_NODE_KEYS = Object.freeze([
  '@trigger',
  '@settings',
] as const);

/** points to a scalar field of the node with this `templateNodeKey`, e.g. `/config/waitSeconds` */
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
 * a default is allowed only for kinds that are not resource references: a built-in must not have a reference default, and
 * a tenant template must not keep a resolved reference as a default (#330 §5)
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

// ── Template content and identity (#330 §3) ──────────────────────────────────

/** identity referenced across systems: `(origin, templateId, version, contentDigest)`; the tenant comes from the context */
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
  /** graph skeleton: every node must have a `templateNodeKey`, and references must come only through parameters */
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

/** explains the origin and is the basis of an upgrade only; not a runtime dependency */
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

/** a blocking conflict that cannot be resolved by choosing: bind/fix the source first */
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

// ── Commands and REST DTOs (Phase Spec §5) ───────────────────────────────────

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
  /** the target version the proposal was computed from: the server recomputes and must get the same digest */
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

/** the notification is data only (#330 §9): no auto-apply, no publish and no touching enrollments */
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

/** a bind target can point only at `/config/<scalar field>`: it must not touch nodeId/type/edge or replace a whole object */
export function isJourneyTemplateBindPointer(pointer: string): boolean {
  return /^\/config\/[A-Za-z][A-Za-z0-9]*$/.test(pointer);
}
