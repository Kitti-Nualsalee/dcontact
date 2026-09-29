import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ADR-029: readiness ของ object storage ตรวจด้วย S3 API (`HeadBucket`) ไม่ใช้ endpoint เฉพาะของผู้ผลิต
// env ชุดเดียวกับแอป (`S3_*`, fallback `MINIO_*`); ค่า default ตรงกับ dev compose
export const DEV_BUCKETS = ['recordings', 'uat-evidence'];

export function objectStorageConfiguration(environment = process.env) {
  const value = (name, legacy, fallback) =>
    environment[name]?.trim() || environment[legacy]?.trim() || fallback;
  return {
    endpoint: value('S3_ENDPOINT', 'MINIO_ENDPOINT', 'http://localhost:9000'),
    region: value('S3_REGION', 'MINIO_REGION', 'us-east-1'),
    forcePathStyle: environment.S3_FORCE_PATH_STYLE?.trim().toLowerCase() !== 'false',
    credentials: {
      accessKeyId: value('S3_ACCESS_KEY', 'MINIO_ACCESS_KEY', 'dcontact'),
      secretAccessKey: value('S3_SECRET_KEY', 'MINIO_SECRET_KEY', 'dcontact-secret'),
    },
  };
}

/** โหลด client จาก workspace ของแอป เพราะ root ไม่มี `@aws-sdk/client-s3` เป็น dependency */
async function loadS3() {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  return import(pathToFileURL(require.resolve('@aws-sdk/client-s3')).href);
}

/** คืนรายชื่อ bucket ที่ใช้ไม่ได้ พร้อมเหตุผล; ว่าง = พร้อม */
export async function missingBuckets({
  environment = process.env,
  buckets = DEV_BUCKETS,
  s3 = undefined,
} = {}) {
  const { S3Client, HeadBucketCommand } = s3 ?? (await loadS3());
  const client = new S3Client(objectStorageConfiguration(environment));
  const missing = [];
  try {
    for (const bucket of buckets) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        const status = error?.$metadata?.httpStatusCode;
        missing.push(`${bucket} (${status ?? error?.name ?? 'unreachable'})`);
      }
    }
  } finally {
    client.destroy?.();
  }
  return missing;
}
