/**
 * Owner: API bootstrap — object storage ของหลักฐาน UAT (U1.5 #433)
 *
 * Authority: Phase Contract #374 (ภาพหน้าจอเก็บใน object storage ส่วนตัวภายใน UAT stack, retention 90 วัน),
 * evidence/defect #379
 *
 * - bucket ส่วนตัว: adapter นี้ไม่ตั้ง bucket policy/ACL และไม่มีทางสร้าง presigned/public URL
 *   (ไม่ import `s3-request-presigner`) — byte เข้าออกผ่าน API ที่ตรวจสิทธิ์เท่านั้น
 * - ตอนบูตสร้าง bucket แบบ idempotent แล้วตั้ง lifecycle ให้ object ใต้ `uat-evidence/` หมดอายุใน 90 วัน
 *   และปฏิเสธการบูตถ้า bucket มี policy อยู่ (อาจเปิด public ไว้นอกระบบ) — fail closed
 * - เป็น module เดียวที่ composition root ของ UAT ใช้แตะ object storage
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

/** ส่วนของ S3 client ที่ adapter ใช้ — เทสต์ส่ง client ปลอมมาตรวจ command ได้ */
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
   * client จาก env ของ object storage (`S3_*`, ADR-029) + `S3_BUCKET_UAT_EVIDENCE`
   * endpoint/credential ต้องระบุเสมอ ไม่มีค่า default (UAT ห้ามใช้ default credential — #374)
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
   * เรียกตอนบูต: bucket + lifecycle 90 วัน (idempotent) และยืนยันว่าไม่มี bucket policy
   * ตรวจด้วย HeadBucket ก่อน (#540): bucket ที่ bootstrap สร้างด้วย root แล้วให้สิทธิ์ API ใช้ได้เลย —
   * storage ที่มีเจ้าของ bucket (SeaweedFS) ตอบ CreateBucket ซ้ำว่า BucketAlreadyExists
   * ส่วน CreateBucket ที่แข่งกับเจ้าของอื่นหลัง Head 404 ยังต้องล้ม
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
