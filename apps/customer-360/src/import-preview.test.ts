import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { C360ImportPreviewError, prepareC360ImportPreview } from './import-preview.js';

const source = Buffer.from('name,email\nAlice,alice@example.com\n,invalid\nBob,bob@example.com');
const sourceDigest = createHash('sha256').update(source).digest('hex');
const mapping = { version: 1, columns: { displayName: 'name', email: 'email' } };

test('preview ใช้ core rules นับ invalid และเตือนเฉพาะผลที่ authority อนุญาต', async () => {
  let calls = 0;
  const result = await prepareC360ImportPreview({
    source,
    sourceDigest,
    mapping,
    duplicateAuthority: {
      async hasReadableDuplicate(profile) {
        calls++;
        return profile.displayName === 'Bob';
      },
    },
  });
  assert.deepEqual(result.counts, { valid: 2, invalid: 1, warning: 1 });
  assert.equal(calls, 2);
  assert.deepEqual(
    result.rows.map((row) => row.rowNo),
    [1, 2, 3],
  );
  assert.deepEqual(result.rows[2]?.warnings, ['READABLE_DUPLICATE']);
  assert.equal(result.rows[1]?.valid, false);
  assert.match(result.planHash, /^[0-9a-f]{64}$/);
});

test('plan ผูก source, mapping, rules และ warnings; scope ล้มไม่อ้างว่าไม่มีข้อมูลซ้ำ', async () => {
  const base = { source, sourceDigest, mapping };
  const noDuplicates = await prepareC360ImportPreview({
    ...base,
    duplicateAuthority: {
      async hasReadableDuplicate() {
        return false;
      },
    },
  });
  const duplicate = await prepareC360ImportPreview({
    ...base,
    duplicateAuthority: {
      async hasReadableDuplicate() {
        return true;
      },
    },
  });
  assert.notEqual(noDuplicates.planHash, duplicate.planHash);
  await assert.rejects(
    prepareC360ImportPreview({
      ...base,
      sourceDigest: '0'.repeat(64),
      duplicateAuthority: {
        async hasReadableDuplicate() {
          return false;
        },
      },
    }),
    { code: 'PREVIEW_STALE' },
  );
  await assert.rejects(
    prepareC360ImportPreview({
      ...base,
      duplicateAuthority: {
        async hasReadableDuplicate() {
          throw Error('secret');
        },
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof C360ImportPreviewError);
      assert.equal(error.code, 'SCOPE_UNAVAILABLE');
      assert.doesNotMatch(error.message, /secret/);
      return true;
    },
  );
});
