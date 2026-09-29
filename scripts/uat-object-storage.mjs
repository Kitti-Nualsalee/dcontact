import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// #540 (ADR-029): one-shot/long-running ของ operator สำหรับ object storage ของ UAT (SeaweedFS)
//
//   init             — root สร้าง bucket `uat-evidence` แบบ idempotent (HeadBucket ก่อน) และยืนยันว่าไม่มี bucket policy
//   migrate          — คัดลอกหลักฐานจาก MinIO เดิม → SeaweedFS คง key เดิม, ตรวจ sha256 กับ uat_run_evidence
//                      และเขียน manifest วันหมดอายุเดิม (การตัดสินใจ (ก) #539: นับ 90 วันจาก LastModified เดิม)
//   expire-migrated  — ลบ object ใน manifest ที่ถึงวันหมดอายุเดิม (`--loop <นาที>` = ทำงานต่อเนื่อง)
//
// output เป็น JSON lines ที่มีแค่จำนวน/สถานะ/key — ไม่มี secret หรือเนื้อหาไฟล์

export const BUCKET = 'uat-evidence';
export const KEY_PREFIX = 'uat-evidence/';
export const MANIFEST_PREFIX = 'migration/';
export const RETENTION_DAYS = 90;
const DAY_MS = 86_400_000;

/** S3 lifecycle: object หมดอายุที่เที่ยงคืน UTC ถัดจาก (สร้าง + N วัน) */
export function expiresAt(lastModified, retentionDays = RETENTION_DAYS) {
  const due = new Date(lastModified).getTime() + retentionDays * DAY_MS;
  return new Date(Math.ceil(due / DAY_MS) * DAY_MS);
}

/**
 * ตัดสินจากรายการ object ต้นทางกับแถว uat_run_evidence ว่าต้องคัดลอกอะไร
 * - object ที่ถึงวันหมดอายุแล้ว (MinIO ควรลบไปแล้ว) = ข้าม ไม่เข้า manifest
 * - object ที่ไม่มีแถว (orphan) หรือแถวที่ยังไม่หมดอายุแต่ไม่มี object = ผิดปกติ → หยุด
 */
export function planMigration({ sourceObjects, rows, now }) {
  const rowByKey = new Map(rows.map((row) => [row.storageKey, row]));
  const sourceKeys = new Set();
  const copy = [];
  const skippedExpired = [];
  const problems = [];
  for (const object of sourceObjects) {
    if (!object.key.startsWith(KEY_PREFIX)) continue;
    sourceKeys.add(object.key);
    const expiry = expiresAt(object.lastModified);
    if (expiry <= now) {
      skippedExpired.push(object.key);
      continue;
    }
    const row = rowByKey.get(object.key);
    if (!row) {
      problems.push({ key: object.key, kind: 'ORPHAN_OBJECT' });
      continue;
    }
    copy.push({
      key: object.key,
      sha256: row.sha256,
      sourceLastModified: new Date(object.lastModified).toISOString(),
      expiresAt: expiry.toISOString(),
    });
  }
  for (const row of rows) {
    if (sourceKeys.has(row.storageKey)) continue;
    if (expiresAt(row.recordedAt) <= now) continue;
    problems.push({ key: row.storageKey, kind: 'MISSING_OBJECT' });
  }
  return { copy, skippedExpired, problems };
}

/** รายการใน manifest ที่ถึงวันหมดอายุแล้ว (ไม่ซ้ำ key) */
export function dueExpirations(manifests, now) {
  const due = new Map();
  for (const manifest of manifests) {
    for (const entry of manifest.entries ?? []) {
      if (!entry.key?.startsWith(KEY_PREFIX)) continue;
      if (new Date(entry.expiresAt) <= now) due.set(entry.key, entry);
    }
  }
  return [...due.values()];
}

export function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

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

