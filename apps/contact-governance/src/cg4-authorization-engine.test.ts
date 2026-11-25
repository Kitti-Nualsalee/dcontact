import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  Cg4AuthorizationSubject,
  Cg4Capability,
  Cg4RecordedApproval,
} from '@d-contact/cxa-contracts';
import {
  cg4SubjectId,
  resolveCg4ExceptionQuorum,
  resolveCg4PolicyQuorum,
  tenantId,
} from '@d-contact/cxa-contracts';
import {
  assertCg4ApprovalAuthorization,
  assertCg4ApprovalFresh,
  assertCg4DelegationGrantAllowed,
  assertCg4QuorumMet,
  assertCg4RequestAuthorization,
  Cg4ApprovalStaleError,
  Cg4CapabilityRequiredError,
  Cg4DelegationNotAllowedError,
  Cg4DuplicateCheckerError,
  Cg4QuorumNotMetError,
  Cg4SelfApprovalError,
  evaluateCg4Quorum,
  resolveCg4RequiredExceptionCapability,
  resolveCg4RequiredPolicyCapability,
} from './cg4-authorization-engine.js';

const TENANT = tenantId('11111111-1111-1111-1111-111111111111');
const NOW = new Date('2026-09-13T12:00:00.000Z');
const SCOPE = 'tenant:t1|team:compliance';

