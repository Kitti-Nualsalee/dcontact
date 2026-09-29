/**
 * U1.5 (#433): object storage ของหลักฐาน UAT — retention 90 วัน, bucket ส่วนตัว, key อยู่ใต้ prefix เสมอ
 * ใช้ S3 client ปลอมที่จด command ทุกตัว เพื่อยืนยัน input ที่ส่งไป storage ตรงตัว
 */
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CreateBucketCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { UatEvidenceObjectStorage, type UatEvidenceS3Client } from './uat-evidence-storage.js';

function named(name: string): Error {
  const error = new Error(name);
  error.name = name;
  return error;
}

function notFound(): Error {
  return Object.assign(named('NotFound'), { $metadata: { httpStatusCode: 404 } });
}

function fakeClient(respond: (command: object) => unknown = () => ({})) {
  const sent: object[] = [];
  const client: UatEvidenceS3Client = {
    send: async (command) => {
      sent.push(command);
      const result = respond(command);
      if (result instanceof Error) throw result;
      return result;
    },
  };
  return { client, sent };
}

/** ไม่มี policy บน bucket = S3 ตอบ NoSuchBucketPolicy */
const privateBucket = (command: object) =>
  command instanceof GetBucketPolicyCommand ? named('NoSuchBucketPolicy') : {};

/** bucket ยังไม่มี: HeadBucket = 404 */
const missingBucket = (command: object) =>
  command instanceof HeadBucketCommand ? notFound() : privateBucket(command);

test('U1.5 ensureBucket สร้าง bucket แบบ idempotent และตั้ง lifecycle หมดอายุ 90 วันบน prefix', async () => {
  const { client, sent } = fakeClient(missingBucket);
  await new UatEvidenceObjectStorage(client, 'uat-evidence').ensureBucket();
  assert.deepEqual(
    sent.map((command) => command.constructor.name),
    [
      'HeadBucketCommand',
      'CreateBucketCommand',
      'PutBucketLifecycleConfigurationCommand',
      'GetBucketPolicyCommand',
    ],
  );
  assert.deepEqual((sent[1] as CreateBucketCommand).input, { Bucket: 'uat-evidence' });
  assert.deepEqual((sent[2] as PutBucketLifecycleConfigurationCommand).input, {
    Bucket: 'uat-evidence',
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
  });

  // แข่งกันสร้างหลัง Head 404: BucketAlreadyOwnedByYou = ของเรา ตั้ง lifecycle ต่อ
  const race = fakeClient((command) =>
    command instanceof CreateBucketCommand
      ? named('BucketAlreadyOwnedByYou')
      : missingBucket(command),
  );
  await new UatEvidenceObjectStorage(race.client, 'uat-evidence').ensureBucket();
  assert.ok(race.sent[2] instanceof PutBucketLifecycleConfigurationCommand);
  // แข่งแล้วเจ้าของอื่นได้ไป (Head 404 → BucketAlreadyExists) = บูตไม่ผ่าน
  const foreign = fakeClient((command) =>
    command instanceof CreateBucketCommand ? named('BucketAlreadyExists') : missingBucket(command),
  );
  await assert.rejects(
    new UatEvidenceObjectStorage(foreign.client, 'uat-evidence').ensureBucket(),
    /BucketAlreadyExists/,
  );
});

test('#540 bucket ที่ bootstrap สร้างด้วย root: Head 200 = ไม่เรียก CreateBucket (SeaweedFS ตอบ BucketAlreadyExists)', async () => {
  const { client, sent } = fakeClient((command) =>
    command instanceof CreateBucketCommand ? named('BucketAlreadyExists') : privateBucket(command),
  );
  await new UatEvidenceObjectStorage(client, 'uat-evidence').ensureBucket();
  assert.deepEqual(
    sent.map((command) => command.constructor.name),
    ['HeadBucketCommand', 'PutBucketLifecycleConfigurationCommand', 'GetBucketPolicyCommand'],
  );
});

