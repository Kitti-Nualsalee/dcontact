import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CG4_CONTRACT_VERSION,
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  Cg4ContractError,
  actionKey,
  assertSupportedCg4ArtifactVersions,
  canonicalCg4Digest,
  canonicalCg4Json,
  reservationId,
  type AuthorizationOutcome,
  type ContactAuthorizationPort,
} from './index.js';
import {
  createCg4CanonicalChangePayloadFixture,
  createCg4ExceptionRequestFixture,
  createCg4ExceptionResultFixture,
  createCg4PolicyCandidateFixture,
} from './testing/cg4-fixtures.js';

test('canonical CG4 serialization และ SHA-256 ไม่ขึ้นกับ object key order', () => {
  const left = { z: 1, nested: { beta: true, alpha: ['x', 2] }, omitted: undefined };
  const right = { nested: { alpha: ['x', 2], beta: true }, z: 1 };
  assert.equal(canonicalCg4Json(left), canonicalCg4Json(right));
  assert.equal(canonicalCg4Digest(left), canonicalCg4Digest(right));
  assert.match(canonicalCg4Digest(left), /^[a-f0-9]{64}$/);
  assert.notEqual(canonicalCg4Digest(left), canonicalCg4Digest({ ...right, z: 2 }));
});

test('canonical CG4 serialization ปฏิเสธค่าที่ replay ไม่ได้อย่าง deterministic', () => {
  assert.throws(
    () => canonicalCg4Json({ value: Number.NaN }),
    (error: unknown) =>
      error instanceof Cg4ContractError && error.code === 'CANONICAL_VALUE_INVALID',
  );
  assert.throws(() => canonicalCg4Json({ value: new Date('2026-09-15T10:00:00.000Z') }));
  assert.throws(() => canonicalCg4Json([undefined]));
});

test('unknown contract/schema/registry/evaluator version fail closed', () => {
  const supported = {
    contractVersion: CG4_CONTRACT_VERSION,
    policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
    ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
    evaluatorVersion: CG4_EVALUATOR_VERSION,
  };
  assert.doesNotThrow(() => assertSupportedCg4ArtifactVersions(supported));

  const failures = [
    [{ ...supported, contractVersion: 2 }, 'UNSUPPORTED_CONTRACT_VERSION'],
    [{ ...supported, policySchemaVersion: 2 }, 'UNSUPPORTED_POLICY_SCHEMA_VERSION'],
    [{ ...supported, ruleRegistryVersion: 'UNKNOWN' }, 'UNSUPPORTED_RULE_REGISTRY_VERSION'],
    [{ ...supported, evaluatorVersion: 'UNKNOWN' }, 'UNSUPPORTED_EVALUATOR_VERSION'],
  ] as const;
  for (const [versions, code] of failures) {
    assert.throws(
      () => assertSupportedCg4ArtifactVersions(versions),
      (error: unknown) => error instanceof Cg4ContractError && error.code === code,
    );
  }
});

test('deterministic fixtures ใช้ opaque references และไม่สร้าง caller authority', () => {
  assert.deepEqual(createCg4PolicyCandidateFixture(), createCg4PolicyCandidateFixture());
  assert.deepEqual(createCg4ExceptionRequestFixture(), createCg4ExceptionRequestFixture());
  assert.deepEqual(createCg4ExceptionResultFixture(), createCg4ExceptionResultFixture());

  const request = createCg4ExceptionRequestFixture();
  assert.equal('tenantId' in request, false);
  assert.equal('actor' in request, false);
  assert.equal('role' in request, false);
  assert.equal('overridable' in request, false);

  const eventJson = canonicalCg4Json(createCg4CanonicalChangePayloadFixture());
  for (const forbiddenField of [
    'actor',
    'ticketRef',
    'evidenceRef',
    'identityId',
    'phone',
    'email',
  ]) {
    assert.equal(eventJson.includes(`"${forbiddenField}"`), false);
  }
});

test('CG4 trace pin เป็น optional additive field และคง ContactAuthorizationPort เดิม', async () => {
  const legacyOutcome: AuthorizationOutcome = {
    decisionId: 'decision-fixture-001',
    decision: 'ALLOW',
    reasonCode: 'POLICY_PASSED',
    policyVersion: 1,
    trace: [
      { gate: 'IDENTITY', outcome: 'PASS' },
      { gate: 'HARD_RESTRICTION', outcome: 'PASS' },
      { gate: 'CONSENT', outcome: 'ALLOW', reasonCode: 'POLICY_PASSED' },
    ],
    reservationId: reservationId('reservation-fixture-001'),
  };
  const port: ContactAuthorizationPort = {
    async authorizeAndReserve(_tenantId, input) {
      assert.equal(input.actionKey, actionKey('action-fixture-001'));
      return legacyOutcome;
    },
  };

  const result = await port.authorizeAndReserve('tenant-fixture-001', {
    contactId: 'contact-fixture-001',
    channel: 'LINE',
    purpose: 'SERVICE',
    source: 'JOURNEY',
    sourceId: 'journey-fixture-001',
    actionKey: actionKey('action-fixture-001'),
    policyVersion: 1,
  });
  assert.deepEqual(result, legacyOutcome);
  assert.equal(result.cg4, undefined);
});
