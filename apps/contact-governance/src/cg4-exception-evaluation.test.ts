import assert from 'node:assert/strict';
import test from 'node:test';
import {
  resolveCg4EffectiveState,
  resolveCg4ExceptionCoverage,
  type Cg4ExceptionFacts,
  type Cg4ExceptionMatchContext,
} from './cg4-exception-evaluation.js';

const NOW = new Date('2026-09-13T12:00:00.000Z');
const DIGEST = 'a'.repeat(64);

function facts(overrides: Partial<Cg4ExceptionFacts> = {}): Cg4ExceptionFacts {
  return {
    seriesId: 'series-1',
    revisionId: 'revision-1',
    revision: 1,
    workflowState: 'APPROVED',
    identityId: 'identity-1',
    scopeKind: 'EXACT_IDENTITY',
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    sourceType: 'DIALER',
    sourceId: 'source-1',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: 'policy-1',
    policyVersionId: 'policy-version-1',
    policyVersion: 1,
    policyContentDigest: DIGEST,
    currentPolicyContentDigest: DIGEST,
    policyAllowedRuleCodes: ['QUIET_HOURS', 'MIN_GAP'],
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: new Date('2026-09-13T11:00:00.000Z'),
    expiresAt: new Date('2026-09-13T13:00:00.000Z'),
    tier: 'STANDARD',
    contentDigest: 'b'.repeat(64),
    approvalDigest: 'c'.repeat(64),
    ...overrides,
  };
}

function context(overrides: Partial<Cg4ExceptionMatchContext> = {}): Cg4ExceptionMatchContext {
  return {
    identityId: 'identity-1',
    channel: 'LINE',
    purpose: 'SERVICE_NOTIFICATION',
    source: 'DIALER',
    sourceId: 'source-1',
    now: NOW,
    ...overrides,
  };
}

function coverage(
  exception: Partial<Cg4ExceptionFacts> = {},
  ctx: Partial<Cg4ExceptionMatchContext> = {},
  reasonCode = 'QUIET_HOURS',
) {
  return resolveCg4ExceptionCoverage({
    exceptions: [facts(exception)],
    context: context(ctx),
    reasonCode,
  });
}

test('effective state uses database time and expiresAt as an exclusive boundary', () => {
  const window = {
    startsAt: new Date('2026-09-13T11:00:00.000Z'),
    expiresAt: new Date('2026-09-13T13:00:00.000Z'),
  };
  assert.equal(
    resolveCg4EffectiveState({
      workflowState: 'APPROVED',
      ...window,
      now: new Date('2026-09-13T10:59:59.999Z'),
    }),
    'SCHEDULED',
  );
  assert.equal(
    resolveCg4EffectiveState({ workflowState: 'APPROVED', ...window, now: window.startsAt }),
    'ACTIVE',
  );
  assert.equal(
    resolveCg4EffectiveState({
      workflowState: 'APPROVED',
      ...window,
      now: new Date('2026-09-13T12:59:59.999Z'),
    }),
    'ACTIVE',
  );
  // now === expiresAt can no longer be used
  assert.equal(
    resolveCg4EffectiveState({ workflowState: 'APPROVED', ...window, now: window.expiresAt }),
    'EXPIRED',
  );
});

test('a workflow state other than APPROVED is always INACTIVE, even within the time range', () => {
  const window = {
    startsAt: new Date('2026-09-13T11:00:00.000Z'),
    expiresAt: new Date('2026-09-13T13:00:00.000Z'),
    now: NOW,
  };
  for (const workflowState of ['PENDING', 'REJECTED', 'CANCELLED', 'REVOKED'] as const) {
    assert.equal(resolveCg4EffectiveState({ workflowState, ...window }), 'INACTIVE', workflowState);
  }
});

test('an exception that matches every dimension exactly can lift a provisional rule, and returns a pin for the trace', () => {
  const result = coverage();
  assert.equal(result.covered, true);
  assert.ok(result.covered);
  assert.deepEqual(result.pin, {
    seriesId: 'series-1',
    revisionId: 'revision-1',
    version: 1,
    contentDigest: 'b'.repeat(64),
    approvalDigest: 'c'.repeat(64),
    matchedRuleCode: 'QUIET_HOURS',
  });
});

