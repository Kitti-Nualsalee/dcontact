import {
  CG4_DELEGABLE_CAPABILITIES,
  type Cg4AuthorizationSubject,
  type Cg4Capability,
  type Cg4CapabilityGrant,
  type Cg4ExceptionRiskTier,
  type Cg4PolicyDiffClass,
  type Cg4QuorumEvaluation,
  type Cg4QuorumRequirement,
  type Cg4RecordedApproval,
} from '@d-contact/cxa-contracts';

/**
 * CG4.3: pure maker-checker authorization logic. No database access here — callers
 * (the CG4.3 repositories, and CG4.4/CG4.5 later) resolve a fresh
 * `Cg4AuthorizationSubject` via the IAM `Cg4AuthorizationPort` and pass it in. Keeping
 * this pure makes the separation-of-duties/quorum rules independently testable and
 * keeps a role string or privileged boolean from ever substituting for a real check.
 */

export class Cg4CapabilityRequiredError extends Error {
  readonly code = 'CAPABILITY_REQUIRED';

  constructor(readonly capability: Cg4Capability) {
    super(`subject ไม่มี capability ${capability} ที่ current scope`);
    this.name = 'Cg4CapabilityRequiredError';
  }
}

export class Cg4SelfApprovalError extends Error {
  readonly code = 'SELF_APPROVAL_FORBIDDEN';

  constructor() {
    super('maker ไม่สามารถ approve คำขอ/revision ของตนเองได้');
    this.name = 'Cg4SelfApprovalError';
  }
}

export class Cg4DuplicateCheckerError extends Error {
  readonly code = 'FORBIDDEN';

  constructor() {
    super('checker คนนี้ approve/reject revision นี้ไปแล้ว');
    this.name = 'Cg4DuplicateCheckerError';
  }
}

export class Cg4DelegationNotAllowedError extends Error {
  readonly code = 'DELEGATION_NOT_ALLOWED';

  constructor(message: string) {
    super(message);
    this.name = 'Cg4DelegationNotAllowedError';
  }
}

export class Cg4ApprovalStaleError extends Error {
  readonly code = 'APPROVAL_STALE';

  constructor() {
    super('authorization epoch หรือ scope version เปลี่ยนไปตั้งแต่ approval ถูกบันทึก');
    this.name = 'Cg4ApprovalStaleError';
  }
}

export class Cg4QuorumNotMetError extends Error {
  readonly code = 'QUORUM_NOT_MET';

  constructor(
    readonly required: number,
    readonly current: number,
  ) {
    super(`quorum ยังไม่ครบ (${current}/${required})`);
    this.name = 'Cg4QuorumNotMetError';
  }
}

function findActiveGrant(
  subject: Cg4AuthorizationSubject,
  capability: Cg4Capability,
  scopeKey: string,
  now: Date,
): Cg4CapabilityGrant | undefined {
  return subject.capabilities.find(
    (grant) =>
      grant.capability === capability &&
      grant.scopeKey === scopeKey &&
      (!grant.expiresAt || new Date(grant.expiresAt) > now),
  );
}

/** Delegated grants may only ever back a request or a STANDARD-tier approval. */
function assertDelegationAllowed(capability: Cg4Capability, grant: Cg4CapabilityGrant): void {
  if (grant.source === 'DELEGATED' && !CG4_DELEGABLE_CAPABILITIES.includes(capability)) {
    throw new Cg4DelegationNotAllowedError(
      `delegated capability ใช้ได้เฉพาะ ${CG4_DELEGABLE_CAPABILITIES.join(', ')}`,
    );
  }
}

export interface AssertCg4RequestAuthorizationInput {
  subject: Cg4AuthorizationSubject;
  capability: Cg4Capability;
  scopeKey: string;
  now: Date;
}

/** Authorizes a maker action (request/amend/draft/rollback) — no quorum, no SoD peer. */
export function assertCg4RequestAuthorization(input: AssertCg4RequestAuthorizationInput): void {
  const grant = findActiveGrant(input.subject, input.capability, input.scopeKey, input.now);
  if (!grant) throw new Cg4CapabilityRequiredError(input.capability);
  assertDelegationAllowed(input.capability, grant);
}

export interface AssertCg4ApprovalAuthorizationInput {
  requiredCapability: Cg4Capability;
  checker: Cg4AuthorizationSubject;
  scopeKey: string;
  makerSubjectId: string;
  existingApprovals: readonly Cg4RecordedApproval[];
  now: Date;
}

/**
 * Authorizes one checker's vote: capability + scope, delegation restricted to
 * STANDARD-only actions, maker≠checker by stable subject id, and no checker counted
 * twice — all independent of any role string.
 */
export function assertCg4ApprovalAuthorization(
  input: AssertCg4ApprovalAuthorizationInput,
): Cg4CapabilityGrant {
  if (input.checker.subjectId === input.makerSubjectId) {
    throw new Cg4SelfApprovalError();
  }
  if (input.existingApprovals.some((a) => a.checkerSubjectId === input.checker.subjectId)) {
    throw new Cg4DuplicateCheckerError();
  }
  const grant = findActiveGrant(input.checker, input.requiredCapability, input.scopeKey, input.now);
  if (!grant) throw new Cg4CapabilityRequiredError(input.requiredCapability);
  assertDelegationAllowed(input.requiredCapability, grant);
  return grant;
}

/**
 * Detects a vote whose pinned authorization has gone stale — the checker's grant was
 * revoked or their scope changed after they voted. Callers must not count a stale
 * approval toward quorum finalization.
 */
export function isCg4ApprovalStale(
  approval: Cg4RecordedApproval,
  currentSubject: Cg4AuthorizationSubject,
): boolean {
  return (
    approval.authorizationEpoch !== currentSubject.authorizationEpoch ||
    approval.scopeVersion !== currentSubject.scopeVersion
  );
}

