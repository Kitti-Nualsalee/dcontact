/**
 * Owner: API bootstrap — object storage ของหลักฐาน UAT (U1.5 #433)
 *
 * Authority: Phase Contract #374 (ภาพหน้าจอเก็บใน MinIO ส่วนตัวภายใน UAT stack, retention 90 วัน),
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
  PutBucketLifecycleConfigurationCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
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
   * client จาก env ของ object storage ใน UAT stack (`MINIO_*`) + `UAT_EVIDENCE_BUCKET`
   * endpoint/credential ต้องระบุเสมอ ไม่มีค่า default (UAT ห้ามใช้ default credential — #374)
   */
  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): UatEvidenceObjectStorage {
    const required = (name: 'MINIO_ENDPOINT' | 'MINIO_ACCESS_KEY' | 'MINIO_SECRET_KEY') => {
      const value = environment[name]?.trim();
      if (!value) throw new Error(`${name} is required for UAT evidence storage`);
      return value;
    };
    const client = new S3Client({
      endpoint: required('MINIO_ENDPOINT'),
      forcePathStyle: true,
      region: environment.MINIO_REGION ?? 'us-east-1',
      credentials: {
        accessKeyId: required('MINIO_ACCESS_KEY'),
        secretAccessKey: required('MINIO_SECRET_KEY'),
      },
    });
    return new UatEvidenceObjectStorage(client, environment.UAT_EVIDENCE_BUCKET ?? 'uat-evidence');
  }

  /** เรียกตอนบูต: bucket + lifecycle 90 วัน (idempotent) และยืนยันว่าไม่มี bucket policy */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new CreateBucketCommand({ Bucket: this.bucket }));
    } catch (error) {
      if (errorName(error) !== 'BucketAlreadyOwnedByYou') throw error;
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
