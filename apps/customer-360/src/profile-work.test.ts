import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes, randomUUID } from 'node:crypto';
import { createC360CursorCodec, c360FilterDigest } from './profile-read.js';
import {
  normalizeC360WorkPatch,
  normalizeC360WorkSearch,
  openC360WorkCandidate,
} from './profile-work.js';
test('Agent patch ไม่รับ VIP/points/tags และ search ไม่เปิด NAME directory', () => {
  for (const field of ['vip', 'points', 'tags'])
    assert.throws(() =>
      normalizeC360WorkPatch({ commandId: randomUUID(), displayName: 'ชื่อ', [field]: true }),
    );
  assert.throws(() => normalizeC360WorkSearch({ type: 'NAME', query: 'name' }));
  assert.throws(() => normalizeC360WorkSearch({ type: 'PHONE', query: '0812345678' }));
  assert.deepEqual(normalizeC360WorkPatch({ displayName: '  ชื่อ  ', company: '' }), {
    displayName: 'ชื่อ',
    company: null,
  });
});
test('CandidateRef เข้ารหัส, TTL5นาที และผูก work/actor/team-scope/linkage', () => {
  const now = Date.now();
  const codec = createC360CursorCodec([{ id: 'test', key: randomBytes(32) }], () => now);
  const actor = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    role: 'AGENT' as const,
    teamId: randomUUID(),
  };
  const work = {
    interactionId: randomUUID(),
    contactId: null,
    linkageRevision: '0',
    state: 'ACTIVE',
    scopeVersion: '7',
    leaseId: randomUUID(),
  };
  const contactId = randomUUID();
  const ref = codec.seal({
    tenantId: actor.tenantId,
    userId: actor.userId,
    scope: c360FilterDigest([actor.teamId, work.scopeVersion, work.leaseId, work.linkageRevision]),
    kind: 'work-candidate-ref',
    filter: c360FilterDigest([work.interactionId]),
    position: [contactId, '0', 'query-digest', String(now + 300000)],
  });
  assert.equal(ref.includes(contactId), false);
  assert.equal(openC360WorkCandidate(actor, work, ref, codec, now).contactId, contactId);
  assert.throws(
    () => openC360WorkCandidate(actor, work, ref, codec, now + 300000),
    /CANDIDATE_EXPIRED/,
  );
  assert.throws(() =>
    openC360WorkCandidate(actor, { ...work, linkageRevision: '1' }, ref, codec, now),
  );
  assert.throws(() =>
    openC360WorkCandidate({ ...actor, userId: randomUUID() }, work, ref, codec, now),
  );
  assert.throws(() =>
    openC360WorkCandidate(actor, { ...work, interactionId: randomUUID() }, ref, codec, now),
  );
  assert.throws(() => openC360WorkCandidate(actor, work, ref.slice(0, -4) + 'AAAA', codec, now));
});
