/**
 * CG4 wire/domain primitives แบบ additive โดย Contact Governance เป็น authority เดียว
 * ที่ resolve rule metadata, authorization context, approval และ effective state ได้
 */
import { createHash } from 'node:crypto';
import type {
  ContactExceptionRevisionId,
  ContactExceptionSeriesId,
  ContactId,
  ContactMutationId,
  ContactPolicyId,
  ContactPolicyVersionId,
  IdentityId,
} from './identifiers.js';
import type { ContactChannel, ContactDecision } from './contact-governance.js';

export const CG4_CONTRACT_VERSION = 1 as const;
export const CG4_POLICY_SCHEMA_VERSION = 1 as const;
export const CG4_RULE_REGISTRY_VERSION = 'CG4_RULE_REGISTRY_V1' as const;
export const CG4_EVALUATOR_VERSION = 'CG4_EVALUATOR_V1' as const;

export type Cg4ContractVersion = typeof CG4_CONTRACT_VERSION;
export type Cg4PolicySchemaVersion = typeof CG4_POLICY_SCHEMA_VERSION;
export type Cg4RuleRegistryVersion = typeof CG4_RULE_REGISTRY_VERSION;
export type Cg4EvaluatorVersion = typeof CG4_EVALUATOR_VERSION;
export type Cg4Digest = string;

export type Cg4RuleClass =
  'NON_OVERRIDABLE' | 'CUSTOMER_REQUEST_SCOPED' | 'APPROVAL_REQUIRED_OPERATIONAL';
export type Cg4OverrideMechanism = 'CUSTOMER_CALLBACK' | 'APPROVED_EXCEPTION';
export type Cg4IdentityScopeKind = 'EXACT_IDENTITY' | 'CONTACT_WIDE';
export type Cg4ExceptionRiskTier = 'STANDARD' | 'HIGH' | 'EMERGENCY';

export interface Cg4RuleMetadata {
  readonly ruleCode: string;
  readonly ruleClass: Cg4RuleClass;
  readonly overridable: boolean;
  readonly allowedOverrideMechanisms: readonly Cg4OverrideMechanism[];
  readonly supportedExceptionScopes: readonly Cg4IdentityScopeKind[];
  readonly riskFloor: Cg4ExceptionRiskTier | null;
  readonly platformLifetimeCapSeconds: Readonly<Record<Cg4ExceptionRiskTier, number>>;
  readonly registryVersion: Cg4RuleRegistryVersion;
}

export type Cg4ExceptionIdentityScope =
  { kind: 'EXACT_IDENTITY'; identityId: IdentityId } | { kind: 'CONTACT_WIDE' };

export type Cg4SourceType =
  'JOURNEY' | 'CAMPAIGN' | 'DIALER' | 'CHANNEL' | 'SURVEY' | 'AGENT' | 'EXTERNAL';

export interface Cg4ExceptionScope {
  contactId: ContactId;
  identity: Cg4ExceptionIdentityScope;
  channel: ContactChannel;
  purpose: string;
  sourceType: Cg4SourceType;
  sourceId: string;
}

export interface Cg4PolicyBinding {
  policyId: ContactPolicyId;
  policyVersionId: ContactPolicyVersionId;
  policyVersion: number;
  policyContentDigest: Cg4Digest;
  policySchemaVersion: Cg4PolicySchemaVersion;
  ruleRegistryVersion: Cg4RuleRegistryVersion;
  evaluatorVersion: Cg4EvaluatorVersion;
}

export type Cg4ExceptionWorkflowState =
  'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED' | 'REVOKED';
export type Cg4ExceptionEffectiveState = 'SCHEDULED' | 'ACTIVE' | 'EXPIRED' | 'INACTIVE';
export type Cg4ApprovalDecision = 'APPROVE' | 'REJECT';

