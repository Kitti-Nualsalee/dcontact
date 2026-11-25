import assert from 'node:assert/strict';
import test from 'node:test';
import {
  cg4RefDigest,
  isCg4RedactedRef,
  redactCg4Actor,
  redactCg4Ref,
  resolveCg4EvidenceAccess,
} from './cg4-redaction.js';

test('a summary viewer sees only the digest while an evidence viewer sees the real value', () => {
  const summary = redactCg4Ref('ticket://INC-4821', 'SUMMARY');
  assert.ok(isCg4RedactedRef(summary));
  assert.equal(summary.digest, cg4RefDigest('ticket://INC-4821'));
  assert.equal(redactCg4Ref('ticket://INC-4821', 'EVIDENCE'), 'ticket://INC-4821');
});

test('the digest does not reveal the original value but can still correlate repeated values', () => {
  const left = redactCg4Ref('evidence://a', 'SUMMARY');
  const right = redactCg4Ref('evidence://a', 'SUMMARY');
  const other = redactCg4Ref('evidence://b', 'SUMMARY');
  assert.deepEqual(left, right);
  assert.notDeepEqual(left, other);
  assert.ok(isCg4RedactedRef(left));
  assert.equal(left.digest.length, 16);
  assert.doesNotMatch(left.digest, /evidence/);
});

test('a missing value is returned as undefined, not the digest of an empty value', () => {
  assert.equal(redactCg4Ref(undefined, 'SUMMARY'), undefined);
  assert.equal(redactCg4Ref(null, 'EVIDENCE'), undefined);
});

test('the actor ref is always masked for a summary viewer, even if it is an opaque subject id', () => {
  const actor = redactCg4Actor('subject-42', 'SUMMARY');
  assert.ok(isCg4RedactedRef(actor));
  assert.equal(redactCg4Actor('subject-42', 'EVIDENCE'), 'subject-42');
});

test('evidence access comes only from a resolved capability, not a role', () => {
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

test('an unknown capability does not escalate to evidence', () => {
  assert.equal(
    resolveCg4EvidenceAccess({
      capabilities: [{ capability: 'admin' }, { capability: 'compliance' }, { capability: '*' }],
    }),
    'SUMMARY',
  );
});
