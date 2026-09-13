import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCg4PolicyScopeKey } from './cg4-policy-compiler.js';
import { resolveCg4ActivePolicy, type Cg4ScopeHeadFacts } from './cg4-policy-resolution.js';

const NOW = new Date('2026-01-05T12:00:00.000Z');

function head(overrides: Partial<Cg4ScopeHeadFacts> = {}): Cg4ScopeHeadFacts {
  return {
    scopeKey: buildCg4PolicyScopeKey({ channel: 'VOICE' }),
    policyId: 'policy-1',
    policyVersionId: 'policy-version-1',
    policyVersion: 3,
    policyContentDigest: 'a'.repeat(64),
    schemaVersion: 1,
    registryVersion: 'CG4_RULE_REGISTRY_V1',
    evaluatorVersion: 'CG4_EVALUATOR_V1',
    headVersion: 5,
    headDigest: 'b'.repeat(64),
    nextActivationAt: null,
    ...overrides,
  };
}

function resolve(heads: Cg4ScopeHeadFacts[], request = { channel: 'VOICE' as const }) {
  return resolveCg4ActivePolicy({ heads, request, now: NOW, cacheTtlSeconds: 300 });
}

test('scope ที่ยังไม่มี policy คืน UNCONFIGURED ไม่ใช่ fail closed', () => {
  assert.equal(resolve([]).outcome, 'UNCONFIGURED');
  assert.equal(
    resolve([head({ scopeKey: buildCg4PolicyScopeKey({ channel: 'EMAIL' }) })]).outcome,
    'UNCONFIGURED',
  );
});

test('เลือก head ที่ specificity สูงสุด ไม่ใช่ตัวที่ publish ล่าสุด', () => {
  const generic = head({ scopeKey: buildCg4PolicyScopeKey({}), policyId: 'generic' });
  const specific = head({
    scopeKey: buildCg4PolicyScopeKey({ channel: 'VOICE', purpose: 'MARKETING' }),
    policyId: 'specific',
  });
  const result = resolve([specific, generic], { channel: 'VOICE', purpose: 'MARKETING' } as never);
  assert.equal(result.outcome, 'RESOLVED');
  assert.ok(result.outcome === 'RESOLVED');
  assert.equal(result.head.policyId, 'specific');
});

test('head ที่ specificity เท่ากันสองตัว match request เดียวกัน fail closed', () => {
  const byChannel = head({ scopeKey: buildCg4PolicyScopeKey({ channel: 'VOICE' }), policyId: 'a' });
  const byPurpose = head({
    scopeKey: buildCg4PolicyScopeKey({ purpose: 'MARKETING' }),
    policyId: 'b',
  });
  const result = resolve([byChannel, byPurpose], {
    channel: 'VOICE',
    purpose: 'MARKETING',
  } as never);
  assert.equal(result.outcome, 'FAIL_CLOSED');
  assert.ok(result.outcome === 'FAIL_CLOSED');
  assert.equal(result.reason, 'GOVERNANCE_STATE_UNAVAILABLE');
});

test('schema/registry/evaluator version ที่ไม่รองรับ fail closed', () => {
  for (const overrides of [
    { schemaVersion: 2 },
    { registryVersion: 'CG4_RULE_REGISTRY_V0' },
    { evaluatorVersion: 'CG4_EVALUATOR_V0' },
  ]) {
    const result = resolve([head(overrides)]);
    assert.ok(result.outcome === 'FAIL_CLOSED');
    assert.equal(result.reason, 'GOVERNANCE_POLICY_VERSION_UNSUPPORTED');
  }
});

test('scheduled activation ที่ถึงเวลาแล้วแต่ยังไม่ activate ห้าม fallback ไป version เก่า', () => {
  const due = resolve([head({ nextActivationAt: new Date('2026-01-05T11:59:59.000Z') })]);
  assert.ok(due.outcome === 'FAIL_CLOSED');
  assert.equal(due.reason, 'POLICY_ACTIVATION_PENDING');

  const exactly = resolve([head({ nextActivationAt: NOW })]);
  assert.ok(exactly.outcome === 'FAIL_CLOSED');
  assert.equal(exactly.reason, 'POLICY_ACTIVATION_PENDING');
});

test('validUntil ถูกตัดด้วย TTL หรือ nextActivationAt แล้วแต่อันไหนมาก่อน', () => {
  const ttlBound = resolve([head()]);
  assert.ok(ttlBound.outcome === 'RESOLVED');
  assert.equal(ttlBound.validUntil.toISOString(), '2026-01-05T12:05:00.000Z');

  const soon = resolve([head({ nextActivationAt: new Date('2026-01-05T12:01:00.000Z') })]);
  assert.ok(soon.outcome === 'RESOLVED');
  assert.equal(soon.validUntil.toISOString(), '2026-01-05T12:01:00.000Z');

  const late = resolve([head({ nextActivationAt: new Date('2026-01-05T18:00:00.000Z') })]);
  assert.ok(late.outcome === 'RESOLVED');
  assert.equal(late.validUntil.toISOString(), '2026-01-05T12:05:00.000Z');
});
