import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { readS3Bucket, readS3Configuration, resetS3DeprecationWarnings } from './object-storage';

beforeEach(() => resetS3DeprecationWarnings());

test('ใช้ S3_* ก่อนชื่อเดิม และไม่เตือน', () => {
  const warnings: string[] = [];
  const configuration = readS3Configuration({
    environment: {
      S3_ENDPOINT: 'http://object-storage:9000',
      S3_REGION: 'ap-southeast-1',
      S3_ACCESS_KEY: 'app',
      S3_SECRET_KEY: 'app-secret',
      MINIO_ENDPOINT: 'http://minio:9000',
      MINIO_ACCESS_KEY: 'old',
    },
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(configuration, {
    endpoint: 'http://object-storage:9000',
    region: 'ap-southeast-1',
    accessKeyId: 'app',
    secretAccessKey: 'app-secret',
    forcePathStyle: true,
  });
  assert.deepEqual(warnings, []);
});

test('fallback เป็น MINIO_* และเตือน deprecated ครั้งเดียวต่อตัวแปร', () => {
  const warnings: string[] = [];
  const environment = {
    MINIO_ENDPOINT: 'http://minio:9000',
    MINIO_REGION: 'us-west-2',
    MINIO_ACCESS_KEY: 'old',
    MINIO_SECRET_KEY: 'old-secret',
  };
  const warn = (message: string) => warnings.push(message);
  const configuration = readS3Configuration({ environment, warn });
  readS3Configuration({ environment, warn });
  assert.equal(configuration.endpoint, 'http://minio:9000');
  assert.equal(configuration.region, 'us-west-2');
  assert.equal(configuration.accessKeyId, 'old');
  assert.equal(configuration.secretAccessKey, 'old-secret');
  assert.deepEqual(warnings, [
    'MINIO_ENDPOINT is deprecated; use S3_ENDPOINT instead (ADR-029)',
    'MINIO_REGION is deprecated; use S3_REGION instead (ADR-029)',
    'MINIO_ACCESS_KEY is deprecated; use S3_ACCESS_KEY instead (ADR-029)',
    'MINIO_SECRET_KEY is deprecated; use S3_SECRET_KEY instead (ADR-029)',
  ]);
});

test('dev ใช้ค่า default ที่ตรงกับ dev compose ไม่ใช่ minioadmin', () => {
  const configuration = readS3Configuration({ environment: {} });
  assert.equal(configuration.endpoint, 'http://localhost:9000');
  assert.equal(configuration.accessKeyId, 'dcontact');
  assert.equal(configuration.secretAccessKey, 'dcontact-secret');
  assert.equal(configuration.region, 'us-east-1');
});

test('production ต้อง fail closed เมื่อไม่มี endpoint หรือ credential', () => {
  assert.throws(
    () => readS3Configuration({ environment: { NODE_ENV: 'production' } }),
    /S3_ENDPOINT is required/,
  );
  assert.throws(
    () =>
      readS3Configuration({
        environment: { NODE_ENV: 'production', S3_ENDPOINT: 'https://s3', S3_ACCESS_KEY: 'a' },
      }),
    /S3_SECRET_KEY is required/,
  );
});

test('requireExplicit บังคับได้โดยไม่ขึ้นกับ NODE_ENV และแนบ purpose ในข้อความ', () => {
  assert.throws(
    () =>
      readS3Configuration({
        environment: { S3_ENDPOINT: 'http://s3' },
        requireExplicit: true,
        purpose: 'for UAT evidence storage',
      }),
    { message: 'S3_ACCESS_KEY is required for UAT evidence storage' },
  );
});

test('ค่าว่างหรือช่องว่างนับว่าไม่ได้ตั้ง', () => {
  assert.throws(
    () =>
      readS3Configuration({
        environment: { S3_ENDPOINT: '  ', S3_ACCESS_KEY: 'a', S3_SECRET_KEY: 'b' },
        requireExplicit: true,
      }),
    /S3_ENDPOINT is required/,
  );
});

test('S3_FORCE_PATH_STYLE=false ปิด path-style ได้ ค่าอื่นเป็น true', () => {
  assert.equal(
    readS3Configuration({ environment: { S3_FORCE_PATH_STYLE: 'FALSE' } }).forcePathStyle,
    false,
  );
  assert.equal(
    readS3Configuration({ environment: { S3_FORCE_PATH_STYLE: 'true' } }).forcePathStyle,
    true,
  );
});

test('ชื่อ bucket: S3_BUCKET_* ก่อน, ชื่อเดิมพร้อมเตือน, แล้วค่า default', () => {
  const warnings: string[] = [];
  const warn = (message: string) => warnings.push(message);
  assert.equal(readS3Bucket('RECORDINGS', { S3_BUCKET_RECORDINGS: 'rec' }, warn), 'rec');
  assert.equal(
    readS3Bucket('GOVERNANCE_EXPORTS', { GOVERNANCE_EXPORTS_BUCKET: 'exports' }, warn),
    'exports',
  );
  assert.equal(readS3Bucket('UAT_EVIDENCE', {}, warn), 'uat-evidence');
  assert.deepEqual(warnings, [
    'GOVERNANCE_EXPORTS_BUCKET is deprecated; use S3_BUCKET_GOVERNANCE_EXPORTS instead (ADR-029)',
  ]);
});
