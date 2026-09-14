import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cg4DefaultRollout,
  cg4PolicyReaderFor,
  Cg4RolloutError,
  planCg4RolloutTransition,
  type Cg4RolloutSnapshot,
} from './cg4-rollout.js';
import { cg4PolicyFailClosedOutcome, cg4ShadowDecisionDigest } from './cg4-policy-reader.js';

const LINE_MARKETING = 'channel=LINE|contactKind=*|purpose=MARKETING|sourceType=*';
const TENANT = '00000000-0000-0000-0000-000000000001';

function state(overrides: Partial<Cg4RolloutSnapshot>): Cg4RolloutSnapshot {
  return { ...cg4DefaultRollout(TENANT), version: 1, ...overrides };
}

const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof Cg4RolloutError);
    return error.code;
  }
  assert.fail('expected Cg4RolloutError');
};

test('ไม่มี rollout row = DISABLED และ reader เป็น CG3 เสมอ', () => {
  const rollout = cg4DefaultRollout(TENANT);
  assert.equal(rollout.stage, 'DISABLED');
  assert.equal(rollout.version, 0);
  assert.deepEqual(cg4PolicyReaderFor(rollout, { channel: 'LINE', purpose: 'MARKETING' }), {
    mode: 'CG3',
    pilot: false,
  });
});

test('reader ตาม stage: shadow ทุก scope, switch เฉพาะ pilot, enabled ทุก scope', () => {
  const line = { channel: 'LINE' as const, purpose: 'MARKETING' };
  const voice = { channel: 'VOICE' as const, purpose: 'SERVICE' };
  const keys = [LINE_MARKETING];
  const shadow = state({ stage: 'SHADOW_EVALUATION', syntheticScopeKeys: keys });
  assert.deepEqual(cg4PolicyReaderFor(shadow, line), { mode: 'CG3_WITH_SHADOW', pilot: true });
  assert.deepEqual(cg4PolicyReaderFor(shadow, voice), { mode: 'CG3_WITH_SHADOW', pilot: false });

  const scoped = state({
    stage: 'SCOPED_SYNTHETIC',
    syntheticScopeKeys: keys,
    switchedAt: new Date(),
  });
  assert.deepEqual(cg4PolicyReaderFor(scoped, line), { mode: 'CG4', pilot: true });
  assert.deepEqual(cg4PolicyReaderFor(scoped, voice), { mode: 'CG3_WITH_SHADOW', pilot: false });

  const enabled = state({
    stage: 'INTERNAL_ENABLED',
    syntheticScopeKeys: keys,
    switchedAt: new Date(),
  });
  assert.equal(cg4PolicyReaderFor(enabled, voice).mode, 'CG4');
});

test('pilot scope ที่ parse ไม่ได้ครอบทุก request แบบ fail closed', () => {
  const rollout = state({ stage: 'SHADOW_EVALUATION', syntheticScopeKeys: ['not-a-scope'] });
  assert.equal(cg4PolicyReaderFor(rollout, { channel: 'VOICE', purpose: 'X' }).pilot, true);
});

test('transition ทีละขั้น และ shadow ต้องประกาศ pilot scope ที่ถูกต้อง', () => {
  const disabled = cg4DefaultRollout(TENANT);
  assert.equal(
    code(() => planCg4RolloutTransition(disabled, { toStage: 'SCOPED_SYNTHETIC' })),
    'ROLLOUT_INVALID_TRANSITION',
  );
  assert.equal(
    code(() => planCg4RolloutTransition(disabled, { toStage: 'SHADOW_EVALUATION' })),
    'ROLLOUT_SCOPE_REQUIRED',
  );
  assert.equal(
    code(() =>
      planCg4RolloutTransition(disabled, {
        toStage: 'SHADOW_EVALUATION',
        syntheticScopeKeys: ['bad'],
      }),
    ),
    'ROLLOUT_SCOPE_REQUIRED',
  );
  const plan = planCg4RolloutTransition(disabled, {
    toStage: 'SHADOW_EVALUATION',
    syntheticScopeKeys: [LINE_MARKETING, LINE_MARKETING],
  });
  assert.deepEqual(plan, {
    stage: 'SHADOW_EVALUATION',
    syntheticScopeKeys: [LINE_MARKETING],
    startsShadowWindow: true,
    switches: false,
  });
});

test('ก่อน switch ถอยกลับ DISABLED ได้ (pre-mutation disable path)', () => {
  const shadow = state({ stage: 'SHADOW_EVALUATION', syntheticScopeKeys: [LINE_MARKETING] });
  assert.deepEqual(planCg4RolloutTransition(shadow, { toStage: 'DISABLED' }), {
    stage: 'DISABLED',
    syntheticScopeKeys: [],
    startsShadowWindow: false,
    switches: false,
  });
});

test('switch ใช้ pilot scope เดิมเท่านั้น และหลัง switch ย้อนกลับ CG3 reader ไม่ได้', () => {
  const shadow = state({ stage: 'SHADOW_EVALUATION', syntheticScopeKeys: [LINE_MARKETING] });
  assert.equal(
    code(() =>
      planCg4RolloutTransition(shadow, {
        toStage: 'SCOPED_SYNTHETIC',
        syntheticScopeKeys: ['channel=VOICE|contactKind=*|purpose=SERVICE|sourceType=*'],
      }),
    ),
    'ROLLOUT_INVALID_TRANSITION',
  );
  assert.equal(planCg4RolloutTransition(shadow, { toStage: 'SCOPED_SYNTHETIC' }).switches, true);

  const scoped = state({
    stage: 'SCOPED_SYNTHETIC',
    syntheticScopeKeys: [LINE_MARKETING],
    switchedAt: new Date(),
  });
  assert.equal(
    code(() =>
      planCg4RolloutTransition(scoped, {
        toStage: 'SHADOW_EVALUATION',
        syntheticScopeKeys: [LINE_MARKETING],
      }),
    ),
    'ROLLOUT_SWITCH_IRREVERSIBLE',
  );
  const enabled = { ...scoped, stage: 'INTERNAL_ENABLED' as const };
  assert.equal(
    planCg4RolloutTransition(enabled, { toStage: 'SCOPED_SYNTHETIC' }).stage,
    'SCOPED_SYNTHETIC',
  );
});

test('shadow digest เทียบผลที่ผู้ถูกติดต่อได้รับ ไม่ขึ้นกับ trace หรือ policy version', () => {
  const allowA = { trace: [{ gate: 'TEMPORAL_POLICY' as const, outcome: 'PASS' as const }] };
  const allowB = { trace: [] };
  assert.equal(cg4ShadowDecisionDigest(allowA), cg4ShadowDecisionDigest(allowB));
  const quiet = {
    trace: [],
    decision: 'DEFER' as const,
    reasonCode: 'QUIET_HOURS',
    matchedWindowRef: 'policy:quietHours',
  };
  assert.notEqual(cg4ShadowDecisionDigest(allowA), cg4ShadowDecisionDigest(quiet));
  assert.notEqual(
    cg4ShadowDecisionDigest(allowA),
    cg4ShadowDecisionDigest(
      cg4PolicyFailClosedOutcome('POLICY_HEAD', 'GOVERNANCE_STATE_UNAVAILABLE'),
    ),
  );
  assert.match(cg4ShadowDecisionDigest(quiet), /^[a-f0-9]{64}$/);
});
