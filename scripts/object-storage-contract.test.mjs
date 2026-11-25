import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { loadPresigner, loadS3, objectStorageConfiguration } from './object-storage-readiness.mjs';

// ADR-029 "Consequences": the contract of the S3 API the app uses - the same set must pass on both RustFS (dev/CI) and SeaweedFS
// runs against real storage: `pnpm test:object-storage:contract` (reads `S3_*`; default = the dev compose)
// uses a temporary bucket that is always deleted, so it does not touch the app buckets

const tenant = '11111111-1111-4111-8111-111111111111';
const bucket = `contract-${randomUUID().slice(0, 8)}`;
let s3;
let client;
let getSignedUrl;

before(async () => {
  s3 = await loadS3();
  ({ getSignedUrl } = await loadPresigner());
  client = new s3.S3Client(objectStorageConfiguration());
  await client.send(new s3.CreateBucketCommand({ Bucket: bucket }));
});

after(async () => {
  if (!client) return;
  const listed = await client.send(new s3.ListObjectsV2Command({ Bucket: bucket }));
  for (const object of listed.Contents ?? []) {
    await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: object.Key }));
  }
  await client.send(new s3.DeleteBucketCommand({ Bucket: bucket }));
  client.destroy();
});

test('path-style: the client sets forcePathStyle and the presigned URL uses the bucket in the path', async () => {
  assert.equal(objectStorageConfiguration().forcePathStyle, true);
  const url = new URL(
    await getSignedUrl(client, new s3.GetObjectCommand({ Bucket: bucket, Key: 'x' }), {
      expiresIn: 60,
    }),
  );
  assert.ok(url.pathname.startsWith(`/${bucket}/`), url.pathname);
});

test('put/get/delete under the tenant prefix; a deleted object = NoSuchKey', async () => {
  const key = `recordings/${tenant}/contract.wav`;
  const body = new Uint8Array([82, 73, 70, 70, 1, 2, 3]);
  await client.send(
    new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'audio/wav' }),
  );
  const got = await client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
  assert.deepEqual(new Uint8Array(await got.Body.transformToByteArray()), body);
  assert.equal(got.ContentType, 'audio/wav');
  const listed = await client.send(
    new s3.ListObjectsV2Command({ Bucket: bucket, Prefix: `recordings/${tenant}/` }),
  );
  assert.deepEqual(
    listed.Contents.map((object) => object.Key),
    [key],
  );
  await client.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
  await assert.rejects(
    client.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key })),
    (error) => error.name === 'NoSuchKey',
  );
});

test('a presigned GET really works, can set Content-Disposition, and expires on time', async () => {
  const key = `governance-exports/${tenant}/contract.json`;
  await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: '{"ok":true}' }));
  const url = await getSignedUrl(
    client,
    new s3.GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentDisposition: 'attachment' }),
    { expiresIn: 60 },
  );
  const response = await fetch(url);
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  assert.equal(response.headers.get('content-disposition'), 'attachment');

  const shortLived = await getSignedUrl(
    client,
    new s3.GetObjectCommand({ Bucket: bucket, Key: key }),
    { expiresIn: 1 },
  );
  await new Promise((resolve) => setTimeout(resolve, 2_500));
  assert.equal((await fetch(shortLived)).status, 403);

  const tampered = new URL(url);
  tampered.pathname = tampered.pathname.replace('contract.json', 'other.json');
  assert.equal((await fetch(tampered)).status, 403);
});

test('lifecycle expiration per prefix can be set and read back (used by UAT evidence)', async () => {
  await client.send(
    new s3.PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'contract-retention-90d',
            Status: 'Enabled',
            Filter: { Prefix: 'uat-evidence/' },
            Expiration: { Days: 90 },
          },
        ],
      },
    }),
  );
  const lifecycle = await client.send(
    new s3.GetBucketLifecycleConfigurationCommand({ Bucket: bucket }),
  );
  const rule = lifecycle.Rules.find((candidate) => candidate.ID === 'contract-retention-90d');
  assert.ok(rule, 'lifecycle rule not found');
  assert.equal(rule.Status, 'Enabled');
  assert.equal(rule.Expiration.Days, 90);
  assert.equal(rule.Filter?.Prefix ?? rule.Prefix, 'uat-evidence/');
});

test('a new bucket is private: no bucket policy and an unsigned GET is rejected', async () => {
  await assert.rejects(
    client.send(new s3.GetBucketPolicyCommand({ Bucket: bucket })),
    (error) => error.name === 'NoSuchBucketPolicy',
  );
  const key = `recordings/${tenant}/private.wav`;
  await client.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: 'x' }));
  const { endpoint } = objectStorageConfiguration();
  const anonymous = await fetch(`${endpoint.replace(/\/$/, '')}/${bucket}/${key}`);
  assert.equal(anonymous.status, 403);
});

test('HeadBucket: an existing bucket = passes, a missing one = 404 (readiness depends on this behavior)', async () => {
  await client.send(new s3.HeadBucketCommand({ Bucket: bucket }));
  await assert.rejects(
    client.send(new s3.HeadBucketCommand({ Bucket: `${bucket}-missing` })),
    (error) => error.$metadata?.httpStatusCode === 404,
  );
});
