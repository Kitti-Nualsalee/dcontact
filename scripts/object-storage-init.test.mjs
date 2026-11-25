import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeBuckets } from './object-storage-init.mjs';

function fakeS3({ existing = [], withPolicy = [], unavailableFor = 0 } = {}) {
  const buckets = new Set(existing);
  const sent = [];
  let listCalls = 0;
  const command = (name) =>
    class {
      constructor(input) {
        this.name = name;
        this.input = input;
      }
    };
  const fail = (name, status) =>
    Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } });
  class S3Client {
    async send(request) {
      sent.push(`${request.name}:${request.input.Bucket ?? ''}`);
      switch (request.name) {
        case 'ListBuckets':
          listCalls += 1;
          if (listCalls <= unavailableFor) throw fail('ECONNREFUSED', undefined);
          return {};
        case 'HeadBucket':
          if (!buckets.has(request.input.Bucket)) throw fail('NotFound', 404);
          return {};
        case 'CreateBucket':
          buckets.add(request.input.Bucket);
          return {};
        case 'GetBucketPolicy':
          if (withPolicy.includes(request.input.Bucket)) return { Policy: '{}' };
          throw fail('NoSuchBucketPolicy', 404);
        default:
          throw new Error(`unexpected ${request.name}`);
      }
    }
    destroy() {}
  }
  return {
    sent,
    s3: {
      S3Client,
      ListBucketsCommand: command('ListBuckets'),
      HeadBucketCommand: command('HeadBucket'),
      CreateBucketCommand: command('CreateBucket'),
      GetBucketPolicyCommand: command('GetBucketPolicy'),
    },
  };
}

const options = { environment: {}, sleep: async () => undefined };

test('creates only buckets that do not exist yet, and can be re-run without creating duplicates', async () => {
  const { s3, sent } = fakeS3({ existing: ['recordings'] });
  assert.deepEqual(await initializeBuckets({ ...options, s3 }), [
    'governance-exports',
    'uat-evidence',
  ]);
  assert.ok(!sent.includes('CreateBucket:recordings'));
  assert.deepEqual(await initializeBuckets({ ...options, s3 }), []);
});

test('a bucket that has a bucket policy = failure (a dev bucket must be private)', async () => {
  const { s3 } = fakeS3({ withPolicy: ['uat-evidence'] });
  await assert.rejects(initializeBuckets({ ...options, s3 }), /uat-evidence has a bucket policy/);
});

test('waits for storage to be ready first, and fails when the number of attempts is exceeded', async () => {
  const ready = fakeS3({ unavailableFor: 2 });
  assert.equal((await initializeBuckets({ ...options, s3: ready.s3 })).length, 3);
  const down = fakeS3({ unavailableFor: 99 });
  await assert.rejects(initializeBuckets({ ...options, s3: down.s3, attempts: 3 }), /ECONNREFUSED/);
});
