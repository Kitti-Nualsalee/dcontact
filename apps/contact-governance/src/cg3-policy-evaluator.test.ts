import assert from 'node:assert/strict';
import test from 'node:test';
import {
  evaluateCg3Policy,
  resolveEffectivePreference,
  zonedPartsAt,
  zonedToUtc,
  type Cg3EvaluationInput,
  type Cg3PreferenceCandidate,
} from './cg3-policy-evaluator.js';
import type { Cg4ExceptionFacts } from './cg4-exception-evaluation.js';

function preference(overrides: Partial<Cg3PreferenceCandidate> = {}): Cg3PreferenceCandidate {
  return {
    version: 1,
    identityId: null,
    channel: null,
    purpose: null,
    contactKind: null,
    decision: 'ALLOW',
    timezone: null,
    preferredWindows: [],
    ...overrides,
  };
}

function baseInput(overrides: Partial<Cg3EvaluationInput> = {}): Cg3EvaluationInput {
  return {
    now: new Date('2026-09-15T10:00:00.000Z'), // Tuesday
    channel: 'LINE',
    purpose: 'MARKETING',
    preferences: [],
    ...overrides,
  };
}

// ---- Preference gate: subset containment + restrictive tie-break (#101 §1) ----

test('preference: ไม่มี record ให้ PASS แล้วเดินต่อ (ไม่ใช่ implicit ALLOW)', () => {
  const result = evaluateCg3Policy(baseInput());
  assert.equal(result.decision, undefined);
  assert.equal(result.trace.find((entry) => entry.gate === 'PREFERENCE')?.outcome, 'PASS');
});

