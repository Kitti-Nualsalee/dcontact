import {
  contactExceptionRevisionId,
  contactExceptionSeriesId,
  contactId,
  contactMutationId,
  contactPolicyId,
  contactPolicyVersionId,
  identityId,
} from '../identifiers.js';
import {
  CG4_CONTRACT_VERSION,
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  canonicalCg4Digest,
  type Cg4CanonicalChangePayloadV1,
  type Cg4ExceptionMutationResultV1,
  type Cg4ExceptionRequestCommandV1,
  type Cg4PolicyBinding,
  type Cg4PolicyCandidateV1,
} from '../contact-governance-cg4.js';

const FIXTURE_TIME = '2026-09-15T10:00:00.000Z';

/** fixture สังเคราะห์ที่ไม่มี PII และให้ผล deterministic; test override เฉพาะ field ที่เกี่ยวกับ case */
export function createCg4PolicyCandidateFixture(
  overrides: Partial<Cg4PolicyCandidateV1> = {},
): Cg4PolicyCandidateV1 {
  return {
    contractVersion: CG4_CONTRACT_VERSION,
    schemaVersion: CG4_POLICY_SCHEMA_VERSION,
    policyId: contactPolicyId('policy-fixture-001'),
    policyVersionId: contactPolicyVersionId('policy-version-fixture-001'),
    version: 1,
    draftRevision: 1,
    scope: { scopeKey: 'scope-fixture-001', channel: 'LINE', purpose: 'SERVICE' },
    allowedOperationalRuleCodes: ['QUIET_HOURS'],
    evaluatorVersion: CG4_EVALUATOR_VERSION,
    ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
    content: {
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5], startLocal: '21:00', endLocal: '08:00' }],
      timezoneFallback: 'Asia/Bangkok',
    },
    ...overrides,
  };
}

export function createCg4PolicyBindingFixture(
  overrides: Partial<Cg4PolicyBinding> = {},
): Cg4PolicyBinding {
  const candidate = createCg4PolicyCandidateFixture();
  return {
    policyId: candidate.policyId,
    policyVersionId: candidate.policyVersionId,
    policyVersion: candidate.version,
    policyContentDigest: canonicalCg4Digest(candidate.content),
    policySchemaVersion: candidate.schemaVersion,
    ruleRegistryVersion: candidate.ruleRegistryVersion,
    evaluatorVersion: candidate.evaluatorVersion,
    ...overrides,
  };
}

export function createCg4ExceptionRequestFixture(
  overrides: Partial<Cg4ExceptionRequestCommandV1> = {},
): Cg4ExceptionRequestCommandV1 {
  return {
    contractVersion: CG4_CONTRACT_VERSION,
    expectedVersion: 0,
    idempotencyKey: 'idempotency-fixture-001',
    scope: {
      contactId: contactId('contact-fixture-001'),
      identity: { kind: 'EXACT_IDENTITY', identityId: identityId('identity-fixture-001') },
      channel: 'LINE',
      purpose: 'SERVICE',
      sourceType: 'JOURNEY',
      sourceId: 'journey-fixture-001',
    },
    allowedRuleCodes: ['QUIET_HOURS'],
    policy: createCg4PolicyBindingFixture(),
    startsAt: FIXTURE_TIME,
    expiresAt: '2026-09-15T14:00:00.000Z',
    reasonCode: 'CUSTOMER_REQUESTED_CALLBACK',
    ticketRef: 'ticket-fixture-001',
    evidenceRef: 'evidence-fixture-001',
    ...overrides,
  };
}

export function createCg4ExceptionResultFixture(
  overrides: Partial<Cg4ExceptionMutationResultV1> = {},
): Cg4ExceptionMutationResultV1 {
  const request = createCg4ExceptionRequestFixture();
  return {
    contractVersion: CG4_CONTRACT_VERSION,
    mutationId: contactMutationId('mutation-fixture-001'),
    seriesId: contactExceptionSeriesId('exception-series-fixture-001'),
    revisionId: contactExceptionRevisionId('exception-revision-fixture-001'),
    version: 1,
    workflowState: 'PENDING',
    effectiveState: 'INACTIVE',
    riskTier: 'STANDARD',
    contentDigest: canonicalCg4Digest(request),
    quorum: {
      required: 1,
      current: 0,
      authorizationEpoch: 1,
      approvalDigest: canonicalCg4Digest([]),
    },
    etag: '"exception-series-fixture-001:1"',
    ...overrides,
  };
}

export function createCg4CanonicalChangePayloadFixture(
  overrides: Partial<Cg4CanonicalChangePayloadV1> = {},
): Cg4CanonicalChangePayloadV1 {
  const policy = createCg4PolicyBindingFixture();
  const affectedScope = {
    scopeKey: 'scope-fixture-001',
    channel: 'LINE' as const,
    purpose: 'SERVICE',
    contactKind: 'PERSONAL',
    sourceType: 'JOURNEY' as const,
  };
  return {
    contractVersion: CG4_CONTRACT_VERSION,
    mutationId: contactMutationId('mutation-fixture-001'),
    transitionKind: 'EXCEPTION_APPROVED',
    subjectId: 'contact-fixture-001',
    subjectVersion: 2,
    state: 'APPROVED',
    effectiveAt: FIXTURE_TIME,
    affectedScope,
    scopeDigest: canonicalCg4Digest(affectedScope),
    policyVersion: policy.policyVersion,
    policyContentDigest: policy.policyContentDigest,
    exceptionVersion: 1,
    ruleRegistryVersion: policy.ruleRegistryVersion,
    policySchemaVersion: policy.policySchemaVersion,
    evaluatorVersion: policy.evaluatorVersion,
    stateDigest: canonicalCg4Digest({ policy, exceptionVersion: 1 }),
    restrictiveness: 'RELAXATION',
    ...overrides,
  };
}
