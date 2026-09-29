import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { loadS3 } from './object-storage-readiness.mjs';

// #540 (ADR-029): สิทธิ์ของ user API ใน UAT บน storage จริง — policy `uat-evidence-api`
// (ตัวเดียวกับ infra/uat/bin/object-storage-entrypoint.sh) ต้องให้ได้เฉพาะสิ่งที่ UatEvidenceObjectStorage ใช้
// รัน: `pnpm test:object-storage:least-privilege` กับ storage ที่บูตด้วย entrypoint ของ UAT
//   S3_ENDPOINT, UAT_S3_ROOT_ACCESS_KEY/SECRET_KEY, UAT_S3_API_ACCESS_KEY/SECRET_KEY

const bucket = 'uat-evidence';
const other = 'least-privilege-other';
let s3;
let root;
let api;

function required(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function client(accessKeyId, secretAccessKey) {
  return new s3.S3Client({
    endpoint: required('S3_ENDPOINT'),
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

async function denied(promise) {
  await assert.rejects(
    promise,
    (error) => error.name === 'AccessDenied' || error.$metadata?.httpStatusCode === 403,
  );
}

before(async () => {
  s3 = await loadS3();
  root = client(required('UAT_S3_ROOT_ACCESS_KEY'), required('UAT_S3_ROOT_SECRET_KEY'));
  api = client(required('UAT_S3_API_ACCESS_KEY'), required('UAT_S3_API_SECRET_KEY'));
  for (const name of [bucket, other]) {
    try {
      await root.send(new s3.HeadBucketCommand({ Bucket: name }));
    } catch {
      await root.send(new s3.CreateBucketCommand({ Bucket: name }));
    }
  }
  await root.send(new s3.PutObjectCommand({ Bucket: other, Key: 'recordings/t/x.wav', Body: 'x' }));
  await root.send(new s3.PutObjectCommand({ Bucket: bucket, Key: 'other/secret.txt', Body: 'x' }));
});

test('API ทำสิ่งที่ ensureBucket ต้องใช้ได้: HeadBucket, lifecycle, GetBucketPolicy (= NoSuchBucketPolicy)', async () => {
  await api.send(new s3.HeadBucketCommand({ Bucket: bucket }));
  await api.send(
    new s3.PutBucketLifecycleConfigurationCommand({
      Bucket: bucket,
      LifecycleConfiguration: {
        Rules: [
          {
            ID: 'uat-evidence-retention-90d',
            Status: 'Enabled',
            Filter: { Prefix: 'uat-evidence/' },
            Expiration: { Days: 90 },
          },
        ],
      },
    }),
  );
  await api.send(new s3.GetBucketLifecycleConfigurationCommand({ Bucket: bucket }));
  await assert.rejects(
    api.send(new s3.GetBucketPolicyCommand({ Bucket: bucket })),
    (error) => error.name === 'NoSuchBucketPolicy',
  );
});

test('API put/get/delete ได้ใต้ uat-evidence/ เท่านั้น', async () => {
  const key = 'uat-evidence/t/r/least-privilege.png';
  await api.send(new s3.PutObjectCommand({ Bucket: bucket, Key: key, Body: 'png' }));
  await api.send(new s3.GetObjectCommand({ Bucket: bucket, Key: key }));
  await api.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: key }));
  await denied(api.send(new s3.PutObjectCommand({ Bucket: bucket, Key: 'other/x', Body: 'x' })));
  await denied(api.send(new s3.GetObjectCommand({ Bucket: bucket, Key: 'other/secret.txt' })));
  await denied(api.send(new s3.DeleteObjectCommand({ Bucket: bucket, Key: 'other/secret.txt' })));
  await denied(api.send(new s3.GetObjectCommand({ Bucket: bucket, Key: 'migration/x.json' })));
});

test('API แตะ bucket อื่นหรือสร้าง bucket ใหม่ไม่ได้', async () => {
  await denied(api.send(new s3.GetObjectCommand({ Bucket: other, Key: 'recordings/t/x.wav' })));
  await denied(api.send(new s3.PutObjectCommand({ Bucket: other, Key: 'y', Body: 'x' })));
  await denied(api.send(new s3.CreateBucketCommand({ Bucket: 'api-made-bucket' })));
});

test('API เปิด bucket เป็น public หรือลบ bucket ไม่ได้', async () => {
  const policy = JSON.stringify({
    Version: '2012-10-17',
    Statement: [
      {
        Effect: 'Allow',
        Principal: '*',
        Action: 's3:GetObject',
        Resource: `arn:aws:s3:::${bucket}/*`,
      },
    ],
  });
  await denied(api.send(new s3.PutBucketPolicyCommand({ Bucket: bucket, Policy: policy })));
  await denied(api.send(new s3.PutBucketAclCommand({ Bucket: bucket, ACL: 'public-read' })));
  await denied(api.send(new s3.DeleteBucketCommand({ Bucket: bucket })));
});

test('ListBuckets ของ API เห็นเฉพาะ uat-evidence', async () => {
  const listed = await api.send(new s3.ListBucketsCommand({}));
  assert.deepEqual(
    (listed.Buckets ?? []).map((entry) => entry.Name),
    [bucket],
  );
});

test('ไม่มี anonymous access', async () => {
  const response = await fetch(`${required('S3_ENDPOINT')}/${bucket}/other/secret.txt`);
  assert.equal(response.status, 403);
});