function subject(overrides: Partial<Cg4AuthorizationSubject> = {}): Cg4AuthorizationSubject {
  return {
    subjectId: cg4SubjectId(overrides.subjectId ?? 'subject-checker-1'),
    tenantId: TENANT,
    authenticationStrength: 'STANDARD',
    capabilities: [],
    directComplianceAuthority: false,
    emergencyAuthority: false,
    authorizationEpoch: 1,
    scopeVersion: 1,
    evaluatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function grantSubject(
  capability: Cg4Capability,
  overrides: Partial<Cg4AuthorizationSubject> = {},
): Cg4AuthorizationSubject {
  return subject({
    capabilities: [{ capability, scopeKey: SCOPE, source: 'DIRECT' }],
    ...overrides,
  });
}

function approval(overrides: Partial<Cg4RecordedApproval> = {}): Cg4RecordedApproval {
  return {
    checkerSubjectId: cg4SubjectId('subject-checker-x'),
    capability: 'cg.exception.approve.standard',
    directComplianceAuthority: false,
    emergencyAuthority: false,
    source: 'DIRECT',
    authorizationEpoch: 1,
    scopeVersion: 1,
    decidedAt: NOW.toISOString(),
    ...overrides,
  };
}

test('quorum requirement: STANDARD=1, HIGH=2 with at least one direct Compliance, EMERGENCY needs emergency authority and a 15-minute ack window', () => {
  assert.deepEqual(resolveCg4ExceptionQuorum('STANDARD'), {
    requiredApprovers: 1,
    requireDirectCompliance: 0,
    requireEmergencyAuthority: 0,
  });
  assert.deepEqual(resolveCg4ExceptionQuorum('HIGH'), {
    requiredApprovers: 2,
    requireDirectCompliance: 1,
    requireEmergencyAuthority: 0,
  });
  assert.deepEqual(resolveCg4ExceptionQuorum('EMERGENCY'), {
    requiredApprovers: 2,
    requireDirectCompliance: 1,
    requireEmergencyAuthority: 1,
    emergencyAcknowledgementWindowSeconds: 900,
  });
});

test('policy quorum: tightening/neutral uses 1 independent Compliance, relaxation needs 2 people including a direct Compliance', () => {
  assert.deepEqual(resolveCg4PolicyQuorum('TIGHTENING'), {
    requiredApprovers: 1,
    requireDirectCompliance: 1,
    requireEmergencyAuthority: 0,
  });
  assert.deepEqual(resolveCg4PolicyQuorum('NEUTRAL'), {
    requiredApprovers: 1,
    requireDirectCompliance: 1,
    requireEmergencyAuthority: 0,
  });
  assert.deepEqual(resolveCg4PolicyQuorum('RELAXATION'), {
    requiredApprovers: 2,
    requireDirectCompliance: 1,
    requireEmergencyAuthority: 0,
  });
});

test('required capability: STANDARD/HIGH exception and tightening-neutral/relaxation policy map to different capabilities', () => {
  assert.equal(resolveCg4RequiredExceptionCapability('STANDARD'), 'cg.exception.approve.standard');
  assert.equal(resolveCg4RequiredExceptionCapability('HIGH'), 'cg.exception.approve.high');
  assert.equal(resolveCg4RequiredExceptionCapability('EMERGENCY'), 'cg.exception.approve.high');
  assert.equal(resolveCg4RequiredPolicyCapability('TIGHTENING'), 'cg.policy.publish');
  assert.equal(resolveCg4RequiredPolicyCapability('NEUTRAL'), 'cg.policy.publish');
  assert.equal(resolveCg4RequiredPolicyCapability('RELAXATION'), 'cg.policy.publish.relaxation');
});

test('assertCg4RequestAuthorization: a missing or expired capability is rejected, a delegated capability outside the request/approve.standard set is rejected', () => {
  assert.throws(
    () =>
      assertCg4RequestAuthorization({
        subject: subject(),
        capability: 'cg.exception.request',
        scopeKey: SCOPE,
        now: NOW,
      }),
    Cg4CapabilityRequiredError,
  );
  assert.doesNotThrow(() =>
    assertCg4RequestAuthorization({
      subject: grantSubject('cg.exception.request'),
      capability: 'cg.exception.request',
      scopeKey: SCOPE,
      now: NOW,
    }),
  );
  const expired = subject({
    capabilities: [
      {
        capability: 'cg.exception.request',
        scopeKey: SCOPE,
        source: 'DIRECT',
        expiresAt: '2026-09-13T11:00:00.000Z',
      },
    ],
  });
  assert.throws(
    () =>
      assertCg4RequestAuthorization({
        subject: expired,
        capability: 'cg.exception.request',
        scopeKey: SCOPE,
        now: NOW,
      }),
    Cg4CapabilityRequiredError,
  );
  const delegatedHigh = subject({
    capabilities: [
      { capability: 'cg.exception.approve.high', scopeKey: SCOPE, source: 'DELEGATED' },
    ],
  });
  assert.throws(
    () =>
      assertCg4RequestAuthorization({
        subject: delegatedHigh,
        capability: 'cg.exception.approve.high',
        scopeKey: SCOPE,
        now: NOW,
      }),
    Cg4DelegationNotAllowedError,
  );
});

test('assertCg4ApprovalAuthorization: self-approval with the same stable subject id is always rejected, even with a different actorRef string', () => {
  const checker = grantSubject('cg.exception.approve.standard', {
    subjectId: cg4SubjectId('maker-1'),
  });
  assert.throws(
    () =>
      assertCg4ApprovalAuthorization({
        requiredCapability: 'cg.exception.approve.standard',
        checker,
        scopeKey: SCOPE,
        makerSubjectId: 'maker-1',
        existingApprovals: [],
        now: NOW,
      }),
    Cg4SelfApprovalError,
  );
});

test('assertCg4ApprovalAuthorization: the same checker approving again is rejected (unique checker per quorum)', () => {
  const checker = grantSubject('cg.exception.approve.standard', {
    subjectId: cg4SubjectId('checker-1'),
  });
  assert.throws(
    () =>
      assertCg4ApprovalAuthorization({
        requiredCapability: 'cg.exception.approve.standard',
        checker,
        scopeKey: SCOPE,
        makerSubjectId: 'maker-1',
        existingApprovals: [approval({ checkerSubjectId: cg4SubjectId('checker-1') })],
        now: NOW,
      }),
    Cg4DuplicateCheckerError,
  );
});

test('assertCg4ApprovalAuthorization: a checker without the capability for the tier is rejected fail-closed', () => {
  const checker = subject({ subjectId: cg4SubjectId('checker-1') });
  assert.throws(
    () =>
      assertCg4ApprovalAuthorization({
        requiredCapability: 'cg.exception.approve.high',
        checker,
        scopeKey: SCOPE,
        makerSubjectId: 'maker-1',
        existingApprovals: [],
        now: NOW,
      }),
    Cg4CapabilityRequiredError,
  );
});

test('assertCg4ApprovalFresh: an epoch or scope version that changed after the approval was recorded makes the original approval stale', () => {
  const recorded = approval({ authorizationEpoch: 1, scopeVersion: 1 });
  assert.doesNotThrow(() =>
    assertCg4ApprovalFresh(recorded, subject({ authorizationEpoch: 1, scopeVersion: 1 })),
  );
  assert.throws(
    () => assertCg4ApprovalFresh(recorded, subject({ authorizationEpoch: 2, scopeVersion: 1 })),
    Cg4ApprovalStaleError,
  );
  assert.throws(
    () => assertCg4ApprovalFresh(recorded, subject({ authorizationEpoch: 1, scopeVersion: 2 })),
    Cg4ApprovalStaleError,
  );
});

test('evaluateCg4Quorum: STANDARD needs 1 independent checker', () => {
  const requirement = resolveCg4ExceptionQuorum('STANDARD');
  assert.equal(evaluateCg4Quorum(requirement, [], false, NOW).status, 'PENDING');
  const met = evaluateCg4Quorum(requirement, [approval()], false, NOW);
  assert.equal(met.status, 'MET');
  assert.equal(met.current, 1);
});

test('evaluateCg4Quorum: HIGH needs 2 different people and at least one holds direct Compliance', () => {
  const requirement = resolveCg4ExceptionQuorum('HIGH');
  const twoNonCompliance = [
    approval({ checkerSubjectId: cg4SubjectId('c1'), capability: 'cg.exception.approve.high' }),
    approval({ checkerSubjectId: cg4SubjectId('c2'), capability: 'cg.exception.approve.high' }),
  ];
  assert.equal(evaluateCg4Quorum(requirement, twoNonCompliance, false, NOW).status, 'PENDING');

  const oneComplianceOneNot = [
    approval({
      checkerSubjectId: cg4SubjectId('c1'),
      capability: 'cg.exception.approve.high',
      directComplianceAuthority: true,
    }),
    approval({ checkerSubjectId: cg4SubjectId('c2'), capability: 'cg.exception.approve.high' }),
  ];
  assert.equal(evaluateCg4Quorum(requirement, oneComplianceOneNot, false, NOW).status, 'MET');

  const sameCheckerTwice = [
    approval({
      checkerSubjectId: cg4SubjectId('c1'),
      capability: 'cg.exception.approve.high',
      directComplianceAuthority: true,
    }),
    approval({
      checkerSubjectId: cg4SubjectId('c1'),
      capability: 'cg.exception.approve.high',
      directComplianceAuthority: true,
    }),
  ];
  assert.equal(evaluateCg4Quorum(requirement, sameCheckerTwice, false, NOW).current, 1);
  assert.equal(evaluateCg4Quorum(requirement, sameCheckerTwice, false, NOW).status, 'PENDING');
});

test('evaluateCg4Quorum: a single reject is terminal no matter how many approvals came before', () => {
  const requirement = resolveCg4ExceptionQuorum('STANDARD');
  assert.equal(evaluateCg4Quorum(requirement, [approval()], true, NOW).status, 'REJECTED');
});

test('evaluateCg4Quorum: EMERGENCY can be activated by a single emergency authority first, but is MET only when a second independent direct-Compliance ack arrives within 15 minutes', () => {
  const requirement = resolveCg4ExceptionQuorum('EMERGENCY');
  const activationOnly = [
    approval({
      checkerSubjectId: cg4SubjectId('emergency-1'),
      capability: 'cg.exception.approve.high',
      emergencyAuthority: true,
      decidedAt: '2026-09-13T11:50:00.000Z',
    }),
  ];
  assert.equal(
    evaluateCg4Quorum(requirement, activationOnly, false, NOW).status,
    'EMERGENCY_ACTIVATED_ACK_PENDING',
  );

  const ackWithinWindow = [
    ...activationOnly,
    approval({
      checkerSubjectId: cg4SubjectId('compliance-2'),
      capability: 'cg.exception.approve.high',
      directComplianceAuthority: true,
      decidedAt: '2026-09-13T11:58:00.000Z',
    }),
  ];
  assert.equal(evaluateCg4Quorum(requirement, ackWithinWindow, false, NOW).status, 'MET');

  const lateActivation = [
    {
      ...activationOnly[0],
      decidedAt: '2026-09-13T11:40:00.000Z',
    },
  ];
  assert.equal(
    evaluateCg4Quorum(requirement, lateActivation, false, NOW).status,
    'EMERGENCY_ACK_EXPIRED',
  );
});

function delegationInput(
  overrides: Partial<Parameters<typeof assertCg4DelegationGrantAllowed>[0]> = {},
) {
  return {
    capability: 'cg.exception.request' as const,
    delegatorSubjectId: 'delegator-1',
    delegateSubjectId: 'delegate-1',
    delegatorHoldsCapabilityDirectly: true,
    delegateIsServicePrincipal: false,
    startsAt: new Date('2026-09-13T00:00:00.000Z'),
    expiresAt: new Date('2026-09-13T04:00:00.000Z'),
    ...overrides,
  };
}

test('assertCg4DelegationGrantAllowed: allows only cg.exception.request/approve.standard, rejects HIGH/policy capabilities', () => {
  assert.doesNotThrow(() => assertCg4DelegationGrantAllowed(delegationInput()));
  assert.doesNotThrow(() =>
    assertCg4DelegationGrantAllowed(
      delegationInput({ capability: 'cg.exception.approve.standard' }),
    ),
  );
  assert.throws(
    () =>
      assertCg4DelegationGrantAllowed(delegationInput({ capability: 'cg.exception.approve.high' })),
    Cg4DelegationNotAllowedError,
  );
  assert.throws(
    () => assertCg4DelegationGrantAllowed(delegationInput({ capability: 'cg.policy.publish' })),
    Cg4DelegationNotAllowedError,
  );
});

test('assertCg4DelegationGrantAllowed: rejects self-delegation, sub-delegation (recursive), a service/shared delegate and a window over 8 hours', () => {
  assert.throws(
    () =>
      assertCg4DelegationGrantAllowed(
        delegationInput({ delegatorSubjectId: 'same', delegateSubjectId: 'same' }),
      ),
    Cg4DelegationNotAllowedError,
  );
  assert.throws(
    () =>
      assertCg4DelegationGrantAllowed(delegationInput({ delegatorHoldsCapabilityDirectly: false })),
    Cg4DelegationNotAllowedError,
  );
  assert.throws(
    () => assertCg4DelegationGrantAllowed(delegationInput({ delegateIsServicePrincipal: true })),
    Cg4DelegationNotAllowedError,
  );
  assert.throws(
    () =>
      assertCg4DelegationGrantAllowed(
        delegationInput({ expiresAt: new Date('2026-09-13T09:00:00.000Z') }),
      ),
    Cg4DelegationNotAllowedError,
  );
});

test('assertCg4QuorumMet: rejects finalize when the quorum is not met (insufficient quorum fails closed)', () => {
  const pending = evaluateCg4Quorum(resolveCg4ExceptionQuorum('STANDARD'), [], false, NOW);
  assert.throws(() => assertCg4QuorumMet(pending), Cg4QuorumNotMetError);
  const met = evaluateCg4Quorum(resolveCg4ExceptionQuorum('STANDARD'), [approval()], false, NOW);
  assert.doesNotThrow(() => assertCg4QuorumMet(met));
});
