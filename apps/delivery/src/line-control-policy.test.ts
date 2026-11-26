/**
 * S2.3 (#367): the control plane decision table checked against #358 item by item
 *
 * This suite has no database and no I/O — it checks that the "rules" match the decisions, while enforcement of the rules
 * on real Postgres lives in `line-control-plane.integration.ts`
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LINE_PILOT_CAPS,
  LINE_ROLLOUT_STATES,
  type LineProviderOutcomeCode,
  type LineRolloutState,
} from '@d-contact/cxa-contracts';
import {
  LINE_CONTROL_ACTIONS,
  LINE_CONTROL_ACTOR_ROLES,
  LINE_CONTROL_AUTHORITY,
  LINE_CONTROL_SIGNALS,
  LINE_PILOT_DELIVERY_CAPS,
  LINE_PROVIDER_OPERATIONS,
  LINE_QUOTA_SNAPSHOT_MAX_AGE_MS,
  LineControlAuthorizationError,
  allowsOperation,
  assertControlAuthority,
  automaticKillReasonFor,
  evaluateQuotaAdvisory,
  isLowering,
  isSingleStepAdvance,
  killSignalForOutcome,
  lineCapLimits,
  lineDeliveryCapsFor,
  lineRunExpiry,
  lineRunProposalDigest,
  mayPerform,
  needsProviderCredential,
  operatorKillReasonFor,
  type LineControlActorRole,
  type LineProviderOperation,
  type LineRunProposalDigestInput,
} from './line-control-policy.js';

const T0 = new Date('2026-09-22T10:00:00.000Z');

// ── Authority matrix (#358 §E) ───────────────────────────────────────────────

test('authority: proposer, approver and switch opener are kept separate per #358 §E', () => {
  assert.deepEqual(LINE_CONTROL_AUTHORITY.PROPOSE_RUN, ['PLATFORM_OPERATOR']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.APPROVE_RUN_TENANT_ADMIN, ['TENANT_ADMIN']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.APPROVE_RUN_COMPLIANCE, ['COMPLIANCE']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.EXECUTE_RUN, ['PLATFORM_OPERATOR']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.SET_TECHNICAL_SWITCH, ['PLATFORM_OPERATOR']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.ADVANCE_STATE, ['COMPLIANCE']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.CLEAR_KILL, ['COMPLIANCE']);

  // Anyone who can execute/propose must never be able to approve their own run, by any route
  assert.equal(mayPerform('PLATFORM_OPERATOR', 'APPROVE_RUN_TENANT_ADMIN'), false);
  assert.equal(mayPerform('PLATFORM_OPERATOR', 'APPROVE_RUN_COMPLIANCE'), false);
  assert.equal(mayPerform('TENANT_ADMIN', 'SET_TECHNICAL_SWITCH'), false);
  assert.equal(mayPerform('TENANT_ADMIN', 'ADVANCE_STATE'), false);
});

test('authority: every action has an owner, and SYSTEM can do only automatic kill', () => {
  for (const action of LINE_CONTROL_ACTIONS) {
    const roles = LINE_CONTROL_AUTHORITY[action];
    assert.ok(roles.length > 0, action);
    for (const role of roles) assert.ok(LINE_CONTROL_ACTOR_ROLES.includes(role), role);
  }
  const systemActions = LINE_CONTROL_ACTIONS.filter((action) => mayPerform('SYSTEM', action));
  assert.deepEqual(systemActions, ['KILL']);
});

test('authority: a role without permission gets one fixed error code', () => {
  assert.throws(
    () => assertControlAuthority('SYSTEM', 'ADVANCE_STATE'),
    (error: unknown) => {
      assert.ok(error instanceof LineControlAuthorizationError, String(error));
      assert.equal(error.code, 'LINE_GATE_AUTHORIZATION_DENIED');
      assert.equal(error.action, 'ADVANCE_STATE');
      return true;
    },
  );
  assert.doesNotThrow(() => assertControlAuthority('COMPLIANCE', 'ADVANCE_STATE'));
});

// ── Business state → operation (#358 §A) ─────────────────────────────────────

test('rollout state: DRY_RUN has no network, PROVIDER_CONFORMANCE still must not push', () => {
  const allowed = (state: LineRolloutState): LineProviderOperation[] =>
    LINE_PROVIDER_OPERATIONS.filter((operation) => allowsOperation(state, operation));

  assert.deepEqual(allowed('DISABLED'), []);
  assert.deepEqual(allowed('DRY_RUN'), ['LOCAL_VALIDATION']);
  assert.deepEqual(allowed('PROVIDER_CONFORMANCE'), [
    'LOCAL_VALIDATION',
    'TOKEN_VERIFY',
    'QUOTA_READ',
    'MESSAGE_VALIDATE',
    'WEBHOOK_TEST',
  ]);
  assert.deepEqual(allowed('CAPPED_PILOT'), [...LINE_PROVIDER_OPERATIONS]);
});

test('rollout state: only LOCAL_VALIDATION needs no credential/quota', () => {
  assert.equal(needsProviderCredential('LOCAL_VALIDATION'), false);
  for (const operation of LINE_PROVIDER_OPERATIONS) {
    if (operation === 'LOCAL_VALIDATION') continue;
    assert.equal(needsProviderCredential(operation), true, operation);
  }
});

test('rollout state: advances one step at a time, but can be lowered across steps immediately', () => {
  assert.equal(isSingleStepAdvance('DISABLED', 'DRY_RUN'), true);
  assert.equal(isSingleStepAdvance('DRY_RUN', 'CAPPED_PILOT'), false);
  assert.equal(isSingleStepAdvance('DISABLED', 'DISABLED'), false);
  assert.equal(isLowering('CAPPED_PILOT', 'DISABLED'), true);
  assert.equal(isLowering('DRY_RUN', 'CAPPED_PILOT'), false);
  assert.deepEqual(
    [...LINE_ROLLOUT_STATES],
    ['DISABLED', 'DRY_RUN', 'PROVIDER_CONFORMANCE', 'CAPPED_PILOT'],
  );
});

// ── Cap profile (#358 §C) ────────────────────────────────────────────────────

test('cap: a logical delivery must pass all four limit dimensions of the profile', () => {
  const limits = lineCapLimits({ capKind: 'LOGICAL_DELIVERY', at: T0 });
  assert.equal(limits.length, 4);
  const byCode = Object.fromEntries(limits.map((limit) => [limit.code, limit]));

  assert.equal(byCode.RUN_DELIVERY_CAP_EXCEEDED?.max, LINE_PILOT_CAPS.logicalDeliveriesPerRun);
  assert.equal(byCode.RUN_DELIVERY_CAP_EXCEEDED?.sameRun, true);

  assert.equal(
    byCode.CONTACT_WINDOW_CAP_EXCEEDED?.max,
    LINE_PILOT_CAPS.logicalDeliveriesPerRecipientPer24h,
  );
  assert.equal(byCode.CONTACT_WINDOW_CAP_EXCEEDED?.sameRecipient, true);
  assert.equal(
    byCode.CONTACT_WINDOW_CAP_EXCEEDED?.since?.getTime(),
    T0.getTime() - 24 * 60 * 60_000,
  );

  assert.equal(byCode.SUBMISSION_WINDOW_CAP_EXCEEDED?.max, LINE_PILOT_CAPS.logicalDeliveriesPer24h);
  assert.equal(byCode.SUBMISSION_WINDOW_CAP_EXCEEDED?.sameRecipient, undefined);

  // lifetime has no time window — counts every row of the profile
  assert.equal(byCode.LIFETIME_CAP_EXCEEDED?.max, LINE_PILOT_CAPS.logicalDeliveriesLifetime);
  assert.equal(byCode.LIFETIME_CAP_EXCEEDED?.since, undefined);
  for (const limit of limits) assert.equal(limit.capKind, 'LOGICAL_DELIVERY');
});

test('cap: concurrency counts only slots still held, and attempts are counted per single delivery', () => {
  const [submission] = lineCapLimits({ capKind: 'CONCURRENT_SUBMISSION', at: T0 });
  assert.equal(submission?.max, LINE_PILOT_CAPS.concurrentSubmissions);
  assert.equal(submission?.activeOnly, true);

  const [unknown] = lineCapLimits({ capKind: 'CONCURRENT_UNKNOWN', at: T0 });
  assert.equal(unknown?.max, LINE_PILOT_CAPS.concurrentUnknownReconciling);
  assert.equal(unknown?.activeOnly, true);

  const [attempt] = lineCapLimits({ capKind: 'PROVIDER_ATTEMPT', at: T0 });
  assert.equal(attempt?.max, LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery);
  assert.equal(attempt?.sameDelivery, true);
});

test('cap: a run can lower provider attempts but cannot ask for more than the profile', () => {
  const lowered = lineCapLimits({
    capKind: 'PROVIDER_ATTEMPT',
    at: T0,
    runCapProviderAttempts: 2,
  });
  assert.equal(lowered[0]?.max, 2);
  const raised = lineCapLimits({
    capKind: 'PROVIDER_ATTEMPT',
    at: T0,
    runCapProviderAttempts: 99,
  });
  assert.equal(raised[0]?.max, LINE_PILOT_CAPS.providerAttemptsPerLogicalDelivery);
});

// ── Immutable proposal (#358 §E) ─────────────────────────────────────────────

const proposal: LineRunProposalDigestInput = {
  tenantId: '2b0f0e6e-0000-4000-8000-000000000001',
  gateId: '2b0f0e6e-0000-4000-8000-000000000002',
  channelAccountId: '2007056595',
  senderIdentityId: 'sender-approved-test-only',
  purpose: 'SERVICE_NOTIFICATION',
  contactKind: 'SERVICE',
  allowlistEntryId: '2b0f0e6e-0000-4000-8000-000000000003',
  recipientFingerprint: 'a'.repeat(64),
  contentDigest: 'b'.repeat(64),
  configDigest: 'c'.repeat(64),
  credentialRefId: '2b0f0e6e-0000-4000-8000-000000000004',
  credentialVersion: 3,
  capLogicalDeliveries: 1,
  capProviderAttempts: 4,
  proposedBy: 'platform-operator-1',
  proposalRef: 'run-2026-09-22-01',
  proposedAt: T0,
  expiresAt: lineRunExpiry(T0),
};

test('proposal digest: deterministic and sensitive to every dimension the approver sees', () => {
  const baseline = lineRunProposalDigest(proposal);
  assert.match(baseline, /^[a-f0-9]{64}$/);
  assert.equal(lineRunProposalDigest({ ...proposal }), baseline);

  const mutations: Array<Partial<LineRunProposalDigestInput>> = [
    { recipientFingerprint: 'd'.repeat(64) },
    { contentDigest: 'd'.repeat(64) },
    { configDigest: 'd'.repeat(64) },
    { credentialVersion: 4 },
    { capProviderAttempts: 3 },
    { proposedBy: 'platform-operator-2' },
    { proposalRef: 'run-2026-09-22-02' },
    { expiresAt: new Date(T0.getTime() + 60_000) },
    { senderIdentityId: 'sender-other' },
  ];
  for (const mutation of mutations) {
    assert.notEqual(
      lineRunProposalDigest({ ...proposal, ...mutation }),
      baseline,
      JSON.stringify(mutation),
    );
  }
});

test('proposal TTL: 30 minutes per the profile', () => {
  assert.equal(
    lineRunExpiry(T0).getTime() - T0.getTime(),
    LINE_PILOT_CAPS.runAuthorizationTtlMinutes * 60_000,
  );
});

// ── Quota advisory (#358 §D) ─────────────────────────────────────────────────

test('quota: no snapshot, a stale snapshot, or an unreadable ceiling = entirely unusable', () => {
  assert.equal(evaluateQuotaAdvisory(undefined, T0), 'UNAVAILABLE');
  assert.equal(
    evaluateQuotaAdvisory(
      { type: 'limited', targetLimit: 500, totalUsage: 0, observedAt: T0 },
      new Date(T0.getTime() + LINE_QUOTA_SNAPSHOT_MAX_AGE_MS + 1),
    ),
    'STALE',
  );
  // A snapshot "from the future" is clock skew — it cannot be used for decisions either
  assert.equal(
    evaluateQuotaAdvisory(
      { type: 'limited', targetLimit: 500, totalUsage: 0, observedAt: new Date(T0.getTime() + 1) },
      T0,
    ),
    'STALE',
  );
  assert.equal(
    evaluateQuotaAdvisory({ type: 'limited', totalUsage: 0, observedAt: T0 }, T0),
    'UNAVAILABLE',
  );
});

test('quota: not enough left for a single run = EXHAUSTED, unlimited = OK', () => {
  assert.equal(
    evaluateQuotaAdvisory(
      { type: 'limited', targetLimit: 200, totalUsage: 200, observedAt: T0 },
      T0,
    ),
    'EXHAUSTED',
  );
  assert.equal(
    evaluateQuotaAdvisory(
      { type: 'limited', targetLimit: 200, totalUsage: 199, observedAt: T0 },
      T0,
    ),
    'OK',
  );
  assert.equal(
    evaluateQuotaAdvisory({ type: 'none', totalUsage: 10_000, observedAt: T0 }, T0),
    'OK',
  );
});

// ── Automatic kill (#358 §F) ─────────────────────────────────────────────────

test('kill: every automatic signal has its own reason in the same vocabulary', () => {
  for (const signal of LINE_CONTROL_SIGNALS) {
    assert.equal(automaticKillReasonFor(signal), signal);
  }
  assert.equal(LINE_CONTROL_SIGNALS.length, 11);
});

test('kill: human reasons are split by role and the outcomes that must close a scope number three', () => {
  const roles: LineControlActorRole[] = ['PLATFORM_OPERATOR', 'TENANT_ADMIN', 'SYSTEM'];
  for (const role of roles) assert.equal(operatorKillReasonFor(role), 'OPERATOR_KILL');
  assert.equal(operatorKillReasonFor('COMPLIANCE'), 'COMPLIANCE_KILL');

  assert.equal(killSignalForOutcome('LINE_AUTH_INVALID'), 'AUTH_FAILURE');
  assert.equal(killSignalForOutcome('LINE_MONTHLY_QUOTA_EXHAUSTED'), 'QUOTA_EXHAUSTED');
  assert.equal(killSignalForOutcome('LINE_RETRY_WINDOW_EXPIRED'), 'UNKNOWN_OUTCOME_EXPIRED');
  const notKilling: LineProviderOutcomeCode[] = [
    'LINE_ACCEPTED',
    'LINE_ACCEPTED_REPLAY',
    'LINE_REQUEST_REJECTED',
    'LINE_RATE_LIMITED',
    'LINE_PROVIDER_UNAVAILABLE',
    'LINE_UNKNOWN_OUTCOME',
    'LINE_RESPONSE_INVALID',
  ];
  for (const code of notKilling) assert.equal(killSignalForOutcome(code), undefined, code);
});

test('#567 the trial cap comes from the authorization row but not above the ceiling, and S2 always uses constants', () => {
  assert.deepEqual(
    lineDeliveryCapsFor({
      profile: 'S2_LINE_LOCAL_PILOT_V1',
      capLogicalDeliveries: 99,
      capRecipientPer24h: 99,
      capPer24h: 99,
      capLifetime: 99,
    }),
    LINE_PILOT_DELIVERY_CAPS,
  );
  assert.deepEqual(
    lineDeliveryCapsFor({
      profile: 'S2_LINE_TEAM_TRIAL_V1',
      capLogicalDeliveries: 10_000,
      capRecipientPer24h: 25,
      capPer24h: 7,
      capLifetime: null,
    }),
    { perRun: 600, perRecipientPer24h: 20, per24h: 7, lifetime: 0 },
  );
  const limits = lineCapLimits({
    capKind: 'LOGICAL_DELIVERY',
    at: new Date('2026-10-01T00:00:00.000Z'),
    deliveryCaps: { perRun: 600, perRecipientPer24h: 20, per24h: 100, lifetime: 3000 },
  });
  assert.deepEqual(
    limits.map((limit) => limit.max),
    [600, 20, 100, 3000],
  );
});

test('#567 the S2 digest does not change when there is no trial, and a trial gets a different digest per cap', () => {
  const input = {
    tenantId: 't',
    gateId: 'g',
    channelAccountId: 'c',
    senderIdentityId: 's',
    purpose: 'p',
    contactKind: 'k',
    allowlistEntryId: 'a',
    recipientFingerprint: 'r',
    contentDigest: 'd',
    configDigest: 'f',
    credentialRefId: 'cr',
    credentialVersion: 1,
    capLogicalDeliveries: 1,
    capProviderAttempts: 4,
    proposedBy: 'op',
    proposalRef: 'ref',
    proposedAt: new Date('2026-10-01T00:00:00.000Z'),
    expiresAt: new Date('2026-10-01T00:30:00.000Z'),
  };
  // Constants from main before #567 — the digest of an already approved proposal must match byte for byte
  assert.equal(
    lineRunProposalDigest(input),
    'c349bf4547c33616d571fe3210d50dbc57b4117968ff275f80d5d3cf45c4b724',
  );
  const trial = {
    trialRef: 'trial-x',
    capRecipientPer24h: 20,
    capPer24h: 100,
    capLifetime: 3000,
    contactId: 'contact',
    identityId: null,
  };
  const withTrial = lineRunProposalDigest({ ...input, trial });
  assert.notEqual(withTrial, lineRunProposalDigest(input));
  assert.notEqual(
    withTrial,
    lineRunProposalDigest({ ...input, trial: { ...trial, capPer24h: 99 } }),
  );
});

test('#567 a Tenant Admin can kill but cannot lift a kill', () => {
  assert.equal(mayPerform('TENANT_ADMIN', 'KILL'), true);
  assert.equal(mayPerform('TENANT_ADMIN', 'CLEAR_KILL'), false);
  assert.equal(operatorKillReasonFor('TENANT_ADMIN'), 'OPERATOR_KILL');
});