/** Command context ตั้งใจไม่รับ tenant, actor, role และ overridability authority จาก caller */
export interface Cg4CommandBaseV1 {
  contractVersion: Cg4ContractVersion;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface Cg4ExceptionRequestCommandV1 extends Cg4CommandBaseV1 {
  scope: Cg4ExceptionScope;
  allowedRuleCodes: readonly string[];
  policy: Cg4PolicyBinding;
  startsAt: string;
  expiresAt: string;
  reasonCode: string;
  ticketRef: string;
  evidenceRef: string;
  renewsExceptionId?: ContactExceptionSeriesId;
}

export interface Cg4ExceptionApprovalCommandV1 extends Cg4CommandBaseV1 {
  seriesId: ContactExceptionSeriesId;
  revisionId: ContactExceptionRevisionId;
  expectedContentDigest: Cg4Digest;
  decision: Cg4ApprovalDecision;
  evidenceRef: string;
}

export interface Cg4ExceptionTransitionCommandV1 extends Cg4CommandBaseV1 {
  seriesId: ContactExceptionSeriesId;
  revisionId: ContactExceptionRevisionId;
  expectedContentDigest: Cg4Digest;
  action: 'CANCEL' | 'REVOKE';
  reasonCode: string;
  evidenceRef: string;
}

export interface Cg4QuorumSnapshot {
  required: number;
  current: number;
  authorizationEpoch: number;
  approvalDigest: Cg4Digest;
}

export interface Cg4ExceptionMutationResultV1 {
  contractVersion: Cg4ContractVersion;
  mutationId: ContactMutationId;
  seriesId: ContactExceptionSeriesId;
  revisionId: ContactExceptionRevisionId;
  version: number;
  workflowState: Cg4ExceptionWorkflowState;
  effectiveState: Cg4ExceptionEffectiveState;
  riskTier: Cg4ExceptionRiskTier;
  contentDigest: Cg4Digest;
  quorum: Cg4QuorumSnapshot;
  etag: string;
}

export type Cg4PolicyLifecycleState =
  | 'DRAFT'
  | 'IN_REVIEW'
  | 'APPROVED'
  | 'SCHEDULED'
  | 'ACTIVE'
  | 'SUPERSEDED'
  | 'REJECTED'
  | 'WITHDRAWN';
export type Cg4PolicyDiffClass = 'TIGHTENING' | 'NEUTRAL' | 'RELAXATION';

export interface Cg4PolicyScope {
  scopeKey: string;
  channel?: ContactChannel;
  purpose?: string;
  contactKind?: string;
  sourceType?: Cg4SourceType;
}

export interface Cg4PolicyCandidateV1 {
  contractVersion: Cg4ContractVersion;
  schemaVersion: Cg4PolicySchemaVersion;
  policyId: ContactPolicyId;
  policyVersionId: ContactPolicyVersionId;
  version: number;
  draftRevision: number;
  scope: Cg4PolicyScope;
  allowedOperationalRuleCodes: readonly string[];
  evaluatorVersion: Cg4EvaluatorVersion;
  ruleRegistryVersion: Cg4RuleRegistryVersion;
  content: Readonly<Record<string, unknown>>;
}

export interface Cg4PolicyDraftCommandV1 extends Cg4CommandBaseV1 {
  candidate: Cg4PolicyCandidateV1;
  expectedDraftRevision: number;
}

export interface Cg4PolicyArtifactBinding {
  policyVersionId: ContactPolicyVersionId;
  policyContentDigest: Cg4Digest;
  policySchemaVersion: Cg4PolicySchemaVersion;
  evaluatorVersion: Cg4EvaluatorVersion;
  ruleRegistryVersion: Cg4RuleRegistryVersion;
  platformFixturePackDigest: Cg4Digest;
  tenantFixturePackDigest: Cg4Digest;
  baseHeadVersion: number;
  baseHeadDigest: Cg4Digest;
}

export interface Cg4PolicyTestArtifactV1 extends Cg4PolicyArtifactBinding {
  contractVersion: Cg4ContractVersion;
  artifactDigest: Cg4Digest;
  result: 'PASS' | 'FAIL';
  passed: number;
  failed: number;
  completedAt: string;
}

export interface Cg4PolicyPreviewCommandV1 extends Cg4CommandBaseV1 {
  candidate: Cg4PolicyCandidateV1;
  platformFixturePackDigest: Cg4Digest;
  tenantFixturePackDigest: Cg4Digest;
  baseHeadVersion: number;
  baseHeadDigest: Cg4Digest;
  pinnedEvaluationTime: string;
  pinnedTimezone: string;
}

export interface Cg4PolicyPreviewResultV1 extends Cg4PolicyArtifactBinding {
  contractVersion: Cg4ContractVersion;
  previewDigest: Cg4Digest;
  diffDigest: Cg4Digest;
  diffClass: Cg4PolicyDiffClass;
  resultCounts: Readonly<Record<ContactDecision, number>>;
}

export interface Cg4PolicyApprovalCommandV1 extends Cg4CommandBaseV1 {
  policyVersionId: ContactPolicyVersionId;
  expectedDraftRevision: number;
  expectedContentDigest: Cg4Digest;
  expectedTestArtifactDigest: Cg4Digest;
  expectedDiffClass: Cg4PolicyDiffClass;
  expectedScopeHeadVersion: number;
  expectedScopeHeadDigest: Cg4Digest;
  effectiveAt: string;
  decision: Cg4ApprovalDecision;
  evidenceRef: string;
}

export interface Cg4PolicyPublishCommandV1 extends Cg4CommandBaseV1 {
  policyVersionId: ContactPolicyVersionId;
  expectedContentDigest: Cg4Digest;
  expectedTestArtifactDigest: Cg4Digest;
  expectedApprovalDigest: Cg4Digest;
  expectedScopeHeadVersion: number;
  expectedScopeHeadDigest: Cg4Digest;
  activateAt: string;
}

export interface Cg4PolicyRollbackCommandV1 extends Cg4CommandBaseV1 {
  policyId: ContactPolicyId;
  sourcePolicyVersionId: ContactPolicyVersionId;
  expectedSourceContentDigest: Cg4Digest;
  expectedScopeHeadVersion: number;
  expectedScopeHeadDigest: Cg4Digest;
  reasonCode: string;
  evidenceRef: string;
}

export interface Cg4PolicyMutationResultV1 {
  contractVersion: Cg4ContractVersion;
  mutationId: ContactMutationId;
  policyId: ContactPolicyId;
  policyVersionId: ContactPolicyVersionId;
  version: number;
  draftRevision: number;
  lifecycleState: Cg4PolicyLifecycleState;
  contentDigest: Cg4Digest;
  diffClass: Cg4PolicyDiffClass;
  quorum: Cg4QuorumSnapshot;
  activeHead?: Cg4PolicyHeadRef;
  scheduledHead?: Cg4PolicyHeadRef;
  etag: string;
}

export interface Cg4PolicyHeadRef {
  policyVersionId: ContactPolicyVersionId;
  version: number;
  contentDigest: Cg4Digest;
  activateAt: string;
}

export interface Cg4PolicyHeadSnapshotV1 {
  contractVersion: Cg4ContractVersion;
  scopeKey: string;
  headVersion: number;
  activePolicy: Cg4PolicyBinding;
  activeStateDigest: Cg4Digest;
  nextActivationAt?: string;
  validUntil: string;
}

export type Cg4KillScope =
  { kind: 'POLICY_SCOPE'; scopeKey: string } | { kind: 'CONTACT'; contactId: ContactId };

export interface Cg4KillSwitchCommandV1 extends Cg4CommandBaseV1 {
  action: 'ACTIVATE' | 'CLEAR';
  scope: Cg4KillScope;
  reasonCode: string;
  evidenceRef: string;
}

export interface Cg4KillSwitchResultV1 {
  contractVersion: Cg4ContractVersion;
  mutationId: ContactMutationId;
  scopeDigest: Cg4Digest;
  state: 'ACTIVE' | 'CLEARED';
  version: number;
  contentDigest: Cg4Digest;
  etag: string;
}

export interface Cg4AppliedExceptionPin {
  seriesId: ContactExceptionSeriesId;
  revisionId: ContactExceptionRevisionId;
  version: number;
  contentDigest: Cg4Digest;
  approvalDigest: Cg4Digest;
  matchedRuleCode: string;
}

/** snapshot แบบ optional ใน authorization outcome สำหรับ replay แบบ deterministic */
export interface Cg4DecisionTracePinsV1 {
  contractVersion: Cg4ContractVersion;
  policy: Cg4PolicyBinding;
  decisionStateDigest: Cg4Digest;
  appliedExceptions: readonly Cg4AppliedExceptionPin[];
}

export type Cg4Restrictiveness = Cg4PolicyDiffClass;
export type Cg4TransitionKind =
  | 'EXCEPTION_REQUESTED'
  | 'EXCEPTION_APPROVED'
  | 'EXCEPTION_REJECTED'
  | 'EXCEPTION_CANCELLED'
  | 'EXCEPTION_ACTIVATED'
  | 'EXCEPTION_EXPIRED'
  | 'EXCEPTION_REVOKED'
  | 'POLICY_CHANGED'
  | 'POLICY_ACTIVATED'
  | 'KILL_SWITCH_ACTIVATED'
  | 'KILL_SWITCH_CLEARED';

export const CG4_EVENT_TYPES = Object.freeze({
  EXCEPTION_CHANGED: 'exception.changed',
  POLICY_CHANGED: 'policy.changed',
  KILL_SWITCH_CHANGED: 'governance.kill-switch.changed',
} as const);

export const CG4_EVENT_AGGREGATE_TYPES = Object.freeze({
  CONTACT: 'contact_governance_contact',
  POLICY: 'contact_governance_policy',
} as const);

/** canonical payload ไม่มี PII; actor/ticket/evidence/raw identity อยู่ใน owner store เท่านั้น */
export interface Cg4CanonicalChangePayloadV1 extends Record<string, unknown> {
  contractVersion: Cg4ContractVersion;
  mutationId: ContactMutationId;
  transitionKind: Cg4TransitionKind;
  subjectId: string;
  subjectVersion: number;
  state: string;
  effectiveAt: string;
  affectedScope: {
    scopeKey: string;
    channel?: ContactChannel;
    purpose?: string;
    contactKind?: string;
    sourceType?: Cg4SourceType;
  };
  scopeDigest: Cg4Digest;
  policyVersion?: number;
  policyContentDigest?: Cg4Digest;
  exceptionVersion?: number;
  ruleRegistryVersion: Cg4RuleRegistryVersion;
  policySchemaVersion: Cg4PolicySchemaVersion;
  evaluatorVersion: Cg4EvaluatorVersion;
  stateDigest: Cg4Digest;
  restrictiveness: Cg4Restrictiveness;
  nextActivationAt?: string;
}

export type Cg4AuthorizationReviewReason =
  | 'GOVERNANCE_VERSION_STALE'
  | 'POLICY_ACTIVATION_PENDING'
  | 'POLICY_ACTIVATION_CONFLICT'
  | 'GOVERNANCE_POLICY_VERSION_UNSUPPORTED'
  | 'GOVERNANCE_STATE_UNAVAILABLE';

export type Cg4ErrorCode =
  | 'VALIDATION_FAILED'
  | 'SCOPE_INVALID'
  | 'RULE_NOT_REGISTERED'
  | 'TIME_WINDOW_INVALID'
  | 'DIGEST_INVALID'
  | 'FORBIDDEN'
  | 'TEAM_SEGMENT_NOT_ALLOWED'
  | 'CAPABILITY_REQUIRED'
  | 'SELF_APPROVAL_FORBIDDEN'
  | 'DELEGATION_NOT_ALLOWED'
  | 'RESOURCE_NOT_FOUND'
  | 'IDEMPOTENCY_CONFLICT'
  | 'VERSION_CONFLICT'
  | 'SOURCE_VERSION_CONFLICT'
  | 'EXCEPTION_SCOPE_CONFLICT'
  | 'POLICY_SCOPE_CONFLICT'
  | 'POLICY_HEAD_CONFLICT'
  | 'SCHEDULE_CONFLICT'
  | 'INVALID_LIFECYCLE_TRANSITION'
  | 'NON_OVERRIDABLE_RULE'
  | 'APPROVAL_REQUIRED'
  | 'APPROVAL_STALE'
  | 'QUORUM_NOT_MET'
  | 'POLICY_TESTS_REQUIRED'
  | 'POLICY_TESTS_FAILED'
  | 'POLICY_SCOPE_AMBIGUOUS'
  | 'POLICY_ACTIVATION_PENDING'
  | 'POLICY_ACTIVATION_CONFLICT'
  | 'POLICY_VERSION_UNSUPPORTED'
  | 'GOVERNANCE_STATE_UNAVAILABLE'
  | 'AUTHORIZATION_CONTEXT_UNAVAILABLE';

export type Cg4VersionFailureCode =
  | 'UNSUPPORTED_CONTRACT_VERSION'
  | 'UNSUPPORTED_POLICY_SCHEMA_VERSION'
  | 'UNSUPPORTED_RULE_REGISTRY_VERSION'
  | 'UNSUPPORTED_EVALUATOR_VERSION';

export class Cg4ContractError extends Error {
  constructor(
    readonly code: Cg4VersionFailureCode | 'CANONICAL_VALUE_INVALID' | 'DIGEST_INVALID',
    message: string,
  ) {
    super(message);
    this.name = 'Cg4ContractError';
  }
}

function canonicalValue(value: unknown, path: string): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Cg4ContractError('CANONICAL_VALUE_INVALID', `${path} ต้องเป็น finite number`);
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry, index) => canonicalValue(entry, `${path}[${index}]`)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Cg4ContractError('CANONICAL_VALUE_INVALID', `${path} ต้องเป็น plain JSON object`);
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalValue(entry, `${path}.${key}`)}`)
      .join(',')}}`;
  }
  throw new Cg4ContractError(
    'CANONICAL_VALUE_INVALID',
    `${path} ไม่รองรับ value type ${typeof value}`,
  );
}