test('preference: identity-specific ALLOW ชนะ contact-level default BLOCK', () => {
  const input = baseInput({
    identityId: 'identity-1',
    preferences: [
      preference({ version: 1, decision: 'BLOCK' }), // contact-level default: ปิด marketing
      preference({ version: 2, identityId: 'identity-1', channel: 'LINE', decision: 'ALLOW' }),
    ],
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, undefined);
  assert.equal(result.preferenceVersion, 2);
});

test('preference: ปิด LINE marketing แต่ SERVICE_NOTIFICATION channel เดียวกันยังผ่าน', () => {
  const blockLineMarketing = preference({
    channel: 'LINE',
    purpose: 'MARKETING',
    decision: 'BLOCK',
  });
  const marketingResult = evaluateCg3Policy(
    baseInput({ channel: 'LINE', purpose: 'MARKETING', preferences: [blockLineMarketing] }),
  );
  const serviceResult = evaluateCg3Policy(
    baseInput({
      channel: 'LINE',
      purpose: 'SERVICE_NOTIFICATION',
      preferences: [blockLineMarketing],
    }),
  );
  assert.equal(marketingResult.decision, 'BLOCK');
  assert.equal(marketingResult.reasonCode, 'PREFERENCE_BLOCKED');
  assert.equal(serviceResult.decision, undefined);
});

test('preference: specificity เท่ากันและไม่ subset กัน ใช้ restrictive tie-break BLOCK>DEFER>ALLOW', () => {
  const input = baseInput({
    channel: 'LINE',
    purpose: 'MARKETING',
    preferences: [
      preference({ channel: 'LINE', decision: 'ALLOW' }),
      preference({ purpose: 'MARKETING', decision: 'BLOCK' }),
    ],
  });
  const winner = resolveEffectivePreference(input.preferences, input);
  assert.equal(winner?.decision, 'BLOCK');
});

test('preference: record ที่ effective window ไม่ครอบคลุมไม่ถูกส่งเข้ามาเลยไม่ถูกนับ (caller filter)', () => {
  // evaluator รับเฉพาะ candidate ที่ caller (fact loader) กรอง effective window มาแล้ว
  const result = evaluateCg3Policy(baseInput({ preferences: [] }));
  assert.equal(result.decision, undefined);
});

// ---- Temporal policy: quiet hours / preferred windows / holiday / timezone ----

test('temporal: ไม่มี constraint เลยให้ PASS โดยไม่ต้อง resolve timezone', () => {
  const result = evaluateCg3Policy(baseInput());
  assert.equal(result.trace.find((entry) => entry.gate === 'TEMPORAL_POLICY')?.outcome, 'PASS');
});

test('temporal: timezone unknown ทั้งที่มี constraint ให้ DEFER/TIMEZONE_UNKNOWN โดยไม่มี nextEligibleAt', () => {
  const input = baseInput({
    preferences: [
      preference({
        decision: 'ALLOW',
        preferredWindows: [{ daysOfWeek: [1], startLocal: '09:00', endLocal: '17:00' }],
      }),
    ],
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'TIMEZONE_UNKNOWN');
  assert.equal(result.nextEligibleAt, undefined);
});

test('temporal: quiet hours ที่ไม่ overridable ให้ DEFER แบบเด็ดขาดพร้อม nextEligibleAt', () => {
  const now = new Date('2026-09-15T20:00:00.000Z'); // 2026-09-16 03:00 Asia/Bangkok (Wed, quiet)
  const input = baseInput({
    now,
    policy: {
      version: 1,
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [],
      holidays: [],
    },
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'QUIET_HOURS');
  assert.ok(result.nextEligibleAt);
  assert.equal(result.timezoneSource, 'POLICY_FALLBACK');
  const nextEligible = new Date(result.nextEligibleAt!);
  const parts = zonedPartsAt(nextEligible, 'Asia/Bangkok');
  assert.equal(parts.hour, 8);
  assert.equal(parts.minute, 0);
});

test('temporal: preference timezone ชนะ policy fallback ตามลำดับ authority', () => {
  const now = new Date('2026-09-15T20:00:00.000Z');
  const input = baseInput({
    now,
    preferences: [preference({ decision: 'ALLOW', timezone: 'Asia/Tokyo' })],
    policy: {
      version: 1,
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [],
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [],
      holidays: [{ localDate: '2026-09-16', effect: 'CLOSED', windows: [] }],
    },
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.timezoneSource, 'PREFERENCE');
});

test('temporal: holiday CLOSED ปิดทั้งวันแม้ไม่มี quiet hours', () => {
  const now = new Date('2026-09-15T20:00:00.000Z'); // 2026-09-16 Asia/Bangkok
  const input = baseInput({
    now,
    policy: {
      version: 1,
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [],
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [],
      holidays: [{ localDate: '2026-09-16', effect: 'CLOSED', windows: [] }],
    },
    preferences: [
      preference({
        preferredWindows: [
          { daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '00:00', endLocal: '23:59' },
        ],
      }),
    ],
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'TENANT_HOLIDAY');
});

// ---- Callback exception (#101 §5) ----

function overridablePolicyInput(overrides: Partial<Cg3EvaluationInput> = {}): Cg3EvaluationInput {
  return baseInput({
    now: new Date('2026-09-15T20:00:00.000Z'),
    policy: {
      version: 1,
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: ['QUIET_HOURS'],
      holidays: [],
    },
    ...overrides,
  });
}

test('callback: SCOPED_OVERRIDE ที่ exact scope ตรงและยังไม่หมดอายุ ยก quiet hours ให้ผ่านต่อ', () => {
  const input = overridablePolicyInput({
    activeCallback: {
      requestId: 'callback-1',
      identityId: null,
      channel: 'LINE',
      purpose: 'MARKETING',
      expiresAt: '2026-09-16T00:00:00.000Z',
      approvedExceptionId: null,
    },
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, undefined);
  assert.equal(result.consumedCallbackRequestId, 'callback-1');
  assert.equal(result.exceptionMode, 'SCOPED_OVERRIDE');
});

test('callback: scope ไม่ตรง (purpose ต่าง) ให้ CALLBACK_OVERRIDE_NOT_ALLOWED', () => {
  const input = overridablePolicyInput({
    activeCallback: {
      requestId: 'callback-1',
      identityId: null,
      channel: 'LINE',
      purpose: 'BILLING',
      expiresAt: '2026-09-16T00:00:00.000Z',
      approvedExceptionId: null,
    },
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'CALLBACK_OVERRIDE_NOT_ALLOWED');
});

test('callback: หมดอายุแล้วให้ CALLBACK_OVERRIDE_EXPIRED', () => {
  const input = overridablePolicyInput({
    activeCallback: {
      requestId: 'callback-1',
      identityId: null,
      channel: 'LINE',
      purpose: 'MARKETING',
      expiresAt: '2026-09-15T19:00:00.000Z',
      approvedExceptionId: null,
    },
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'CALLBACK_OVERRIDE_EXPIRED');
});

test('callback: NO_OVERRIDE mode ปฏิเสธแม้มี callback ที่ scope ตรง', () => {
  const input = overridablePolicyInput({
    policy: {
      version: 1,
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
      callbackMode: 'NO_OVERRIDE',
      overridableRules: ['QUIET_HOURS'],
      holidays: [],
    },
    activeCallback: {
      requestId: 'callback-1',
      identityId: null,
      channel: 'LINE',
      purpose: 'MARKETING',
      expiresAt: '2026-09-16T00:00:00.000Z',
      approvedExceptionId: null,
    },
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'CALLBACK_OVERRIDE_NOT_ALLOWED');
});

test('callback: TIME_POLICY_OVERRIDE โดยไม่มี approvedExceptionId ให้ REVIEW/EXCEPTION_APPROVAL_REQUIRED', () => {
  const input = overridablePolicyInput({
    policy: {
      version: 1,
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
      callbackMode: 'TIME_POLICY_OVERRIDE',
      overridableRules: ['QUIET_HOURS'],
      holidays: [],
    },
    activeCallback: {
      requestId: 'callback-1',
      identityId: null,
      channel: 'LINE',
      purpose: 'MARKETING',
      expiresAt: '2026-09-16T00:00:00.000Z',
      approvedExceptionId: null,
    },
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'REVIEW');
  assert.equal(result.reasonCode, 'EXCEPTION_APPROVAL_REQUIRED');
});

const TIME_POLICY_OVERRIDE_POLICY = {
  version: 1,
  timezoneFallback: 'Asia/Bangkok',
  quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
  callbackMode: 'TIME_POLICY_OVERRIDE' as const,
  overridableRules: ['QUIET_HOURS'],
  holidays: [],
};

const CALLBACK_WITH_EXCEPTION = {
  requestId: 'callback-1',
  identityId: null,
  channel: 'LINE' as const,
  purpose: 'MARKETING',
  expiresAt: '2026-09-16T00:00:00.000Z',
  approvedExceptionId: 'exception-1',
};

/**
 * CG4.4 (#187): `approvedExceptionId` เป็น reference เฉย ๆ ไม่ใช่หลักฐาน — ต้อง resolve เป็น
 * exception ที่ active/ตรง scope/ตรง rule จริงถึงจะ override ได้ (#174 §4 fail closed)
 */
function activeExceptionFact(overrides: Partial<Cg4ExceptionFacts> = {}): Cg4ExceptionFacts {
  const digest = 'a'.repeat(64);
  return {
    seriesId: 'exception-1',
    revisionId: 'revision-1',
    revision: 1,
    workflowState: 'APPROVED',
    identityId: null,
    scopeKind: 'CONTACT_WIDE',
    channel: 'LINE',
    purpose: 'MARKETING',
    sourceType: 'JOURNEY',
    sourceId: 'journey-1',
    allowedRuleCodes: ['QUIET_HOURS'],
    policyId: 'policy-1',
    policyVersionId: 'policy-version-1',
    policyVersion: 1,
    policyContentDigest: digest,
    currentPolicyContentDigest: digest,
    policyAllowedRuleCodes: ['QUIET_HOURS'],
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    startsAt: new Date('2026-09-15T19:00:00.000Z'),
    expiresAt: new Date('2026-09-15T23:00:00.000Z'),
    tier: 'HIGH',
    contentDigest: 'b'.repeat(64),
    approvalDigest: 'c'.repeat(64),
    ...overrides,
  };
}

test('callback: TIME_POLICY_OVERRIDE ที่ approvedExceptionId ไม่ resolve เป็น exception จริง ให้ REVIEW (fail closed)', () => {
  const input = overridablePolicyInput({
    policy: TIME_POLICY_OVERRIDE_POLICY,
    activeCallback: CALLBACK_WITH_EXCEPTION,
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'REVIEW');
  assert.equal(result.reasonCode, 'EXCEPTION_APPROVAL_REQUIRED');
});

test('callback: TIME_POLICY_OVERRIDE ที่ approvedExceptionId resolve เป็น active exception ให้ผ่านต่อและ pin exception', () => {
  const input = overridablePolicyInput({
    policy: TIME_POLICY_OVERRIDE_POLICY,
    activeCallback: CALLBACK_WITH_EXCEPTION,
    source: 'JOURNEY',
    sourceId: 'journey-1',
    activeExceptions: [activeExceptionFact()],
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, undefined);
  assert.equal(result.exceptionRef, 'callback-1');
  assert.equal(result.consumedCallbackRequestId, 'callback-1');
  assert.equal(result.appliedExceptions?.length, 1);
  assert.equal(result.appliedExceptions?.[0]?.seriesId, 'exception-1');
});

test('callback: exception ที่ถูก revoke แล้วทำให้ TIME_POLICY_OVERRIDE กลับไป REVIEW', () => {
  const input = overridablePolicyInput({
    policy: TIME_POLICY_OVERRIDE_POLICY,
    activeCallback: CALLBACK_WITH_EXCEPTION,
    source: 'JOURNEY',
    sourceId: 'journey-1',
    activeExceptions: [activeExceptionFact({ workflowState: 'REVOKED' })],
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'REVIEW');
  assert.equal(result.reasonCode, 'EXCEPTION_APPROVAL_REQUIRED');
});

test('approved exception ยก quiet hours ได้แม้ CG3 overridableRules ว่าง และไม่ consume callback', () => {
  const input = overridablePolicyInput({
    policy: { ...TIME_POLICY_OVERRIDE_POLICY, callbackMode: 'NO_OVERRIDE', overridableRules: [] },
    source: 'JOURNEY',
    sourceId: 'journey-1',
    activeExceptions: [activeExceptionFact()],
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, undefined);
  assert.equal(result.consumedCallbackRequestId, undefined);
  assert.equal(result.appliedExceptions?.length, 1);
  const gates = result.trace.map((entry) => `${entry.gate}:${entry.outcome}`);
  assert.ok(gates.includes('TEMPORAL_POLICY:DEFER'));
  assert.ok(gates.includes('APPROVED_EXCEPTION:PASS'));
});

// ---- S1-CG3-F02: preference/callback/exception ห้ามข้าม hard restriction/consent/non-overridable ----
// (evaluateCg3Policy ถูกเรียกเฉพาะหลัง C1 ALLOW ผ่านแล้วเท่านั้น — caller เป็นผู้บังคับลำดับนี้
//  ดู contact-governance-service.integration.ts สำหรับ end-to-end coverage ผ่าน database)

test('cg3 evaluator เองไม่มีทางข้าม non-overridable temporal rule ได้แม้มี valid callback', () => {
  const input = baseInput({
    now: new Date('2026-09-15T20:00:00.000Z'),
    policy: {
      version: 1,
      timezoneFallback: 'Asia/Bangkok',
      quietHours: [{ daysOfWeek: [1, 2, 3, 4, 5, 6, 7], startLocal: '21:00', endLocal: '08:00' }],
      callbackMode: 'SCOPED_OVERRIDE',
      overridableRules: [], // ไม่ overridable
      holidays: [],
    },
    activeCallback: {
      requestId: 'callback-1',
      identityId: null,
      channel: 'LINE',
      purpose: 'MARKETING',
      expiresAt: '2026-09-16T00:00:00.000Z',
      approvedExceptionId: 'exception-1',
    },
  });
  const result = evaluateCg3Policy(input);
  assert.equal(result.decision, 'DEFER');
  assert.equal(result.reasonCode, 'QUIET_HOURS');
  assert.equal(
    result.trace.some((entry) => entry.gate === 'CALLBACK_EXCEPTION'),
    false,
  );
});

// ---- Sender identity (placeholder gate; ดู decision gap ใน PR description) ----

test('sender identity: string ว่างให้ BLOCK; undefined หรือมีค่าให้ PASS', () => {
  const blocked = evaluateCg3Policy(baseInput({ senderIdentityId: '' }));
  assert.equal(blocked.decision, 'BLOCK');
  assert.equal(blocked.reasonCode, 'SENDER_IDENTITY_INVALID');

  const passed = evaluateCg3Policy(baseInput({ senderIdentityId: 'line-oa-1' }));
  assert.equal(passed.decision, undefined);

  const omitted = evaluateCg3Policy(baseInput());
  assert.equal(omitted.decision, undefined);
});

// ---- Cap gate placeholder ----

test('cap gate: ยังไม่มี threshold ที่ decide จึง PASS เสมอในเวอร์ชันนี้', () => {
  const result = evaluateCg3Policy(baseInput());
  assert.equal(result.trace.find((entry) => entry.gate === 'ATTEMPT_TOUCH_CAP')?.outcome, 'PASS');
});

// ---- Timezone helpers: DST correctness (#101 §4) ----

test('zonedToUtc round-trip ถูกต้องข้าม DST boundary (America/New_York)', () => {
  // 2026-03-08 02:30 local ไม่มีอยู่จริง (spring-forward); ทดสอบช่วงปกติก่อนและหลัง DST แทน
  const beforeDst = zonedToUtc(2026, 3, 1, 9, 0, 'America/New_York'); // EST = UTC-5
  assert.equal(beforeDst.toISOString(), '2026-03-01T14:00:00.000Z');
  const afterDst = zonedToUtc(2026, 3, 15, 9, 0, 'America/New_York'); // EDT = UTC-4
  assert.equal(afterDst.toISOString(), '2026-03-15T13:00:00.000Z');
});
