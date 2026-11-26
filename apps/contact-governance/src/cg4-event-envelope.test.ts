import assert from 'node:assert/strict';
import test from 'node:test';
import { isCg4ProducerSideRejection, parseCg4CanonicalEvent } from './cg4-event-envelope.js';

function payload(overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    mutationId: 'mutation-1',
    transitionKind: 'EXCEPTION_APPROVED',
    subjectId: 'series-1',
    subjectVersion: 3,
    state: 'APPROVED',
    effectiveAt: '2026-01-05T00:00:00.000Z',
    affectedScope: { scopeKey: 'channel=VOICE|contactKind=*|purpose=*|sourceType=*' },
    scopeDigest: 'a'.repeat(64),
    ruleRegistryVersion: 'CG4_RULE_REGISTRY_V1',
    policySchemaVersion: 1,
    evaluatorVersion: 'CG4_EVALUATOR_V1',
    stateDigest: 'b'.repeat(64),
    restrictiveness: 'RELAXATION',
    ...overrides,
  };
}

function parse(overrides: Record<string, unknown> = {}, eventType = 'exception.changed') {
  return parseCg4CanonicalEvent({ eventType, payload: payload(overrides) });
}

test('the canonical payload of all three event types passes', () => {
  for (const eventType of [
    'exception.changed',
    'policy.changed',
    'governance.kill-switch.changed',
  ]) {
    const result = parseCg4CanonicalEvent({ eventType, payload: payload() });
    assert.equal(result.ok, true, eventType);
  }
});

test('an event type that is not canonical CG4 is rejected', () => {
  const result = parseCg4CanonicalEvent({ eventType: 'preference.changed', payload: payload() });
  assert.ok(!result.ok);
  assert.equal(result.reason, 'UNSUPPORTED_EVENT_TYPE');
});

test('an unknown contract/schema/registry/evaluator version is separated by reason', () => {
  const cases = [
    [{ contractVersion: 2 }, 'UNSUPPORTED_CONTRACT_VERSION'],
    [{ policySchemaVersion: 2 }, 'UNSUPPORTED_POLICY_SCHEMA_VERSION'],
    [{ ruleRegistryVersion: 'CG4_RULE_REGISTRY_V2' }, 'UNSUPPORTED_RULE_REGISTRY_VERSION'],
    [{ evaluatorVersion: 'CG4_EVALUATOR_V2' }, 'UNSUPPORTED_EVALUATOR_VERSION'],
  ] as const;
  for (const [overrides, reason] of cases) {
    const result = parse(overrides);
    assert.ok(!result.ok, reason);
    assert.equal(result.reason, reason);
  }
});

test('a payload with a missing or wrongly typed field is rejected as MALFORMED', () => {
  for (const overrides of [
    { subjectId: 42 },
    { subjectVersion: '3' },
    { affectedScope: 'channel=VOICE' },
    { restrictiveness: 'LOOSER' },
    { stateDigest: undefined },
  ]) {
    const result = parse(overrides);
    assert.ok(!result.ok, JSON.stringify(overrides));
    assert.equal(result.reason, 'MALFORMED_PAYLOAD');
  }
  const notObject = parseCg4CanonicalEvent({ eventType: 'policy.changed', payload: [] });
  assert.ok(!notObject.ok);
  assert.equal(notObject.reason, 'MALFORMED_PAYLOAD');
});

test('a field that must not hold PII/actor/evidence is caught even when deeply nested', () => {
  const top = parse({ evidenceRef: 'ticket://INC-1' });
  assert.ok(!top.ok);
  assert.equal(top.reason, 'RESTRICTED_FIELD_PRESENT');

  const nested = parse({ affectedScope: { scopeKey: 'x', actorRef: 'someone@example.com' } });
  assert.ok(!nested.ok);
  assert.equal(nested.reason, 'RESTRICTED_FIELD_PRESENT');

  const inArray = parse({ affectedScope: { scopeKey: 'x' }, extra: [{ phone: '0812345678' }] });
  assert.ok(!inArray.ok);
  assert.equal(inArray.reason, 'RESTRICTED_FIELD_PRESENT');
});

test('an opaque UUID and a reason code are not treated as restricted fields', () => {
  const result = parse({
    subjectId: '2f1c1b3a-0000-4000-8000-000000000000',
    affectedScope: { scopeKey: 'x', channel: 'VOICE', purpose: 'MARKETING' },
  });
  assert.equal(result.ok, true);
});

test('only malformed/restricted are producer-side faults', () => {
  assert.equal(isCg4ProducerSideRejection('MALFORMED_PAYLOAD'), true);
  assert.equal(isCg4ProducerSideRejection('RESTRICTED_FIELD_PRESENT'), true);
  // a newer version can still be sent: the consumer decides on the DLQ itself
  assert.equal(isCg4ProducerSideRejection('UNSUPPORTED_CONTRACT_VERSION'), false);
  assert.equal(isCg4ProducerSideRejection('UNSUPPORTED_EVENT_TYPE'), false);
});