export function assertCg4ApprovalFresh(
  approval: Cg4RecordedApproval,
  currentSubject: Cg4AuthorizationSubject,
): void {
  if (isCg4ApprovalStale(approval, currentSubject)) {
    throw new Cg4ApprovalStaleError();
  }
}

export function resolveCg4RequiredExceptionCapability(tier: Cg4ExceptionRiskTier): Cg4Capability {
  return tier === 'STANDARD' ? 'cg.exception.approve.standard' : 'cg.exception.approve.high';
}

export function resolveCg4RequiredPolicyCapability(diffClass: Cg4PolicyDiffClass): Cg4Capability {
  return diffClass === 'RELAXATION' ? 'cg.policy.publish.relaxation' : 'cg.policy.publish';
}

/**
 * Counts distinct qualifying approvers against the requirement. A single REJECT
 * decision is terminal (mirrors CG3/CG4 append-only revision semantics — a rejected
 * request/revision is superseded by a new one, never reopened). `emergencyActivatedAt`
 * is the first EMERGENCY approval's `decidedAt`; a second, independent
 * direct-Compliance ack must land within the requirement's acknowledgement window or
 * the emergency approval is considered expired.
 */
export function evaluateCg4Quorum(
  requirement: Cg4QuorumRequirement,
  approvals: readonly Cg4RecordedApproval[],
  rejected: boolean,
  now: Date,
): Cg4QuorumEvaluation {
  const distinctBySubject = new Map<string, Cg4RecordedApproval>();
  for (const approval of approvals) distinctBySubject.set(approval.checkerSubjectId, approval);
  const distinct = [...distinctBySubject.values()];
  const distinctApprovers = distinct.map((a) => a.checkerSubjectId);
  const current = distinct.length;

  if (rejected) {
    return {
      status: 'REJECTED',
      required: requirement.requiredApprovers,
      current,
      distinctApprovers,
    };
  }

  const directComplianceCount = distinct.filter((a) => a.directComplianceAuthority).length;
  const emergencyCount = distinct.filter((a) => a.emergencyAuthority).length;
  const quorumSizeMet = current >= requirement.requiredApprovers;
  const complianceMet = directComplianceCount >= requirement.requireDirectCompliance;
  const emergencyMet = emergencyCount >= requirement.requireEmergencyAuthority;

  if (requirement.emergencyAcknowledgementWindowSeconds !== undefined) {
    const activation = distinct.find((a) => a.emergencyAuthority);
    if (!activation) {
      return {
        status: 'PENDING',
        required: requirement.requiredApprovers,
        current,
        distinctApprovers,
      };
    }
    if (quorumSizeMet && complianceMet && emergencyMet) {
      return { status: 'MET', required: requirement.requiredApprovers, current, distinctApprovers };
    }
    const deadline =
      new Date(activation.decidedAt).getTime() +
      requirement.emergencyAcknowledgementWindowSeconds * 1_000;
    return {
      status:
        now.getTime() > deadline ? 'EMERGENCY_ACK_EXPIRED' : 'EMERGENCY_ACTIVATED_ACK_PENDING',
      required: requirement.requiredApprovers,
      current,
      distinctApprovers,
    };
  }

  return {
    status: quorumSizeMet && complianceMet ? 'MET' : 'PENDING',
    required: requirement.requiredApprovers,
    current,
    distinctApprovers,
  };
}

export function assertCg4QuorumMet(evaluation: Cg4QuorumEvaluation): void {
  if (evaluation.status !== 'MET') {
    throw new Cg4QuorumNotMetError(evaluation.required, evaluation.current);
  }
}

const CG4_DELEGATION_MAX_WINDOW_MS = 8 * 60 * 60 * 1000;

export interface AssertCg4DelegationGrantAllowedInput {
  capability: Cg4Capability;
  delegatorSubjectId: string;
  delegateSubjectId: string;
  /** IAM must attest this — a delegate can never re-delegate a capability it only holds via delegation. */
  delegatorHoldsCapabilityDirectly: boolean;
  /** IAM must attest this — group/shared/service principals can never be a delegate. */
  delegateIsServicePrincipal: boolean;
  startsAt: Date;
  expiresAt: Date;
}

/** Pure validation for #173 §3: exact capability/scope/risk, no wildcard, no chaining, ≤8h. */
export function assertCg4DelegationGrantAllowed(input: AssertCg4DelegationGrantAllowedInput): void {
  if (!CG4_DELEGABLE_CAPABILITIES.includes(input.capability)) {
    throw new Cg4DelegationNotAllowedError(`capability ${input.capability} มอบหมายไม่ได้`);
  }
  if (input.delegatorSubjectId === input.delegateSubjectId) {
    throw new Cg4DelegationNotAllowedError('ผู้มอบหมายและผู้รับมอบหมายต้องเป็นคนละ subject');
  }
  if (!input.delegatorHoldsCapabilityDirectly) {
    throw new Cg4DelegationNotAllowedError(
      'ห้าม sub-delegate capability ที่ได้จาก delegation อื่น',
    );
  }
  if (input.delegateIsServicePrincipal) {
    throw new Cg4DelegationNotAllowedError('ห้ามมอบหมายให้ service/shared principal');
  }
  if (input.expiresAt.getTime() <= input.startsAt.getTime()) {
    throw new RangeError('expiresAt ต้องอยู่หลัง startsAt');
  }
  if (input.expiresAt.getTime() - input.startsAt.getTime() > CG4_DELEGATION_MAX_WINDOW_MS) {
    throw new Cg4DelegationNotAllowedError('delegation ต้องไม่เกิน 8 ชั่วโมง');
  }
}
