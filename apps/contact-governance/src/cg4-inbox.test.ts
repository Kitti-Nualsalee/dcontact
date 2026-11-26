import assert from 'node:assert/strict';
import test from 'node:test';
import type { Cg4EnvelopeParse } from './cg4-event-envelope.js';
import {
  cg4InboxDecisionPausesScope,
  cg4PauseReasonFor,
  classifyCg4InboundEvent,
} from './cg4-inbox.js';

const OK = { ok: true, eventType: 'exception.changed', payload: {} } as unknown as Cg4EnvelopeParse;
const BAD: Cg4EnvelopeParse = {
  ok: false,
  reason: 'UNSUPPORTED_CONTRACT_VERSION',
  detail: 'contractVersion 2 is not supported',
};

function classify(
  cursor: { aggregateVersion: number; payloadHash: string } | undefined,
  incoming: { aggregateVersion: number; payloadHash: string },
  parse: Cg4EnvelopeParse = OK,
) {
  return classifyCg4InboundEvent({ ...(cursor ? { cursor } : {}), incoming, parse });
}

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

test('the next contiguous version can be applied', () => {
  assert.deepEqual(
    classify(
      { aggregateVersion: 4, payloadHash: HASH_A },
      { aggregateVersion: 5, payloadHash: HASH_B },
    ),
    { kind: 'APPLY' },
  );
});

test('the first event of an aggregate must be version 1, otherwise it counts as a gap', () => {
  assert.deepEqual(classify(undefined, { aggregateVersion: 1, payloadHash: HASH_A }), {
    kind: 'APPLY',
  });
  assert.deepEqual(classify(undefined, { aggregateVersion: 7, payloadHash: HASH_A }), {
    kind: 'GAP',
    expectedVersion: 1,
    receivedVersion: 7,
  });
});

test('the same version with the same hash is a duplicate; a different hash is a quarantine', () => {
  const cursor = { aggregateVersion: 4, payloadHash: HASH_A };
  assert.deepEqual(classify(cursor, { aggregateVersion: 4, payloadHash: HASH_A }), {
    kind: 'DUPLICATE',
  });
  const conflict = classify(cursor, { aggregateVersion: 4, payloadHash: HASH_B });
  assert.equal(conflict.kind, 'QUARANTINE');
});

test('a skipped version is a gap and a version going backwards is out-of-order', () => {
  const cursor = { aggregateVersion: 4, payloadHash: HASH_A };
  assert.deepEqual(classify(cursor, { aggregateVersion: 6, payloadHash: HASH_B }), {
    kind: 'GAP',
    expectedVersion: 5,
    receivedVersion: 6,
  });
  assert.deepEqual(classify(cursor, { aggregateVersion: 3, payloadHash: HASH_B }), {
    kind: 'OUT_OF_ORDER',
    appliedVersion: 4,
    receivedVersion: 3,
  });
});

test('a payload that fails to parse is UNSUPPORTED regardless of version', () => {
  const result = classify(
    { aggregateVersion: 4, payloadHash: HASH_A },
    { aggregateVersion: 5, payloadHash: HASH_B },
    BAD,
  );
  assert.equal(result.kind, 'UNSUPPORTED');
  assert.ok(result.kind === 'UNSUPPORTED');
  assert.equal(result.reason, 'UNSUPPORTED_CONTRACT_VERSION');
});

test('every decision other than APPLY/DUPLICATE makes the scope pause with a matching reason', () => {
  const cursor = { aggregateVersion: 4, payloadHash: HASH_A };
  const cases = [
    [classify(cursor, { aggregateVersion: 5, payloadHash: HASH_B }), false, undefined],
    [classify(cursor, { aggregateVersion: 4, payloadHash: HASH_A }), false, undefined],
    [classify(cursor, { aggregateVersion: 6, payloadHash: HASH_B }), true, 'EVENT_GAP'],
    [classify(cursor, { aggregateVersion: 3, payloadHash: HASH_B }), true, 'EVENT_OUT_OF_ORDER'],
    [classify(cursor, { aggregateVersion: 4, payloadHash: HASH_B }), true, 'HASH_CONFLICT'],
    [
      classify(cursor, { aggregateVersion: 5, payloadHash: HASH_B }, BAD),
      true,
      'UNSUPPORTED_CONTRACT',
    ],
  ] as const;
  for (const [decision, pauses, reason] of cases) {
    assert.equal(cg4InboxDecisionPausesScope(decision), pauses, decision.kind);
    assert.equal(cg4PauseReasonFor(decision), reason, decision.kind);
  }
});
