import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import test from 'node:test';
import {
  DeleteObjectCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import {
  C360ImportObjectStorage,
  C360ImportStorageError,
  C360_IMPORT_STORAGE_MAX_BYTES,
} from './customer-360-import-storage.js';

const identity = () => ({ tenantId: randomUUID(), jobId: randomUUID(), objectId: randomUUID() });
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');

test('private object key ผูก tenant/job/id และ read ตรวจ digest โดยไม่ออก public URL', async () => {
  const id = identity();
  const bytes = Buffer.from('private,ข้อมูล');
  let stored: Buffer | undefined;
  const calls: object[] = [];
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        calls.push(command);
        if (command instanceof PutObjectCommand) {
          assert.equal(command.input.Bucket, 'private-imports');
          assert.equal(command.input.Key, `c360-imports/${id.tenantId}/${id.jobId}/${id.objectId}`);
          assert.equal(command.input.CacheControl, 'private, no-store');
          assert.equal(command.input.IfNoneMatch, '*');
          stored = Buffer.from(command.input.Body as Uint8Array);
          return {};
        }
        if (command instanceof GetObjectCommand) return { Body: Readable.from([stored!]) };
        if (command instanceof DeleteObjectCommand) return {};
        throw Error('unexpected command');
      },
    },
    'private-imports',
  );
  assert.equal(await storage.put(id, bytes), digest(bytes));
  assert.deepEqual(await storage.get(id, digest(bytes)), bytes);
  await storage.delete(id);
  assert.equal(calls.length, 3);
});

test('ปฏิเสธ key แปลก, object ใหญ่, digest ไม่ตรง และซ่อนข้อความจาก storage', async () => {
  const id = identity();
  const storage = new C360ImportObjectStorage(
    {
      async send() {
        return { Body: Readable.from([Buffer.from('private data')]) };
      },
    },
    'private-imports',
  );
  await assert.rejects(
    storage.get({ ...id, objectId: '../secret' }, 'a'.repeat(64)),
    C360ImportStorageError,
  );
  await assert.rejects(
    storage.put(id, new Uint8Array(C360_IMPORT_STORAGE_MAX_BYTES + 1)),
    C360ImportStorageError,
  );
  await assert.rejects(storage.get(id, 'a'.repeat(64)), C360ImportStorageError);
  const oversized = new C360ImportObjectStorage(
    {
      async send() {
        return {
          Body: Readable.from([Buffer.alloc(C360_IMPORT_STORAGE_MAX_BYTES), Buffer.alloc(1)]),
        };
      },
    },
    'private-imports',
  );
  await assert.rejects(oversized.get(id, 'a'.repeat(64)), C360ImportStorageError);
  const failing = new C360ImportObjectStorage(
    {
      async send() {
        throw Error('secret from storage');
      },
    },
    'private-imports',
  );
  await assert.rejects(failing.put(id, Buffer.from('private')), { message: 'STORAGE_UNAVAILABLE' });
});

test('ไม่มี object ต่างจาก bucket/storage ล้ม และ config ต้องระบุ bucket เฉพาะ', async () => {
  const id = identity();
  const missing = new C360ImportObjectStorage(
    {
      async send() {
        throw Object.assign(Error(), { name: 'NoSuchKey' });
      },
    },
    'private-imports',
  );
  assert.equal(await missing.get(id, 'a'.repeat(64)), null);
  const bucketMissing = new C360ImportObjectStorage(
    {
      async send() {
        throw Object.assign(Error(), { name: 'NoSuchBucket', $metadata: { httpStatusCode: 404 } });
      },
    },
    'private-imports',
  );
  await assert.rejects(bucketMissing.get(id, 'a'.repeat(64)), C360ImportStorageError);
  assert.throws(() => C360ImportObjectStorage.fromEnvironment({}), C360ImportStorageError);
});

test('readiness ต้องเข้าถึง bucket ได้และปฏิเสธ bucket policy ที่ตรวจพบ', async () => {
  const noPolicy = new C360ImportObjectStorage(
    {
      async send(command) {
        if (command instanceof HeadBucketCommand) return {};
        if (command instanceof GetBucketPolicyCommand)
          throw Object.assign(Error(), { name: 'NoSuchBucketPolicy' });
        throw Error('unexpected');
      },
    },
    'private-imports',
  );
  await noPolicy.checkBucketPolicy();
  const withPolicy = new C360ImportObjectStorage(
    {
      async send(command) {
        return command instanceof GetBucketPolicyCommand ? { Policy: '{}' } : {};
      },
    },
    'private-imports',
  );
  await assert.rejects(withPolicy.checkBucketPolicy(), C360ImportStorageError);
  const unavailable = new C360ImportObjectStorage(
    {
      async send() {
        throw Error('service down');
      },
    },
    'private-imports',
  );
  await assert.rejects(unavailable.checkBucketPolicy(), C360ImportStorageError);
});

test('UUID ขนาดตัวอักษรต่างกันใช้ key เดียวและ conditional put ไม่เขียนทับ object เดิม', async () => {
  const id = identity();
  const original = Buffer.from('original');
  const stored = new Map<string, Buffer>();
  const storage = new C360ImportObjectStorage(
    {
      async send(command) {
        if (command instanceof PutObjectCommand) {
          const key = command.input.Key!;
          if (stored.has(key) && command.input.IfNoneMatch === '*')
            throw Object.assign(Error(), { name: 'PreconditionFailed' });
          stored.set(key, Buffer.from(command.input.Body as Uint8Array));
          return {};
        }
        if (command instanceof GetObjectCommand)
          return { Body: Readable.from([stored.get(command.input.Key!)!]) };
        throw Error('unexpected command');
      },
    },
    'private-imports',
  );
  const upper = {
    tenantId: id.tenantId.toUpperCase(),
    jobId: id.jobId.toUpperCase(),
    objectId: id.objectId.toUpperCase(),
  };
  await storage.put(upper, original);
  await assert.rejects(storage.put(id, Buffer.from('replacement')), C360ImportStorageError);
  assert.deepEqual(await storage.get(id, digest(original)), original);
});
