import assert from 'node:assert/strict';
import test from 'node:test';
import {
  classifyGovernanceEvent,
  classifyGovernanceStreamPosition,
  governanceScopeCovers,
  isGovernanceContractRejection,
  type GovernanceDownstreamClassification,
  type GovernanceDownstreamEvent,
} from './contact-governance-downstream.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const CONTACT = 'contact_governance_contact';
const POLICY = 'contact_governance_policy';

function cg4Payload(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    mutationId: 'mutation-1',
    transitionKind: 'EXCEPTION_REVOKED',
    subjectId: 'series-1',
    subjectVersion: 2,
    state: 'REVOKED',
    effectiveAt: '2026-09-14T00:00:00.000Z',
    affectedScope: {
      scopeKey: 'contact:c-1',
      channel: 'LINE',
      purpose: 'MARKETING',
      sourceType: 'JOURNEY',
    },
    scopeDigest: DIGEST_A,
    ruleRegistryVersion: 'CG4_RULE_REGISTRY_V1',
    policySchemaVersion: 1,
    evaluatorVersion: 'CG4_EVALUATOR_V1',
    stateDigest: DIGEST_B,
    restrictiveness: 'TIGHTENING',
    ...overrides,
  };
}

function cg3Payload(version: number) {
  return {
    contractVersion: 1,
    mutationId: 'mutation-cg3',
    subjectVersion: version,
    affectedScope: {
      identityId: 'identity-1',
      channel: 'EMAIL',
      purpose: 'MARKETING',
      contactKind: null,
    },
    effectiveAt: '2026-09-14T00:00:00.000Z',
    stateDigest: DIGEST_A,
  };
}

function accepted(
  result: GovernanceDownstreamClassification | undefined,
): GovernanceDownstreamEvent {
  assert.ok(result?.ok, `ต้องจัดประเภทได้: ${JSON.stringify(result)}`);
  return result.event;
}

function rejected(result: GovernanceDownstreamClassification | undefined) {
  assert.ok(result && !result.ok, 'ต้องถูกปฏิเสธ');
  return result;
}

test('CG3 contact event เป็น REAUTHORIZE และต้องมี subjectVersion ตรง envelope', () => {
  const event = accepted(
    classifyGovernanceEvent({
      type: 'preference.changed',
      aggregateType: CONTACT,
      aggregateId: 'c-1',
      aggregateVersion: 3,
      payload: cg3Payload(3),
    }),
  );
  assert.equal(event.family, 'CG3');
  assert.equal(event.effect, 'REAUTHORIZE');
  assert.equal(event.scope.identityId, 'identity-1');

  const mismatch = rejected(
    classifyGovernanceEvent({
      type: 'preference.changed',
      aggregateType: CONTACT,
      aggregateId: 'c-1',
      aggregateVersion: 4,
      payload: cg3Payload(3),
    }),
  );
  assert.equal(mismatch.reason, 'MALFORMED_PAYLOAD');
});

test('CG4.2 exception.recorded ยังรับได้บน contact stream ในรูป CG3', () => {
  const event = accepted(
    classifyGovernanceEvent({
      type: 'exception.recorded',
      aggregateType: CONTACT,
      aggregateId: 'c-1',
      aggregateVersion: 2,
      payload: cg3Payload(2),
    }),
  );
  assert.equal(event.effect, 'REAUTHORIZE');
});

test('exception revoke/expiry ต้อง re-authorize แต่ approve เป็น relaxation ที่ไม่ resume งาน', () => {
  const revoked = accepted(
    classifyGovernanceEvent({
      type: 'exception.changed',
      aggregateType: CONTACT,
      aggregateId: 'c-1',
      aggregateVersion: 7,
      payload: cg4Payload(),
    }),
  );
  assert.equal(revoked.family, 'CG4');
  assert.equal(revoked.effect, 'REAUTHORIZE');
  // subjectVersion ของ CG4 เป็น revision ของ exception ไม่ต้องตรงกับ stream version
  assert.equal(revoked.subjectVersion, 2);
  assert.equal(revoked.scope.sourceType, 'JOURNEY');

  const approved = accepted(
    classifyGovernanceEvent({
      type: 'exception.changed',
      aggregateType: CONTACT,
      aggregateId: 'c-1',
      aggregateVersion: 8,
      payload: cg4Payload({
        transitionKind: 'EXCEPTION_APPROVED',
        state: 'APPROVED',
        restrictiveness: 'RELAXATION',
      }),
    }),
  );
  assert.equal(approved.effect, 'NO_OP');
});

