import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// ADR-029: object storage readiness is checked with the S3 API (`HeadBucket`), not a vendor-specific endpoint
// the same env as the app (`S3_*`, fallback `MINIO_*`); defaults match the dev compose
export const DEV_BUCKETS = ['recordings', 'governance-exports', 'uat-evidence'];

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

/** Load the client from the app workspace because the root does not have `@aws-sdk/client-s3` as a dependency */
export async function loadS3() {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  return import(pathToFileURL(require.resolve('@aws-sdk/client-s3')).href);
}

/** the presigner is in the app workspace too (used in the contract test) */
export async function loadPresigner() {
  const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
  return import(pathToFileURL(require.resolve('@aws-sdk/s3-request-presigner')).href);
}

/** Return the list of buckets that are unusable with the reason; empty = ready */
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
