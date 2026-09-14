/**
 * CG4.9 (#192): Console client ของ CG4 command/query API (#179 §2)
 *
 * Console เรียกเฉพาะ D-Contact API: tenant และ actor มาจาก bearer token ที่ gateway ตรวจแล้ว
 * จึงไม่มี field ใดใน body ที่ระบุ tenant, actor, role หรือ capability และไม่มี provider endpoint
 * ทุก command ต้องมี Idempotency-Key ที่ caller ถือไว้ตลอด intent เดียว — การส่งซ้ำหลังผลไม่แน่ชัด
 * ต้องใช้ key เดิม ไม่ใช่ key ใหม่ (#179 §2, #180 partial failure)
 */

export type RiskTier = 'STANDARD' | 'HIGH' | 'EMERGENCY';
export type ApprovalDecision = 'APPROVE' | 'REJECT';

/** reference ที่ server ปกปิดแล้ว: เทียบกันได้ด้วย digest แต่อ่านเนื้อหาไม่ได้ */
export interface RedactedRef {
  redacted: true;
  digest: string;
}
export type MaybeRedacted = string | RedactedRef;

export interface ExceptionRevision {
  seriesId: string;
  revisionId: string;
  revision: number;
  contactId: string;
  identityId?: string;
  scopeKind: string;
  channel: string;
  purpose: string;
  sourceType: string;
  sourceId: string;
  allowedRuleCodes: string[];
  policyId: string;
  policyVersion: number;
  policyContentDigest: string;
  registryVersion: string;
  startsAt: string;
  expiresAt: string;
  riskTier: RiskTier;
  reasonCode: string;
  contentDigest: string;
  createdAt: string;
  ticketRef?: MaybeRedacted;
  evidenceRef: MaybeRedacted;
  actorRef: MaybeRedacted;
  renewsSeriesId?: string;
}

export interface ExceptionSeries extends ExceptionRevision {
  workflowState: string;
  effectiveState: string;
  aggregateVersion: number;
  etag: string;
}

export interface ApprovalRecord {
  approverRef: MaybeRedacted;
  decision: string;
  capability: string;
  capabilitySource: string;
  directCompliance: boolean;
  emergencyAuthority: boolean;
  authorizationEpoch: number;
  scopeVersion: number;
  decidedAt: string;
  evidenceRef?: MaybeRedacted;
}

export interface Quorum {
  status: string;
  required: number;
  current: number;
}

export interface ExceptionDecisionResult {
  seriesId: string;
  revision: number;
  quorum: Quorum;
  workflowState?: string;
  effectiveState?: string;
  aggregateVersion?: number;
}

export interface ExceptionTransitionResult {
  exceptionId: string;
  revision: number;
  workflowState: string;
  effectiveState: string;
  aggregateVersion: number;
}

export interface PolicyVersion {
  policyId: string;
  policyVersionId: string;
  version: number;
  draftRevision: number;
  scopeKey: string;
  lifecycleState: string;
  contentDigest: string;
  schemaVersion: number;
  registryVersion: string;
  evaluatorVersion: string;
  diffClass?: 'TIGHTENING' | 'NEUTRAL' | 'RELAXATION';
  testArtifactDigest?: string;
  approvalDigest?: string;
  baseHeadVersion?: number;
  baseHeadDigest?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  activateAt?: string;
  publishedAt?: string;
  rollbackOfVersionId?: string;
  supersedesVersionId?: string;
  makerActorRef: MaybeRedacted;
  createdAt: string;
  etag: string;
}

export interface PolicyTestArtifact {
  artifactId: string;
  policyId: string;
  policyVersion: number;
  suiteVersion: string;
  artifactDigest: string;
  contentDigest: string;
  baseHeadVersion: number;
  baseHeadDigest: string;
  diffClass: 'TIGHTENING' | 'NEUTRAL' | 'RELAXATION';
  outcome: string;
  passed: number;
  failed: number;
  createdAt: string;
}

export interface EffectiveScope {
  scopeKey: string;
  headVersion: number;
  headDigest: string;
  activePolicyId: string;
  activePolicyVersionId: string;
  activePolicyVersion: number;
  nextActivationAt?: string;
  killSwitchActive: boolean;
  updatedAt: string;
  etag: string;
}

export interface KillSwitch {
  killSwitchId: string;
  scopeKey: string;
  state: string;
  reasonCode: string;
  activatedAt: string;
  clearedAt?: string;
  activatedByRef: MaybeRedacted;
  evidenceRef?: MaybeRedacted;
}

