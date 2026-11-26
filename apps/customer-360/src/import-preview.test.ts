import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { C360ImportPreviewError, prepareC360ImportPreview } from './import-preview.js';

const source = Buffer.from('name,email\nAlice,alice@example.com\n,invalid\nBob,bob@example.com');
const sourceDigest = createHash('sha256').update(source).digest('hex');
const mapping = { version: 1, columns: { displayName: 'name', email: 'email' } };

test('preview uses core rules, counts invalid rows and warns only about results the authority allows', async () => {
  let calls = 0;
  const result = await prepareC360ImportPreview({
    source,
    sourceDigest,
    mapping,
    duplicateAuthority: {
      async findReadableDuplicates(profiles) {
        calls++;
        return profiles.map((profile) => profile.displayName === 'Bob');
      },
    },
  });
  assert.deepEqual(result.counts, { valid: 2, invalid: 1, warning: 1 });
  assert.equal(calls, 1);
  assert.deepEqual(
    result.rows.map((row) => row.rowNo),
    [1, 2, 3],
  );
  assert.deepEqual(result.rows[2]?.warnings, ['READABLE_DUPLICATE']);
  assert.equal(result.rows[1]?.valid, false);
  assert.match(result.planHash, /^[0-9a-f]{64}$/);
});

test('plan binds source, mapping and rules but not warnings; a failed scope never claims there are no duplicates', async () => {
  const base = { source, sourceDigest, mapping };
  const noDuplicates = await prepareC360ImportPreview({
    ...base,
    duplicateAuthority: {
      async findReadableDuplicates(profiles) {
        return profiles.map(() => false);
      },
    },
  });
  const duplicate = await prepareC360ImportPreview({
    ...base,
    duplicateAuthority: {
      async findReadableDuplicates(profiles) {
        return profiles.map(() => true);
      },
    },
  });
  assert.equal(noDuplicates.planHash, duplicate.planHash);
  assert.notEqual(
    noDuplicates.planHash,
    (
      await prepareC360ImportPreview({
        ...base,
        mapping: { ...mapping, defaultPhoneCountry: 'US' },
        duplicateAuthority: {
          async findReadableDuplicates(profiles) {
            return profiles.map(() => false);
          },
        },
      })
    ).planHash,
  );
  await assert.rejects(
    prepareC360ImportPreview({
      ...base,
      sourceDigest: '0'.repeat(64),
      duplicateAuthority: {
        async findReadableDuplicates(profiles) {
          return profiles.map(() => false);
        },
      },
    }),
    { code: 'PREVIEW_STALE' },
  );
  await assert.rejects(
    prepareC360ImportPreview({
      ...base,
      duplicateAuthority: {
        async findReadableDuplicates() {
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
  await assert.rejects(
    prepareC360ImportPreview({
      ...base,
      duplicateAuthority: {
        async findReadableDuplicates() {
          return [];
        },
      },
    }),
    { code: 'SCOPE_UNAVAILABLE' },
  );
});

test('preview pins the mapping before awaiting the duplicate authority so the client cannot change the plan midway', async () => {
  const csv = Buffer.from('name,alternate\nAlice,Wrong\nBob,Wrong');
  const mutable = { version: 1, columns: { displayName: 'name' } };
  const seen: string[] = [];
  const result = await prepareC360ImportPreview({
    source: csv,
    sourceDigest: createHash('sha256').update(csv).digest('hex'),
    mapping: mutable,
    duplicateAuthority: {
      async findReadableDuplicates(profiles) {
        seen.push(...profiles.map((profile) => profile.displayName));
        mutable.columns.displayName = 'alternate';
        return profiles.map(() => false);
      },
    },
  });
  assert.deepEqual(seen, ['Alice', 'Bob']);
  assert.deepEqual(result.counts, { valid: 2, invalid: 0, warning: 0 });
});

test('preview with no valid rows still checks the duplicate authority and fails closed when scope is unavailable', async () => {
  const invalidSource = Buffer.from('name\n""');
  const calls: number[] = [];
  const input = {
    source: invalidSource,
    sourceDigest: createHash('sha256').update(invalidSource).digest('hex'),
    mapping: { version: 1, columns: { displayName: 'name' } },
  };
  const result = await prepareC360ImportPreview({
    ...input,
    duplicateAuthority: {
      async findReadableDuplicates(profiles) {
        calls.push(profiles.length);
        return [];
      },
    },
  });
  assert.deepEqual(calls, [0]);
  assert.deepEqual(result.counts, { valid: 0, invalid: 1, warning: 0 });
  await assert.rejects(
    prepareC360ImportPreview({
      ...input,
      duplicateAuthority: {
        async findReadableDuplicates() {
          throw Error('stale scope');
        },
      },
    }),
    { code: 'SCOPE_UNAVAILABLE' },
  );
});