test('kill switch ACTIVE hold scope และ CLEARED ไม่ปลดงานที่ hold ไว้', () => {
  const activated = accepted(
    classifyGovernanceEvent({
      type: 'governance.kill-switch.changed',
      aggregateType: POLICY,
      aggregateId: 'kill-1',
      aggregateVersion: 1,
      payload: cg4Payload({
        transitionKind: 'KILL_SWITCH_ACTIVATED',
        state: 'ACTIVE',
        affectedScope: {
          scopeKey: 'channel=LINE|contactKind=*|purpose=*|sourceType=*',
          channel: 'LINE',
        },
      }),
    }),
  );
  assert.equal(activated.effect, 'HOLD_SCOPE');
  assert.equal(activated.scope.channel, 'LINE');

  const cleared = accepted(
    classifyGovernanceEvent({
      type: 'governance.kill-switch.changed',
      aggregateType: POLICY,
      aggregateId: 'kill-1',
      aggregateVersion: 2,
      payload: cg4Payload({
        transitionKind: 'KILL_SWITCH_CLEARED',
        state: 'CLEARED',
        restrictiveness: 'RELAXATION',
      }),
    }),
  );
  assert.equal(cleared.effect, 'NO_OP');

  const inconsistent = rejected(
    classifyGovernanceEvent({
      type: 'governance.kill-switch.changed',
      aggregateType: POLICY,
      aggregateId: 'kill-1',
      aggregateVersion: 1,
      payload: cg4Payload({
        transitionKind: 'KILL_SWITCH_ACTIVATED',
        state: 'ACTIVE',
        restrictiveness: 'RELAXATION',
      }),
    }),
  );
  assert.equal(inconsistent.reason, 'MALFORMED_PAYLOAD');
});

test('policy.changed แยก CG3 กับ CG4 และ scheduled head ยังไม่มีผล', () => {
  const legacy = accepted(
    classifyGovernanceEvent({
      type: 'policy.changed',
      aggregateType: POLICY,
      aggregateId: 'policy-1',
      aggregateVersion: 2,
      payload: cg3Payload(2),
    }),
  );
  assert.equal(legacy.family, 'CG3');

  const scheduled = accepted(
    classifyGovernanceEvent({
      type: 'policy.changed',
      aggregateType: POLICY,
      aggregateId: 'policy-1',
      aggregateVersion: 3,
      payload: cg4Payload({ transitionKind: 'POLICY_CHANGED', state: 'SCHEDULED' }),
    }),
  );
  assert.equal(scheduled.effect, 'NO_OP');

  const activated = accepted(
    classifyGovernanceEvent({
      type: 'policy.changed',
      aggregateType: POLICY,
      aggregateId: 'policy-1',
      aggregateVersion: 4,
      payload: cg4Payload({ transitionKind: 'POLICY_ACTIVATED', state: 'ACTIVE' }),
    }),
  );
  assert.equal(activated.effect, 'REAUTHORIZE');
});

test('contract/schema/registry/evaluator ที่ไม่รู้จักถูกปฏิเสธเป็น unsupported ก่อนตรวจรูป payload', () => {
  const cases = [
    [{ contractVersion: 2, transitionKind: undefined }, 'UNSUPPORTED_CONTRACT_VERSION'],
    [{ policySchemaVersion: 9 }, 'UNSUPPORTED_POLICY_SCHEMA_VERSION'],
    [{ ruleRegistryVersion: 'CG4_RULE_REGISTRY_V9' }, 'UNSUPPORTED_RULE_REGISTRY_VERSION'],
    [{ evaluatorVersion: 'CG4_EVALUATOR_V9' }, 'UNSUPPORTED_EVALUATOR_VERSION'],
    [{ transitionKind: 'EXCEPTION_TELEPORTED' }, 'UNSUPPORTED_TRANSITION_KIND'],
  ] as const;
  for (const [overrides, reason] of cases) {
    const result = rejected(
      classifyGovernanceEvent({
        type: 'exception.changed',
        aggregateType: CONTACT,
        aggregateId: 'c-1',
        aggregateVersion: 1,
        payload: cg4Payload(overrides),
      }),
    );
    assert.equal(result.reason, reason);
    assert.equal(isGovernanceContractRejection(result.reason), true);
    assert.equal(result.aggregate, 'CONTACT');
  }
  assert.equal(isGovernanceContractRejection('EVENT_HASH_CONFLICT'), false);
});