export interface PolicyApprovalResult {
  policyId: string;
  version: number;
  quorum: Quorum;
  lifecycleState: string;
  headVersion?: number;
  activateAt?: string;
}

export interface PolicyRollbackResult {
  policyId: string;
  policyVersionId: string;
  version: number;
  lifecycleState: string;
}

/** รายละเอียดที่ server ส่งมากับ error เช่น expected/actual version ของ conflict */
export interface GovernanceErrorDetails {
  expectedVersion?: number;
  actualVersion?: number;
  required?: number;
  current?: number;
  capability?: string;
  message?: string;
}

export class GovernanceApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    readonly details: GovernanceErrorDetails = {},
  ) {
    super(code ?? `Governance API failed with HTTP ${status}`);
    this.name = 'GovernanceApiError';
  }
}

export interface GovernanceApi {
  contactExceptions(contactId: string): Promise<ExceptionSeries[]>;
  exception(seriesId: string): Promise<ExceptionSeries>;
  exceptionHistory(seriesId: string): Promise<ExceptionRevision[]>;
  exceptionApprovals(seriesId: string): Promise<ApprovalRecord[]>;
  decideException(input: {
    series: ExceptionSeries;
    decision: ApprovalDecision;
    evidenceRef: string;
    reasonCode?: string;
    idempotencyKey: string;
  }): Promise<ExceptionDecisionResult>;
  transitionException(input: {
    series: ExceptionSeries;
    action: 'cancel' | 'revoke';
    reasonCode: string;
    evidenceRef: string;
    idempotencyKey: string;
  }): Promise<ExceptionTransitionResult>;
  policyVersions(policyId: string): Promise<PolicyVersion[]>;
  policyVersion(versionId: string): Promise<PolicyVersion>;
  policyTests(versionId: string): Promise<PolicyTestArtifact[]>;
  policyApprovals(versionId: string): Promise<ApprovalRecord[]>;
  decidePolicy(input: {
    version: PolicyVersion;
    decision: ApprovalDecision;
    artifact: PolicyTestArtifact;
    head: EffectiveScope;
    activateAt: string;
    evidenceRef: string;
    idempotencyKey: string;
  }): Promise<PolicyApprovalResult>;
  publishPolicy(input: {
    version: PolicyVersion;
    artifact: PolicyTestArtifact;
    head: EffectiveScope;
    evidenceRef: string;
    idempotencyKey: string;
  }): Promise<PolicyApprovalResult>;
  rollbackPolicy(input: {
    source: PolicyVersion;
    reasonCode: string;
    evidenceRef: string;
    idempotencyKey: string;
  }): Promise<PolicyRollbackResult>;
  /** คืน `undefined` เมื่อ scope ยังไม่มี active head (404) */
  effectiveScope(scopeKey: string): Promise<EffectiveScope | undefined>;
  killSwitches(input?: { scopeKey?: string; state?: 'ACTIVE' | 'CLEARED' }): Promise<KillSwitch[]>;
}

const BASE = '/api/v1/contact-governance';

