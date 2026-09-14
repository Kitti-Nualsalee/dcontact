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
  detail: 'contractVersion 2 ไม่รองรับ',
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

test('version ถัดไปแบบต่อเนื่อง apply ได้', () => {
  assert.deepEqual(
    classify(
      { aggregateVersion: 4, payloadHash: HASH_A },
      { aggregateVersion: 5, payloadHash: HASH_B },
    ),
    { kind: 'APPLY' },
  );
});

test('event แรกของ aggregate ต้องเป็น version 1 ไม่งั้นถือว่ามี gap', () => {
  assert.deepEqual(classify(undefined, { aggregateVersion: 1, payloadHash: HASH_A }), {
    kind: 'APPLY',
  });
  assert.deepEqual(classify(undefined, { aggregateVersion: 7, payloadHash: HASH_A }), {
    kind: 'GAP',
    expectedVersion: 1,
    receivedVersion: 7,
  });
});

test('version เดิม hash เดิมเป็น duplicate; hash ต่างเป็น quarantine', () => {
  const cursor = { aggregateVersion: 4, payloadHash: HASH_A };
  assert.deepEqual(classify(cursor, { aggregateVersion: 4, payloadHash: HASH_A }), {
    kind: 'DUPLICATE',
  });
  const conflict = classify(cursor, { aggregateVersion: 4, payloadHash: HASH_B });
  assert.equal(conflict.kind, 'QUARANTINE');
});

test('version ที่ข้ามเป็น gap และ version ที่ย้อนหลังเป็น out-of-order', () => {
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

test('payload ที่ parse ไม่ผ่านเป็น UNSUPPORTED โดยไม่สนใจ version', () => {
  const result = classify(
    { aggregateVersion: 4, payloadHash: HASH_A },
    { aggregateVersion: 5, payloadHash: HASH_B },
    BAD,
  );
  assert.equal(result.kind, 'UNSUPPORTED');
  assert.ok(result.kind === 'UNSUPPORTED');
  assert.equal(result.reason, 'UNSUPPORTED_CONTRACT_VERSION');
});

test('ทุก decision ที่ไม่ใช่ APPLY/DUPLICATE ทำให้ scope ถูก pause พร้อม reason ที่ตรงกัน', () => {
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