async function listAll(s3, storage, prefix) {
  const objects = [];
  let token;
  do {
    const page = await storage.send(
      new s3.ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    for (const object of page.Contents ?? []) {
      objects.push({ key: object.Key, lastModified: object.LastModified });
    }
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  return objects;
}

async function readBytes(s3, storage, key) {
  const response = await storage.send(new s3.GetObjectCommand({ Bucket: BUCKET, Key: key }));
  return { bytes: await response.Body.transformToByteArray(), contentType: response.ContentType };
}

async function evidenceRows(environment) {
  const { PrismaClient } = await load('@d-contact/db');
  const database = new PrismaClient({ datasourceUrl: required(environment, 'DATABASE_URL') });
  try {
    // owner role ของ UAT (เหมือน migrate/provision) — อ่านทุก tenant เพื่อเทียบกับ object ทั้ง bucket
    const rows = await database.$queryRaw`
      SELECT storage_key AS "storageKey", sha256, recorded_at AS "recordedAt" FROM uat_run_evidence`;
    return rows.map((row) => ({ ...row, sha256: row.sha256.trim() }));
  } finally {
    await database.$disconnect();
  }
}

export async function migrate({
  environment = process.env,
  s3,
  rows,
  now = new Date(),
  cutover = now.toISOString().slice(0, 10),
} = {}) {
  s3 ??= await load('@aws-sdk/client-s3');
  const source = client(
    s3,
    required(environment, 'UAT_MIGRATION_SOURCE_ENDPOINT'),
    required(environment, 'UAT_MIGRATION_SOURCE_ACCESS_KEY'),
    required(environment, 'UAT_MIGRATION_SOURCE_SECRET_KEY'),
  );
  const target = rootClient(s3, environment);
  try {
    rows ??= await evidenceRows(environment);
    const sourceObjects = await listAll(s3, source, KEY_PREFIX);
    const plan = planMigration({ sourceObjects, rows, now });
    if (plan.problems.length > 0) {
      log({ step: 'migrate', status: 'FAIL', reason: 'PLAN', problems: plan.problems });
      throw new Error('migration plan has problems');
    }
    let copied = 0;
    let alreadyPresent = 0;
    for (const entry of plan.copy) {
      const { bytes, contentType } = await readBytes(s3, source, entry.key);
      if (sha256(bytes) !== entry.sha256) {
        log({ step: 'migrate', status: 'FAIL', reason: 'SOURCE_SHA256_MISMATCH', key: entry.key });
        throw new Error('source sha256 mismatch');
      }
      let present = false;
      try {
        present = sha256((await readBytes(s3, target, entry.key)).bytes) === entry.sha256;
      } catch (error) {
        if (error?.name !== 'NoSuchKey') throw error;
      }
      if (present) {
        alreadyPresent += 1;
        continue;
      }
      await target.send(
        new s3.PutObjectCommand({
          Bucket: BUCKET,
          Key: entry.key,
          Body: bytes,
          ContentType: contentType,
        }),
      );
      if (sha256((await readBytes(s3, target, entry.key)).bytes) !== entry.sha256) {
        log({ step: 'migrate', status: 'FAIL', reason: 'TARGET_SHA256_MISMATCH', key: entry.key });
        throw new Error('target sha256 mismatch');
      }
      copied += 1;
    }
    const manifestKey = `${MANIFEST_PREFIX}uat-evidence-${cutover}.json`;
    await target.send(
      new s3.PutObjectCommand({
        Bucket: BUCKET,
        Key: manifestKey,
        Body: JSON.stringify({
          version: 1,
          cutover,
          retentionDays: RETENTION_DAYS,
          entries: plan.copy,
        }),
        ContentType: 'application/json',
      }),
    );
    const summary = {
      step: 'migrate',
      status: 'PASS',
      manifest: manifestKey,
      sourceObjects: sourceObjects.length,
      rows: rows.length,
      copied,
      alreadyPresent,
      skippedExpired: plan.skippedExpired.length,
      manifestDigest: sha256(Buffer.from(JSON.stringify(plan.copy))),
    };
    log(summary);
    return summary;
  } finally {
    source.destroy();
    target.destroy();
  }
}

export async function expireMigrated({ environment = process.env, s3, now = new Date() } = {}) {
  s3 ??= await load('@aws-sdk/client-s3');
  const storage = rootClient(s3, environment);
  try {
    const manifests = [];
    for (const object of await listAll(s3, storage, MANIFEST_PREFIX)) {
      const { bytes } = await readBytes(s3, storage, object.key);
      manifests.push(JSON.parse(Buffer.from(bytes).toString('utf8')));
    }
    const due = dueExpirations(manifests, now);
    for (const entry of due) {
      await storage.send(new s3.DeleteObjectCommand({ Bucket: BUCKET, Key: entry.key }));
    }
    const remaining = manifests.flatMap((manifest) => manifest.entries ?? []).length - due.length;
    const summary = {
      step: 'expire-migrated',
      status: remaining > 0 ? 'PASS' : 'DONE',
      manifests: manifests.length,
      deleted: due.length,
      remaining,
    };
    log(summary);
    return summary;
  } finally {
    storage.destroy();
  }
}

async function main(argv) {
  const [command, ...rest] = argv;
  if (command === 'init') return init();
  if (command === 'migrate') return migrate();
  if (command === 'expire-migrated') {
    const loopIndex = rest.indexOf('--loop');
    if (loopIndex < 0) return expireMigrated();
    const minutes = Number(rest[loopIndex + 1]);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--loop <minutes> required');
    // TODO(#541): ถอด service นี้ออกหลัง cutover + 90 วัน (เมื่อ remaining = 0)
    for (;;) {
      try {
        await expireMigrated();
      } catch (error) {
        log({ step: 'expire-migrated', status: 'ERROR', reason: error?.name ?? 'Error' });
      }
      await new Promise((resolve) => setTimeout(resolve, minutes * 60_000));
    }
  }
  throw new Error(
    'usage: uat-object-storage.mjs init | migrate | expire-migrated [--loop <minutes>]',
  );
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