export function createGovernanceApi(input: {
  baseUrl: string;
  accessToken(): string | undefined;
  fetch?: typeof globalThis.fetch;
}): GovernanceApi {
  const request = input.fetch ?? globalThis.fetch;

  const call = async <T>(
    path: string,
    init: { method?: 'GET' | 'POST'; body?: unknown; idempotencyKey?: string } = {},
  ): Promise<T> => {
    const token = input.accessToken();
    if (!token) throw new GovernanceApiError(401, 'AUTHORIZATION_CONTEXT_UNAVAILABLE');
    const headers: Record<string, string> = { authorization: `Bearer ${token}` };
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;
    const response = await request(`${input.baseUrl.replace(/\/$/, '')}${BASE}${path}`, {
      method: init.method ?? 'GET',
      headers,
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    if (!response.ok) {
      const payload = (await response.json().catch(() => undefined)) as
        ({ code?: string } & GovernanceErrorDetails) | undefined;
      const { code, ...details } = payload ?? {};
      throw new GovernanceApiError(response.status, code, details);
    }
    return (await response.json()) as T;
  };
  const id = encodeURIComponent;

  return {
    contactExceptions: async (contactId) =>
      (await call<{ exceptions: ExceptionSeries[] }>(`/contacts/${id(contactId)}/exceptions`))
        .exceptions,
    exception: (seriesId) => call<ExceptionSeries>(`/exceptions/${id(seriesId)}`),
    exceptionHistory: async (seriesId) =>
      (await call<{ revisions: ExceptionRevision[] }>(`/exceptions/${id(seriesId)}/history`))
        .revisions,
    exceptionApprovals: async (seriesId) =>
      (await call<{ approvals: ApprovalRecord[] }>(`/exceptions/${id(seriesId)}/approvals`))
        .approvals,
    decideException: ({ series, decision, evidenceRef, reasonCode, idempotencyKey }) =>
      call<ExceptionDecisionResult>(`/exceptions/${id(series.seriesId)}/approvals`, {
        method: 'POST',
        idempotencyKey,
        body: {
          decision,
          // ผูกกับ revision/digest/version ที่ผู้ตรวจเห็นจริง server จะปฏิเสธถ้ามีการเปลี่ยนระหว่างนั้น
          expectedRevision: series.revision,
          expectedContentDigest: series.contentDigest,
          expectedVersion: series.aggregateVersion,
          evidenceRef,
          ...(reasonCode ? { reasonCode } : {}),
        },
      }),
    transitionException: ({ series, action, reasonCode, evidenceRef, idempotencyKey }) =>
      call<ExceptionTransitionResult>(`/exceptions/${id(series.seriesId)}/${action}`, {
        method: 'POST',
        idempotencyKey,
        body: {
          expectedRevision: series.revision,
          expectedContentDigest: series.contentDigest,
          expectedVersion: series.aggregateVersion,
          reasonCode,
          evidenceRef,
        },
      }),
    policyVersions: async (policyId) =>
      (await call<{ versions: PolicyVersion[] }>(`/policies/${id(policyId)}/versions`)).versions,
    policyVersion: (versionId) => call<PolicyVersion>(`/policy-versions/${id(versionId)}`),
    policyTests: async (versionId) =>
      (await call<{ artifacts: PolicyTestArtifact[] }>(`/policy-versions/${id(versionId)}/tests`))
        .artifacts,
    policyApprovals: async (versionId) =>
      (await call<{ approvals: ApprovalRecord[] }>(`/policy-versions/${id(versionId)}/approvals`))
        .approvals,
    decidePolicy: ({
      version,
      decision,
      artifact,
      head,
      activateAt,
      evidenceRef,
      idempotencyKey,
    }) =>
      call<PolicyApprovalResult>(`/policy-versions/${id(version.policyVersionId)}/approvals`, {
        method: 'POST',
        idempotencyKey,
        body: {
          decision,
          expectedContentDigest: version.contentDigest,
          expectedTestArtifactDigest: artifact.artifactDigest,
          expectedScopeHeadVersion: head.headVersion,
          expectedScopeHeadDigest: head.headDigest,
          activateAt,
          evidenceRef,
        },
      }),
    publishPolicy: ({ version, artifact, head, evidenceRef, idempotencyKey }) => {
      if (!version.approvalDigest) {
        return Promise.reject(new GovernanceApiError(422, 'APPROVAL_REQUIRED'));
      }
      return call<PolicyApprovalResult>(`/policy-versions/${id(version.policyVersionId)}/publish`, {
        method: 'POST',
        idempotencyKey,
        body: {
          expectedContentDigest: version.contentDigest,
          expectedTestArtifactDigest: artifact.artifactDigest,
          expectedApprovalDigest: version.approvalDigest,
          expectedScopeHeadVersion: head.headVersion,
          expectedScopeHeadDigest: head.headDigest,
          evidenceRef,
        },
      });
    },
    rollbackPolicy: ({ source, reasonCode, evidenceRef, idempotencyKey }) =>
      call<PolicyRollbackResult>(`/policies/${id(source.policyId)}/rollbacks`, {
        method: 'POST',
        idempotencyKey,
        body: {
          sourceVersion: source.version,
          expectedSourceContentDigest: source.contentDigest,
          reasonCode,
          evidenceRef,
        },
      }),
    effectiveScope: async (scopeKey) => {
      try {
        return await call<EffectiveScope>(`/policy-scopes/${id(scopeKey)}/effective`);
      } catch (error) {
        if (error instanceof GovernanceApiError && error.status === 404) return undefined;
        throw error;
      }
    },
    killSwitches: async (filter = {}) => {
      const query = new URLSearchParams();
      if (filter.scopeKey) query.set('scope', filter.scopeKey);
      if (filter.state) query.set('state', filter.state);
      const suffix = query.size > 0 ? `?${query}` : '';
      return (await call<{ killSwitches: KillSwitch[] }>(`/kill-switches${suffix}`)).killSwitches;
    },
  };
}
