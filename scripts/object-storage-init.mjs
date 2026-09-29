import { fileURLToPath } from 'node:url';
import { DEV_BUCKETS, loadS3, objectStorageConfiguration } from './object-storage-readiness.mjs';

// ADR-029 (#533): bootstrap bucket ของ dev/CI ผ่าน S3 API เท่านั้น (ไม่ใช้ CLI ของผู้ผลิต)
// idempotent: ตรวจด้วย HeadBucket ก่อนสร้าง — RustFS ตอบ CreateBucket ซ้ำว่าสำเร็จ ไม่ใช่ BucketAlreadyOwnedByYou
// bucket ต้องเป็น private (ไม่มี bucket policy)

export async function initializeBuckets({
  environment = process.env,
  buckets = DEV_BUCKETS,
  s3 = undefined,
  attempts = 30,
  delayMs = 1_000,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  const {
    S3Client,
    CreateBucketCommand,
    GetBucketPolicyCommand,
    HeadBucketCommand,
    ListBucketsCommand,
  } = s3 ?? (await loadS3());
  const client = new S3Client(objectStorageConfiguration(environment));
  try {
    // รอ storage ตอบก่อน (container healthy แล้วแต่ S3 API อาจยังไม่พร้อมรับ auth)
    for (let attempt = 1; ; attempt += 1) {
      try {
        await client.send(new ListBucketsCommand({}));
        break;
      } catch (error) {
        if (attempt >= attempts) throw error;
        await sleep(delayMs);
      }
    }
    const created = [];
    for (const bucket of buckets) {
      try {
        await client.send(new HeadBucketCommand({ Bucket: bucket }));
      } catch (error) {
        if (error?.$metadata?.httpStatusCode !== 404) throw error;
        await client.send(new CreateBucketCommand({ Bucket: bucket }));
        created.push(bucket);
      }
      try {
        await client.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        throw new Error(`bucket ${bucket} มี bucket policy — dev bucket ต้องเป็น private`);
      } catch (error) {
        if (error?.name !== 'NoSuchBucketPolicy') throw error;
      }
    }
    return created;
  } finally {
    client.destroy?.();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const created = await initializeBuckets();
    console.log(
      `✓ object storage buckets พร้อม: ${DEV_BUCKETS.join(', ')}` +
        (created.length ? ` (สร้างใหม่: ${created.join(', ')})` : ''),
    );
  } catch (error) {
    console.error(`✗ object storage init: ${error?.name ?? 'Error'}: ${error?.message ?? error}`);
    process.exitCode = 1;
  }
}
