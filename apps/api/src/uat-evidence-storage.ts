/**
 * Owner: API bootstrap — object storage for UAT evidence (U1.5 #433)
 *
 * Authority: Phase Contract #374 (screenshots are kept in a private object storage inside the UAT stack, 90-day retention),
 * evidence/defect #379
 *
 * - a private bucket: this adapter sets no bucket policy/ACL and has no way to create a presigned/public URL
 *   (it does not import `s3-request-presigner`) — bytes go in and out only through an API that checks permission
 * - at boot it creates the bucket idempotently, then sets a lifecycle so objects under `uat-evidence/` expire in 90 days
 *   and refuses to boot if the bucket has a policy (it may have been made public outside the system) — fail closed
 * - the only module the UAT composition root uses to touch object storage
 */
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  GetBucketPolicyCommand,
  GetObjectCommand,
  HeadBucketCommand,
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { readS3Bucket, readS3Configuration } from '@d-contact/shared';
import {
  UAT_EVIDENCE_KEY_PREFIX,
  type UatEvidenceContentType,
  type UatEvidenceStorage,
} from '@d-contact/journey';

export const UAT_EVIDENCE_RETENTION_DAYS = 90;
export const UAT_EVIDENCE_LIFECYCLE_RULE_ID = 'uat-evidence-retention-90d';

/** the part of the S3 client the adapter uses — tests pass a fake client to inspect the commands */
export interface UatEvidenceS3Client {
  send(command: object): Promise<unknown>;
}

function httpStatus(error: unknown): number | undefined {
  return (error as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode;
}

function errorName(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const { name, Code } = error as { name?: unknown; Code?: unknown };
  return typeof name === 'string' ? name : typeof Code === 'string' ? Code : undefined;
}

export class UatEvidenceObjectStorage implements UatEvidenceStorage {
  constructor(
    private readonly client: UatEvidenceS3Client,
    readonly bucket: string,
  ) {}

  /**
   * a client from the object storage env (`S3_*`, ADR-029) + `S3_BUCKET_UAT_EVIDENCE`
   * the endpoint/credential must always be given, with no default (UAT must not use a default credential — #374)
   */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): UatEvidenceObjectStorage {
    const configuration = readS3Configuration({
      environment,
      requireExplicit: true,
      purpose: 'for UAT evidence storage',
    });
    const client = new S3Client({
      endpoint: configuration.endpoint,
      forcePathStyle: configuration.forcePathStyle,
      region: configuration.region,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    });
    return new UatEvidenceObjectStorage(client, readS3Bucket('UAT_EVIDENCE', environment));
  }

  /**
   * called at boot: bucket + 90-day lifecycle (idempotent) and confirms there is no bucket policy
   * checks with HeadBucket first (#540): a bucket that bootstrap created with root and granted the API access to is usable as is —
   * a storage with a bucket owner (SeaweedFS) answers a repeated CreateBucket with BucketAlreadyExists
   * while a CreateBucket that races another owner after a Head 404 must still fail
   */
  async ensureBucket(): Promise<void> {
    let exists = true;
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      const name = errorName(error);
      if (httpStatus(error) !== 404 && name !== 'NotFound' && name !== 'NoSuchBucket') throw error;
      exists = false;
    }
    if (!exists) {
      try {
        await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
      } catch (error) {
        if (errorName(error) !== 'BucketAlreadyOwnedByYou') throw error;
      }
    }
    await this.client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: this.bucket,
        LifecycleConfiguration: {
          Rules: [
            {
              ID: UAT_EVIDENCE_LIFECYCLE_RULE_ID,
              Status: 'Enabled',
              Filter: { Prefix: UAT_EVIDENCE_KEY_PREFIX },
              Expiration: { Days: UAT_EVIDENCE_RETENTION_DAYS },
            },
          ],
        },
      }),
    );
    let policy: unknown;
    try {
      policy = (
        (await this.client.send(new GetBucketPolicyCommand({ Bucket: this.bucket }))) as {
          Policy?: unknown;
        }
      ).Policy;
    } catch (error) {
      if (errorName(error) !== 'NoSuchBucketPolicy') throw error;
    }
    if (policy) throw new Error(`UAT evidence bucket ${this.bucket} must not have a bucket policy`);
  }

  async putObject(input: {
    key: string;
    bytes: Uint8Array;
    contentType: UatEvidenceContentType;
    sha256: string;
  }): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: this.checked(input.key),
        Body: input.bytes,
        ContentType: input.contentType,
        ContentLength: input.bytes.byteLength,
        CacheControl: 'private, no-store',
        Metadata: { sha256: input.sha256 },
      }),
    );
  }

  async getObject(key: string): Promise<Uint8Array | null> {
    try {
      const output = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: this.checked(key) }),
      )) as { Body?: { transformToByteArray(): Promise<Uint8Array> } };
      return output.Body ? await output.Body.transformToByteArray() : null;
    } catch (error) {
      if (errorName(error) === 'NoSuchKey') return null;
      throw error;
    }
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(
      new DeleteObjectCommand({ Bucket: this.bucket, Key: this.checked(key) }),
    );
  }

  private checked(key: string): string {
    if (!key.startsWith(UAT_EVIDENCE_KEY_PREFIX)) {
      throw new Error('UAT evidence storage key is outside the uat-evidence prefix');
    }
    return key;
  }
}