test('#540 HeadBucket ถูกปฏิเสธ (403) = บูตไม่ผ่าน ไม่พยายามสร้าง bucket', async () => {
  const forbidden = Object.assign(named('Forbidden'), { $metadata: { httpStatusCode: 403 } });
  const { client, sent } = fakeClient((command) =>
    command instanceof HeadBucketCommand ? forbidden : privateBucket(command),
  );
  await assert.rejects(
    new UatEvidenceObjectStorage(client, 'uat-evidence').ensureBucket(),
    /Forbidden/,
  );
  assert.equal(sent.length, 1);
});

test('U1.5 bucket ต้องเป็นส่วนตัว: มี bucket policy = บูตไม่ผ่าน และ adapter ไม่ตั้ง policy/ACL เอง', async () => {
  const policy = JSON.stringify({
    Statement: [{ Effect: 'Allow', Principal: '*', Action: 's3:GetObject' }],
  });
  const { client, sent } = fakeClient((command) =>
    command instanceof GetBucketPolicyCommand ? { Policy: policy } : {},
  );
  await assert.rejects(
    new UatEvidenceObjectStorage(client, 'uat-evidence').ensureBucket(),
    /must not have a bucket policy/,
  );
  for (const command of sent) {
    assert.doesNotMatch(command.constructor.name, /Policy.*Put|Put.*Policy|Acl/i);
  }
});

test('U1.5 put/get/delete ใช้ key ใต้ uat-evidence/ เท่านั้น; object หาย = null', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const { client, sent } = fakeClient((command) => {
    if (command instanceof GetObjectCommand) {
      if (command.input.Key?.endsWith('/gone')) return named('NoSuchKey');
      return { Body: { transformToByteArray: async () => bytes } };
    }
    return {};
  });
  const storage = new UatEvidenceObjectStorage(client, 'uat-evidence');
  const key = 'uat-evidence/tenant/run/evidence';
  await storage.putObject({ key, bytes, contentType: 'image/png', sha256: 'a'.repeat(64) });
  const put = (sent[0] as PutObjectCommand).input;
  assert.deepEqual(
    { ...put, Body: undefined },
    {
      Bucket: 'uat-evidence',
      Key: key,
      Body: undefined,
      ContentType: 'image/png',
      ContentLength: 3,
      CacheControl: 'private, no-store',
      Metadata: { sha256: 'a'.repeat(64) },
    },
  );
  assert.equal('ACL' in put, false);
  assert.deepEqual(await storage.getObject(key), bytes);
  assert.equal(await storage.getObject('uat-evidence/tenant/run/gone'), null);
  await assert.rejects(storage.getObject('recordings/tenant/x'), /outside the uat-evidence prefix/);
  await assert.rejects(storage.deleteObject('../x'), /outside the uat-evidence prefix/);
});

test('UAT ไม่มี default credential: endpoint/access/secret ของ object storage ต้องระบุเสมอ', () => {
  const complete = {
    S3_ENDPOINT: 'http://object-storage:9000',
    S3_ACCESS_KEY: 'uat-evidence-writer',
    S3_SECRET_KEY: 'x'.repeat(24),
  };
  assert.equal(UatEvidenceObjectStorage.fromEnvironment(complete).bucket, 'uat-evidence');
  for (const name of Object.keys(complete) as (keyof typeof complete)[]) {
    assert.throws(
      () => UatEvidenceObjectStorage.fromEnvironment({ ...complete, [name]: ' ' }),
      new RegExp(`${name} is required`),
    );
  }
});

test('UAT ยังอ่าน MINIO_* และ UAT_EVIDENCE_BUCKET เดิมได้ช่วงเปลี่ยนผ่าน (ADR-029)', () => {
  const storage = UatEvidenceObjectStorage.fromEnvironment({
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ACCESS_KEY: 'uat-evidence-writer',
    MINIO_SECRET_KEY: 'x'.repeat(24),
    UAT_EVIDENCE_BUCKET: 'legacy-evidence',
  });
  assert.equal(storage.bucket, 'legacy-evidence');
});