test('a scope that differs in even one dimension does not lift a rule (no wildcard/nearest match)', () => {
  assert.equal(coverage({}, { channel: 'EMAIL' }).covered, false);
  assert.equal(coverage({}, { purpose: 'MARKETING' }).covered, false);
  assert.equal(coverage({}, { source: 'JOURNEY' }).covered, false);
  assert.equal(coverage({}, { sourceId: 'source-2' }).covered, false);
  assert.equal(coverage({}, { identityId: 'identity-2' }).covered, false);
  assert.equal(coverage({}, { identityId: undefined }).covered, false);
});

test('CONTACT_WIDE covers every identity but EXACT_IDENTITY must match exactly', () => {
  const contactWide = {
    scopeKind: 'CONTACT_WIDE' as const,
    identityId: null,
    tier: 'HIGH' as const,
  };
  assert.equal(coverage(contactWide, { identityId: 'identity-9' }).covered, true);
  assert.equal(coverage(contactWide, { identityId: undefined }).covered, true);
  // an exception declared CONTACT_WIDE but still bound to an identity counts as not matching (never interpret null itself)
  assert.equal(
    coverage({ scopeKind: 'CONTACT_WIDE', identityId: 'identity-1' }, {}).covered,
    false,
  );
});

test('a rule not in the exception allowedRuleCodes is not lifted', () => {
  const result = coverage({}, {}, 'TENANT_HOLIDAY');
  assert.equal(result.covered, false);
  assert.ok(!result.covered);
  assert.equal(result.reason, 'RULE_NOT_COVERED');
});

test('a non-overridable rule is not lifted even if the exception lists it', () => {
  const result = coverage(
    { allowedRuleCodes: ['DNC_GLOBAL'], policyAllowedRuleCodes: ['DNC_GLOBAL'] },
    {},
    'DNC_GLOBAL',
  );
  assert.equal(result.covered, false);
  assert.ok(!result.covered);
  assert.equal(result.reason, 'RULE_NOT_OVERRIDABLE');
});

test('a rule that the pinned policy version does not allow is not lifted', () => {
  const result = coverage({ policyAllowedRuleCodes: ['MIN_GAP'] });
  assert.equal(result.covered, false);
  assert.ok(!result.covered);
  assert.equal(result.reason, 'RULE_NOT_OVERRIDABLE');
});

test('a drifted policy digest or a missing policy makes it fail closed', () => {
  const drifted = coverage({ currentPolicyContentDigest: 'd'.repeat(64) });
  assert.ok(!drifted.covered);
  assert.equal(drifted.reason, 'POLICY_BINDING_STALE');

  const missing = coverage({ currentPolicyContentDigest: null });
  assert.ok(!missing.covered);
  assert.equal(missing.reason, 'POLICY_BINDING_STALE');
});

test('a registry version that does not match the current evaluator makes it fail closed', () => {
  const result = coverage({ registryVersion: 'CG4_RULE_REGISTRY_V0' });
  assert.ok(!result.covered);
  assert.equal(result.reason, 'REGISTRY_VERSION_STALE');
});

test('an exception that has not started/has expired/was revoked does not lift a rule', () => {
  const scheduled = coverage({
    startsAt: new Date('2026-09-13T13:00:00.000Z'),
    expiresAt: new Date('2026-09-13T14:00:00.000Z'),
  });
  assert.ok(!scheduled.covered);
  assert.equal(scheduled.reason, 'NOT_ACTIVE');

  const expired = coverage({
    startsAt: new Date('2026-09-13T09:00:00.000Z'),
    expiresAt: new Date('2026-09-13T11:00:00.000Z'),
  });
  assert.ok(!expired.covered);
  assert.equal(expired.reason, 'NOT_ACTIVE');

  const revoked = coverage({ workflowState: 'REVOKED' });
  assert.ok(!revoked.covered);
  assert.equal(revoked.reason, 'NOT_ACTIVE');
});

test('picks the first exception that matches in the order the caller sent (deterministic)', () => {
  const result = resolveCg4ExceptionCoverage({
    exceptions: [
      facts({ seriesId: 'series-expired', workflowState: 'REVOKED' }),
      facts({ seriesId: 'series-match', revisionId: 'revision-match' }),
      facts({ seriesId: 'series-later', revisionId: 'revision-later' }),
    ],
    context: context(),
    reasonCode: 'QUIET_HOURS',
  });
  assert.ok(result.covered);
  assert.equal(result.exception.seriesId, 'series-match');
  assert.equal(result.pin.revisionId, 'revision-match');
});

test('no exception at all returns RULE_NOT_COVERED without throwing', () => {
  const result = resolveCg4ExceptionCoverage({
    exceptions: [],
    context: context(),
    reasonCode: 'QUIET_HOURS',
  });
  assert.equal(result.covered, false);
});