test('event type ผิด aggregate ถูกปฏิเสธ และ aggregate ที่ไม่ใช่ของ Governance คืน undefined', () => {
  const wrongAggregate = rejected(
    classifyGovernanceEvent({
      type: 'exception.changed',
      aggregateType: POLICY,
      aggregateId: 'policy-1',
      aggregateVersion: 1,
      payload: cg4Payload(),
    }),
  );
  assert.equal(wrongAggregate.reason, 'UNSUPPORTED_EVENT_TYPE');
  assert.equal(
    classifyGovernanceEvent({
      type: 'exception.changed',
      aggregateType: 'journey_action',
      aggregateId: 'x',
      aggregateVersion: 1,
      payload: {},
    }),
    undefined,
  );
});

test('stream position ครอบ apply, duplicate, hash conflict, gap และ superseded', () => {
  assert.deepEqual(
    classifyGovernanceStreamPosition({ incoming: { version: 1, digest: DIGEST_A } }),
    {
      kind: 'APPLY',
    },
  );
  assert.deepEqual(
    classifyGovernanceStreamPosition({ incoming: { version: 3, digest: DIGEST_A } }),
    {
      kind: 'GAP',
      expectedVersion: 1,
      receivedVersion: 3,
    },
  );
  const cursor = { version: 4, digest: DIGEST_A };
  assert.equal(
    classifyGovernanceStreamPosition({ cursor, incoming: { version: 5, digest: DIGEST_B } }).kind,
    'APPLY',
  );
  assert.equal(
    classifyGovernanceStreamPosition({ cursor, incoming: { version: 4, digest: DIGEST_A } }).kind,
    'DUPLICATE',
  );
  assert.equal(
    classifyGovernanceStreamPosition({ cursor, incoming: { version: 4, digest: DIGEST_B } }).kind,
    'HASH_CONFLICT',
  );
  assert.equal(
    classifyGovernanceStreamPosition({ cursor, incoming: { version: 7, digest: DIGEST_B } }).kind,
    'GAP',
  );
  assert.equal(
    classifyGovernanceStreamPosition({
      cursor,
      appliedAtIncomingVersion: { digest: DIGEST_B },
      incoming: { version: 2, digest: DIGEST_A },
    }).kind,
    'HASH_CONFLICT',
  );
  assert.equal(
    classifyGovernanceStreamPosition({ cursor, incoming: { version: 2, digest: DIGEST_A } }).kind,
    'SUPERSEDED',
  );
});

test('scope ที่ไม่ผูก dimension กว้างกว่า และ source type ของ owner อื่นไม่ตรง', () => {
  const work = {
    identityId: 'identity-1',
    channel: 'LINE',
    purpose: 'MARKETING',
    sourceTypes: ['JOURNEY'],
  };
  const unbound = {
    identityId: null,
    channel: null,
    purpose: null,
    contactKind: null,
    sourceType: null,
    scopeKey: 'channel=*|contactKind=*|purpose=*|sourceType=*',
  };
  assert.equal(governanceScopeCovers(unbound, work), true);
  assert.equal(governanceScopeCovers({ ...unbound, channel: 'VOICE' }, work), false);
  assert.equal(governanceScopeCovers({ ...unbound, sourceType: 'DIALER' }, work), false);
  // งานที่ไม่รู้ contactKind ถูกนับว่าอยู่ใน scope เพื่อ fail closed
  assert.equal(governanceScopeCovers({ ...unbound, contactKind: 'LEAD' }, work), true);
});
