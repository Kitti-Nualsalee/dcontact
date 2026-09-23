/**
 * S2.3 (#367): ตารางตัดสินใจของ control plane เทียบกับ #358 ทีละข้อ
 *
 * เทสต์ชุดนี้ไม่มี database และไม่มี I/O — ตรวจว่า "กฎ" ตรงกับคำตัดสิน ส่วนการบังคับใช้กฎ
 * บน Postgres จริงอยู่ใน `line-control-plane.integration.ts`
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

test('authority: แยกผู้เสนอ ผู้อนุมัติ และผู้เปิด switch ออกจากกันตาม #358 §E', () => {
  assert.deepEqual(LINE_CONTROL_AUTHORITY.PROPOSE_RUN, ['PLATFORM_OPERATOR']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.APPROVE_RUN_TENANT_ADMIN, ['TENANT_ADMIN']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.APPROVE_RUN_COMPLIANCE, ['COMPLIANCE']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.EXECUTE_RUN, ['PLATFORM_OPERATOR']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.SET_TECHNICAL_SWITCH, ['PLATFORM_OPERATOR']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.ADVANCE_STATE, ['COMPLIANCE']);
  assert.deepEqual(LINE_CONTROL_AUTHORITY.CLEAR_KILL, ['COMPLIANCE']);

  // ผู้ที่ execute/propose ได้ ต้องอนุมัติ run ของตัวเองไม่ได้เลยในทุกทาง
  assert.equal(mayPerform('PLATFORM_OPERATOR', 'APPROVE_RUN_TENANT_ADMIN'), false);
  assert.equal(mayPerform('PLATFORM_OPERATOR', 'APPROVE_RUN_COMPLIANCE'), false);
  assert.equal(mayPerform('TENANT_ADMIN', 'SET_TECHNICAL_SWITCH'), false);
  assert.equal(mayPerform('TENANT_ADMIN', 'ADVANCE_STATE'), false);
});

test('authority: ทุก action มีเจ้าของ และ SYSTEM ทำได้เฉพาะ kill อัตโนมัติ', () => {
  for (const action of LINE_CONTROL_ACTIONS) {
    const roles = LINE_CONTROL_AUTHORITY[action];
    assert.ok(roles.length > 0, action);
    for (const role of roles) assert.ok(LINE_CONTROL_ACTOR_ROLES.includes(role), role);
  }
  const systemActions = LINE_CONTROL_ACTIONS.filter((action) => mayPerform('SYSTEM', action));
  assert.deepEqual(systemActions, ['KILL']);
});

test('authority: role ที่ไม่มีสิทธิ์ได้ error code เดียวคงที่', () => {
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

test('rollout state: DRY_RUN ไม่มี network, PROVIDER_CONFORMANCE ยังห้าม push', () => {
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

test('rollout state: เฉพาะ LOCAL_VALIDATION ที่ไม่ต้องใช้ credential/quota', () => {
  assert.equal(needsProviderCredential('LOCAL_VALIDATION'), false);
  for (const operation of LINE_PROVIDER_OPERATIONS) {
    if (operation === 'LOCAL_VALIDATION') continue;
    assert.equal(needsProviderCredential(operation), true, operation);
  }
});

test('rollout state: เลื่อนขึ้นทีละขั้น แต่ลดลงข้ามขั้นได้ทันที', () => {
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

test('cap: logical delivery ต้องส่ง limit ครบสี่มิติของ profile', () => {
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

  // lifetime ไม่มีหน้าต่างเวลา — นับทุกแถวของ profile
  assert.equal(byCode.LIFETIME_CAP_EXCEEDED?.max, LINE_PILOT_CAPS.logicalDeliveriesLifetime);
  assert.equal(byCode.LIFETIME_CAP_EXCEEDED?.since, undefined);
  for (const limit of limits) assert.equal(limit.capKind, 'LOGICAL_DELIVERY');
});

test('cap: concurrency นับเฉพาะ slot ที่ยังถืออยู่ และ attempt นับต่อ delivery เดียว', () => {
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

test('cap: run ลด provider attempt ได้ แต่ขอเกิน profile ไม่ได้', () => {
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

test('proposal digest: deterministic และไวต่อทุกมิติที่ผู้อนุมัติเห็น', () => {
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

test('proposal TTL: 30 นาทีตาม profile', () => {
  assert.equal(
    lineRunExpiry(T0).getTime() - T0.getTime(),
    LINE_PILOT_CAPS.runAuthorizationTtlMinutes * 60_000,
  );
});

// ── Quota advisory (#358 §D) ─────────────────────────────────────────────────

test('quota: ไม่มี snapshot, snapshot เก่า หรืออ่านเพดานไม่ได้ = ใช้ไม่ได้ทั้งหมด', () => {
  assert.equal(evaluateQuotaAdvisory(undefined, T0), 'UNAVAILABLE');
  assert.equal(
    evaluateQuotaAdvisory(
      { type: 'limited', targetLimit: 500, totalUsage: 0, observedAt: T0 },
      new Date(T0.getTime() + LINE_QUOTA_SNAPSHOT_MAX_AGE_MS + 1),
    ),
    'STALE',
  );
  // snapshot ที่ "มาจากอนาคต" คือ clock skew — ใช้ตัดสินใจไม่ได้เช่นกัน
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

test('quota: เหลือไม่พอสำหรับ run เดียว = EXHAUSTED, ไม่จำกัด = OK', () => {
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

test('kill: ทุกสัญญาณอัตโนมัติมี reason ของตัวเองใน vocabulary เดียวกัน', () => {
  for (const signal of LINE_CONTROL_SIGNALS) {
    assert.equal(automaticKillReasonFor(signal), signal);
  }
  assert.equal(LINE_CONTROL_SIGNALS.length, 11);
});

test('kill: reason ของคนแยกตาม role และ outcome ที่ต้องปิด scope มีสามตัว', () => {
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
