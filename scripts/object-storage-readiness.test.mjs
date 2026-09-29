import assert from 'node:assert/strict';
import test from 'node:test';
import { missingBuckets, objectStorageConfiguration } from './object-storage-readiness.mjs';

function fakeS3(existing) {
  const clients = [];
  class S3Client {
    constructor(configuration) {
      this.configuration = configuration;
      this.destroyed = false;
      clients.push(this);
    }
    async send(command) {
      if (existing.has(command.input.Bucket)) return {};
      throw Object.assign(new Error('NotFound'), {
        name: 'NotFound',
        $metadata: { httpStatusCode: 404 },
      });
    }
    destroy() {
      this.destroyed = true;
    }
  }
  class HeadBucketCommand {
    constructor(input) {
      this.input = input;
    }
  }
  return { clients, s3: { S3Client, HeadBucketCommand } };
}

test('config ใช้ S3_* ก่อน MINIO_* และ default ตรงกับ dev compose', () => {
  assert.deepEqual(objectStorageConfiguration({}), {
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: 'dcontact', secretAccessKey: 'dcontact-secret' },
  });
  const configuration = objectStorageConfiguration({
    S3_ENDPOINT: 'http://object-storage:9000',
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_ACCESS_KEY: 'legacy',
  });
  assert.equal(configuration.endpoint, 'http://object-storage:9000');
  assert.equal(configuration.credentials.accessKeyId, 'legacy');
});

test('HeadBucket ทุก bucket ที่ต้องมีและรายงานตัวที่ขาดพร้อม status', async () => {
  const { clients, s3 } = fakeS3(new Set(['recordings']));
  const missing = await missingBuckets({ environment: {}, s3 });
  assert.deepEqual(missing, ['uat-evidence (404)']);
  assert.equal(clients.length, 1);
  assert.equal(clients[0].destroyed, true);
});

test('ทุก bucket พร้อม = ไม่มีรายการขาด', async () => {
  const { s3 } = fakeS3(new Set(['recordings', 'uat-evidence']));
  assert.deepEqual(await missingBuckets({ environment: {}, s3 }), []);
});
