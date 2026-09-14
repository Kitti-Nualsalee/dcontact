import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cg4RefDigest,
  isCg4RedactedRef,
  redactCg4Actor,
  redactCg4Ref,
  resolveCg4EvidenceAccess,
} from './cg4-redaction.js';

test('summary viewer เห็นแค่ digest ส่วน evidence viewer เห็นค่าจริง', () => {
  const summary = redactCg4Ref('ticket://INC-4821', 'SUMMARY');
  assert.ok(isCg4RedactedRef(summary));
  assert.equal(summary.digest, cg4RefDigest('ticket://INC-4821'));
  assert.equal(redactCg4Ref('ticket://INC-4821', 'EVIDENCE'), 'ticket://INC-4821');
});

test('digest ไม่เผยค่าเดิมแต่ยัง correlate ค่าซ้ำได้', () => {
  const left = redactCg4Ref('evidence://a', 'SUMMARY');
  const right = redactCg4Ref('evidence://a', 'SUMMARY');
  const other = redactCg4Ref('evidence://b', 'SUMMARY');
  assert.deepEqual(left, right);
  assert.notDeepEqual(left, other);
  assert.ok(isCg4RedactedRef(left));
  assert.equal(left.digest.length, 16);
  assert.doesNotMatch(left.digest, /evidence/);
});

test('ค่าที่ไม่มีถูกคืนเป็น undefined ไม่ใช่ digest ของค่าว่าง', () => {
  assert.equal(redactCg4Ref(undefined, 'SUMMARY'), undefined);
  assert.equal(redactCg4Ref(null, 'EVIDENCE'), undefined);
});

test('actor ref ถูกปิดบังสำหรับ summary viewer เสมอ แม้เป็น opaque subject id', () => {
  const actor = redactCg4Actor('subject-42', 'SUMMARY');
  assert.ok(isCg4RedactedRef(actor));
  assert.equal(redactCg4Actor('subject-42', 'EVIDENCE'), 'subject-42');
});

test('evidence access มาจาก capability ที่ resolve แล้วเท่านั้น ไม่ใช่ role', () => {
  assert.equal(resolveCg4EvidenceAccess({ capabilities: [] }), 'SUMMARY');
  assert.equal(
    resolveCg4EvidenceAccess({ capabilities: [{ capability: 'cg.exception.request' }] }),
    'SUMMARY',
  );
  assert.equal(
    resolveCg4EvidenceAccess({ capabilities: [{ capability: 'cg.policy.draft' }] }),
    'SUMMARY',
  );
  for (const capability of [
    'cg.exception.approve.standard',
    'cg.exception.approve.high',
    'cg.exception.revoke',
    'cg.policy.publish',
    'cg.policy.publish.relaxation',
    'cg.policy.rollback',
  ]) {
    assert.equal(
      resolveCg4EvidenceAccess({ capabilities: [{ capability }] }),
      'EVIDENCE',
      capability,
    );
  }
});

test('capability ที่ไม่รู้จักไม่ยกระดับเป็น evidence', () => {
  assert.equal(
    resolveCg4EvidenceAccess({
      capabilities: [{ capability: 'admin' }, { capability: 'compliance' }, { capability: '*' }],
    }),
    'SUMMARY',
  );
});
