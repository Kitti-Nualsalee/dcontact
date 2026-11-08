import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { C360ImportObjectStorage } from './customer-360-import-storage.js';

const endpoint = process.env.C360_IMPORT_S3_CONTRACT_ENDPOINT;
/** รันเฉพาะ S3 sandbox ของ test; ห้ามส่ง endpoint/credential ของ shared หรือ production */
test(
  'M2 S3 contract: conditional put ไม่ทับ object และอ่านด้วย digest เดิม',
  { skip: !endpoint ? 'NOT_RUN: ต้องมี S3 sandbox แยก' : false },
  async (t) => {
    const accessKeyId = process.env.C360_IMPORT_S3_CONTRACT_ACCESS_KEY;
    const secretAccessKey = process.env.C360_IMPORT_S3_CONTRACT_SECRET_KEY;
    assert.ok(endpoint && accessKeyId && secretAccessKey);
    const bucket = `c360-test-${randomUUID()}`;
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    const storage = new C360ImportObjectStorage(client, bucket);
    const identity = { tenantId: randomUUID(), jobId: randomUUID(), objectId: randomUUID() };
    t.after(async () => {
      await storage.delete(identity);
      await client.send(new DeleteBucketCommand({ Bucket: bucket }));
      client.destroy();
    });
    const first = Buffer.from('synthetic source');
    const expected = await storage.put(identity, first);
    await assert.rejects(storage.put(identity, Buffer.from('late write')));
    await assert.rejects(
      client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `c360-imports/${identity.tenantId}/${identity.jobId}/${identity.objectId}`,
          Body: Buffer.from('late write'),
          IfNoneMatch: '*',
        }),
      ),
      (error: unknown) =>
        (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 412,
    );
    assert.deepEqual(await storage.get(identity, expected), first);
  },
);
