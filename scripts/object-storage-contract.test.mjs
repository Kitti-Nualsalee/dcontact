import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { loadPresigner, loadS3, objectStorageConfiguration } from './object-storage-readiness.mjs';

// ADR-029 "ผลที่ตามมา": contract ของ S3 API ที่แอปใช้ — ชุดเดียวกันต้องผ่านทั้ง RustFS (dev/CI) และ SeaweedFS
// รันกับ storage จริง: `pnpm test:object-storage:contract` (อ่าน `S3_*`; default = dev compose)
// ใช้ bucket ชั่วคราวและลบทิ้งเสมอ จึงไม่แตะ bucket ของแอป

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

test('path-style: client ตั้ง forcePathStyle และ presigned URL ใช้ bucket ใน path', async () => {
  assert.equal(objectStorageConfiguration().forcePathStyle, true);
  const url = new URL(
    await getSignedUrl(client, new s3.GetObjectCommand({ Bucket: bucket, Key: 'x' }), {
      expiresIn: 60,
    }),
  );
  assert.ok(url.pathname.startsWith(`/${bucket}/`), url.pathname);
});

test('put/get/delete ใต้ tenant prefix; object ที่ลบแล้ว = NoSuchKey', async () => {
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

test('presigned GET ใช้ได้จริง, ตั้ง Content-Disposition ได้ และหมดอายุตามเวลา', async () => {
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

test('lifecycle expiration ต่อ prefix ตั้งและอ่านกลับได้ (UAT evidence ใช้)', async () => {
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
  assert.ok(rule, 'ไม่พบ lifecycle rule');
  assert.equal(rule.Status, 'Enabled');
  assert.equal(rule.Expiration.Days, 90);
  assert.equal(rule.Filter?.Prefix ?? rule.Prefix, 'uat-evidence/');
});

test('bucket ใหม่เป็น private: ไม่มี bucket policy และ GET แบบไม่ลงชื่อถูกปฏิเสธ', async () => {
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

test('HeadBucket: bucket ที่มี = ผ่าน, ไม่มี = 404 (readiness พึ่งพฤติกรรมนี้)', async () => {
  await client.send(new s3.HeadBucketCommand({ Bucket: bucket }));
  await assert.rejects(
    client.send(new s3.HeadBucketCommand({ Bucket: `${bucket}-missing` })),
    (error) => error.$metadata?.httpStatusCode === 404,
  );
});
