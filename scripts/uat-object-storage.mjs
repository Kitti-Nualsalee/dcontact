import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// #540 (ADR-029): one-shot ของ operator สำหรับ object storage ของ UAT (SeaweedFS)
//
//   init — root สร้าง bucket `uat-evidence` แบบ idempotent (HeadBucket ก่อน) และยืนยันว่าไม่มี bucket policy
//
// output เป็น JSON lines ที่มีแค่สถานะ/ชื่อ bucket — ไม่มี secret
// (#541: ถอด `migrate`/`expire-migrated` ของการย้ายจาก MinIO แล้ว — UAT ใช้ SeaweedFS ตั้งแต่ deploy แรก)

export const BUCKET = 'uat-evidence';

// ── runtime ──────────────────────────────────────────────────────────────────────────

/** ops image มี production dependencies ของ api ที่ /app; ใน repo ใช้ของ apps/api */
function appRequire() {
  const base = existsSync('/app/package.json')
    ? '/app/package.json'
    : fileURLToPath(new URL('../apps/api/package.json', import.meta.url));
  return createRequire(base);
}

async function load(name) {
  return import(pathToFileURL(appRequire().resolve(name)).href);
}

function required(environment, name) {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function client(s3, endpoint, accessKeyId, secretAccessKey) {
  return new s3.S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId, secretAccessKey },
  });
}

function rootClient(s3, environment) {
  return client(
    s3,
    required(environment, 'S3_ENDPOINT'),
    required(environment, 'UAT_S3_ROOT_ACCESS_KEY'),
    required(environment, 'UAT_S3_ROOT_SECRET_KEY'),
  );
}

const log = (event) => console.log(JSON.stringify({ type: 'u1.uat.object-storage', ...event }));

async function waitUntilReady(s3, storage, { attempts = 60, delayMs = 1_000 } = {}) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await storage.send(new s3.ListBucketsCommand({}));
      return;
    } catch (error) {
      if (attempt >= attempts) throw error;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function init({ environment = process.env, s3 } = {}) {
  s3 ??= await load('@aws-sdk/client-s3');
  const storage = rootClient(s3, environment);
  try {
    await waitUntilReady(s3, storage);
    let created = false;
    try {
      await storage.send(new s3.HeadBucketCommand({ Bucket: BUCKET }));
    } catch (error) {
      if (error?.$metadata?.httpStatusCode !== 404) throw error;
      await storage.send(new s3.CreateBucketCommand({ Bucket: BUCKET }));
      created = true;
    }
    let policy;
    try {
      policy = (await storage.send(new s3.GetBucketPolicyCommand({ Bucket: BUCKET }))).Policy;
    } catch (error) {
      if (error?.name !== 'NoSuchBucketPolicy') throw error;
    }
    if (policy)
      throw Object.assign(new Error('BUCKET_NOT_PRIVATE'), { reason: 'BUCKET_NOT_PRIVATE' });
    log({ step: 'init', status: 'PASS', bucket: BUCKET, created });
  } finally {
    storage.destroy();
  }
}

async function main(argv) {
  const [command] = argv;
  if (command === 'init') return init();
  throw new Error('usage: uat-object-storage.mjs init');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    log({
      status: 'FAIL',
      reason: error?.reason ?? error?.name ?? 'Error',
      message: error?.message,
    });
    process.exitCode = 1;
  });
}
