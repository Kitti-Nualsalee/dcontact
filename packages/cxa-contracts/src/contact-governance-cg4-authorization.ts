/**
 * CG4.3: capability-based maker-checker authorization contracts. Additive to CG4.1
 * (`contact-governance-cg4.ts`) — no change to existing exception/policy wire types.
 *
 * These are domain/port contracts, not a public HTTP API (CG4.7 owns that). IAM owns
 * resolving a subject's current capabilities; Contact Governance only consumes the
 * resolved snapshot and enforces separation-of-duties + quorum from it. A role string
 * or a single privileged boolean is never sufficient — every check is capability +
 * current tenant/team/contact scope + stable human subject identity.
 */
import type { Cg4ExceptionRiskTier, Cg4PolicyDiffClass } from './contact-governance-cg4.js';
import type { Cg4DelegationId, Cg4SubjectId, TenantId } from './identifiers.js';

/**
 * The exact capability matrix from #173. Delegation may only ever grant
 * `cg.exception.request` or `cg.exception.approve.standard` (see
 * `CG4_DELEGABLE_CAPABILITIES`); every other capability requires a direct grant.
 */
export type Cg4Capability =
  | 'cg.exception.request'
  | 'cg.exception.amend'
  | 'cg.exception.approve.standard'
  | 'cg.exception.approve.high'
  | 'cg.exception.revoke'
  | 'cg.policy.draft'
  | 'cg.policy.publish'
  | 'cg.policy.publish.relaxation'
  | 'cg.policy.rollback';

export const CG4_DELEGABLE_CAPABILITIES: readonly Cg4Capability[] = Object.freeze([
  'cg.exception.request',
  'cg.exception.approve.standard',
]);

export type Cg4AuthenticationStrength = 'STANDARD' | 'STRONG';

export type Cg4CapabilityGrantSource = 'DIRECT' | 'DELEGATED';

export interface Cg4CapabilityGrant {
  capability: Cg4Capability;
  /** Opaque scope descriptor (tenant/team/contact) this grant is bound to. */
  scopeKey: string;
  source: Cg4CapabilityGrantSource;
  delegationId?: Cg4DelegationId;
  expiresAt?: string;
}

/**
 * A trusted, freshly resolved snapshot of one human subject's current authority.
 * IAM computes this; Contact Governance never trusts a stale copy or a request-token
 * role snapshot as permanent authority — every command boundary re-resolves it.
 *
 * `directComplianceAuthority`/`emergencyAuthority` describe the subject's standing
 * IAM authority (never grantable via delegation), independent of any one capability
 * grant, and are how the engine identifies the "direct Compliance" / "designated
 * emergency authority" checker the risk-tiered quorum rules require.
 */
export interface Cg4AuthorizationSubject {
  subjectId: Cg4SubjectId;
  tenantId: TenantId;
  authenticationStrength: Cg4AuthenticationStrength;
  capabilities: readonly Cg4CapabilityGrant[];
  directComplianceAuthority: boolean;
  emergencyAuthority: boolean;
  /** Bumped by IAM whenever this subject's grants/delegations change. */
  authorizationEpoch: number;
  /** Bumped by IAM whenever this subject's tenant/team/contact scope changes. */
  scopeVersion: number;
  evaluatedAt: string;
}

export interface ResolveCg4AuthorizationSubjectInput {
  tenantId: TenantId;
  subjectId: Cg4SubjectId;
}

/**
 * IAM owns this boundary and must resolve current grants/delegations/scope itself;
 * callers cannot pass a role or capability list to be treated as authorization
 * evidence. Returns `null` when the subject is unknown so callers fail closed.
 */
export interface Cg4AuthorizationPort<TContext = undefined> {
  resolveSubject(
    input: ResolveCg4AuthorizationSubjectInput,
    context?: TContext,
  ): Promise<Cg4AuthorizationSubject | null>;
}

/**
 * A delegation record from IAM, exactly as #173 §3 requires: exact capability, exact
 * scope, a maximum risk tier, and a hard ≤8h window. No wildcard tenant, no
 * recursive/sub-delegation, no shared/service delegate.
 */
export interface Cg4DelegationGrant {
  delegationId: Cg4DelegationId;
  tenantId: TenantId;
  delegatorSubjectId: Cg4SubjectId;
  delegateSubjectId: Cg4SubjectId;
  capability: Cg4Capability;
  scopeKey: string;
  maxRiskTier: Extract<Cg4ExceptionRiskTier, 'STANDARD'>;
  grantVersion: number;
  startsAt: string;
  expiresAt: string;
}

export type Cg4ApprovalTarget = 'EXCEPTION' | 'POLICY';

/** One recorded checker vote, as it must be persisted for audit/re-validation. */
export interface Cg4RecordedApproval {
  checkerSubjectId: Cg4SubjectId;
  capability: Cg4Capability;
  directComplianceAuthority: boolean;
  emergencyAuthority: boolean;
  source: Cg4CapabilityGrantSource;
  delegationId?: Cg4DelegationId;
  authorizationEpoch: number;
  scopeVersion: number;
  decidedAt: string;
}

export interface Cg4QuorumRequirement {
  requiredApprovers: number;
  requireDirectCompliance: number;
  requireEmergencyAuthority: number;
  /** Only set for `EMERGENCY`: the second independent ack must land within this window. */
  emergencyAcknowledgementWindowSeconds?: number;
}

export type Cg4QuorumStatus =
  'PENDING' | 'MET' | 'REJECTED' | 'EMERGENCY_ACTIVATED_ACK_PENDING' | 'EMERGENCY_ACK_EXPIRED';

export interface Cg4QuorumEvaluation {
  status: Cg4QuorumStatus;
  required: number;
  current: number;
  distinctApprovers: readonly Cg4SubjectId[];
}

export function resolveCg4ExceptionQuorum(tier: Cg4ExceptionRiskTier): Cg4QuorumRequirement {
  switch (tier) {
    case 'STANDARD':
      return { requiredApprovers: 1, requireDirectCompliance: 0, requireEmergencyAuthority: 0 };
    case 'HIGH':
      return { requiredApprovers: 2, requireDirectCompliance: 1, requireEmergencyAuthority: 0 };
    case 'EMERGENCY':
      return {
        requiredApprovers: 2,
        requireDirectCompliance: 1,
        requireEmergencyAuthority: 1,
        emergencyAcknowledgementWindowSeconds: 15 * 60,
      };
  }
}

/**
 * Policy quorum per #173 §2: tightening/neutral needs one independent Compliance
 * checker; a relaxation diff — or a rollback whose diff against the current active
 * policy nets a relaxation — needs two, at least one direct Compliance. Rollback is
 * never "safe by precedent"; the caller must classify the diff against the *current*
 * active policy, not the rolled-back version's own original approval.
 */
export function resolveCg4PolicyQuorum(diffClass: Cg4PolicyDiffClass): Cg4QuorumRequirement {
  if (diffClass === 'RELAXATION') {
    return { requiredApprovers: 2, requireDirectCompliance: 1, requireEmergencyAuthority: 0 };
  }
  return { requiredApprovers: 1, requireDirectCompliance: 1, requireEmergencyAuthority: 0 };
}
