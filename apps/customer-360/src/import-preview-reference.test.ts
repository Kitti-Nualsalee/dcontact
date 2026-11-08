import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { createC360CursorCodec } from './profile-read.js';
import {
  openC360ImportPreviewRef,
  openC360ImportRowsCursor,
  sealC360ImportPreviewRef,
  sealC360ImportRowsCursor,
} from './import-preview-reference.js';

test('previewRef และ cursor ผูก owner/job/revision/plan/scope และอายุต้นฉบับ', () => {
  let now = 1000;
  const codec = createC360CursorCodec([{ id: 'test', key: Buffer.alloc(32, 7) }], () => now);
  const context = {
    tenantId: randomUUID(),
    userId: randomUUID(),
    jobId: randomUUID(),
    actorKey: 'a'.repeat(64),
    scopeDigest: 'b'.repeat(64),
    revision: '3',
    planHash: 'c'.repeat(64),
  };
  const ref = sealC360ImportPreviewRef(codec, context);
  openC360ImportPreviewRef(codec, ref, context);
  assert.ok(!Buffer.from(ref.split('.')[2]!, 'base64url').includes(Buffer.from(context.jobId)));
  const cursor = sealC360ImportRowsCursor(codec, context, ref, 20);
  assert.equal(openC360ImportRowsCursor(codec, cursor, context, ref), 20);
  for (const different of [
    { ...context, tenantId: randomUUID() },
    { ...context, userId: randomUUID() },
    { ...context, jobId: randomUUID() },
    { ...context, actorKey: 'f'.repeat(64) },
    { ...context, revision: '4' },
    { ...context, planHash: 'd'.repeat(64) },
    { ...context, scopeDigest: 'e'.repeat(64) },
  ])
    assert.throws(() => openC360ImportPreviewRef(codec, ref, different));
  const parts = ref.split('.');
  parts[2] = `${parts[2]![0] === 'A' ? 'B' : 'A'}${parts[2]!.slice(1)}`;
  assert.throws(() => openC360ImportPreviewRef(codec, parts.join('.'), context));
  const otherRef = sealC360ImportPreviewRef(codec, context);
  assert.throws(() => openC360ImportRowsCursor(codec, cursor, context, otherRef));
  now += 14 * 60_000;
  const laterCursor = sealC360ImportRowsCursor(codec, context, ref, 40);
  now += 60_001;
  assert.throws(() => openC360ImportRowsCursor(codec, laterCursor, context, ref), {
    code: 'CURSOR_EXPIRED',
  });
});