export function canonicalCg4Json(value: unknown): string {
  return canonicalValue(value, 'value');
}

export function canonicalCg4Digest(value: unknown): Cg4Digest {
  return createHash('sha256').update(canonicalCg4Json(value)).digest('hex');
}

export function assertCg4Digest(value: string, field = 'digest'): asserts value is Cg4Digest {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new Cg4ContractError('DIGEST_INVALID', `${field} ต้องเป็น SHA-256 lowercase hex`);
  }
}

export interface Cg4ArtifactVersions {
  contractVersion: number;
  policySchemaVersion: number;
  ruleRegistryVersion: string;
  evaluatorVersion: string;
}

/** artifact ที่ไม่รู้จัก contract/schema/registry/evaluator version ห้ามเข้า evaluation */
export function assertSupportedCg4ArtifactVersions(
  versions: Cg4ArtifactVersions,
): asserts versions is Cg4ArtifactVersions & {
  contractVersion: Cg4ContractVersion;
  policySchemaVersion: Cg4PolicySchemaVersion;
  ruleRegistryVersion: Cg4RuleRegistryVersion;
  evaluatorVersion: Cg4EvaluatorVersion;
} {
  if (versions.contractVersion !== CG4_CONTRACT_VERSION) {
    throw new Cg4ContractError('UNSUPPORTED_CONTRACT_VERSION', 'ไม่รองรับ CG4 contract version');
  }
  if (versions.policySchemaVersion !== CG4_POLICY_SCHEMA_VERSION) {
    throw new Cg4ContractError(
      'UNSUPPORTED_POLICY_SCHEMA_VERSION',
      'ไม่รองรับ CG4 policy schema version',
    );
  }
  if (versions.ruleRegistryVersion !== CG4_RULE_REGISTRY_VERSION) {
    throw new Cg4ContractError(
      'UNSUPPORTED_RULE_REGISTRY_VERSION',
      'ไม่รองรับ CG4 rule registry version',
    );
  }
  if (versions.evaluatorVersion !== CG4_EVALUATOR_VERSION) {
    throw new Cg4ContractError('UNSUPPORTED_EVALUATOR_VERSION', 'ไม่รองรับ CG4 evaluator version');
  }
}

export interface Cg4EvaluationFailureV1 {
  contractVersion: Cg4ContractVersion;
  decision: Extract<ContactDecision, 'BLOCK' | 'DEFER' | 'REVIEW'>;
  reasonCode: Cg4AuthorizationReviewReason | string;
  reservationId?: never;
}
