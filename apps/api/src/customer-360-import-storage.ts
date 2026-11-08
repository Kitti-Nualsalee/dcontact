import { createHash } from 'node:crypto';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { readS3Configuration } from '@d-contact/shared';

/** Object key เป็น UUID ที่ server สร้างเท่านั้น ไม่รับ filename หรือ raw values จาก client */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const C360_IMPORT_STORAGE_MAX_BYTES = 5 * 1024 * 1024;

export class C360ImportStorageError extends Error {
  readonly code = 'STORAGE_UNAVAILABLE';
  constructor() {
    super('STORAGE_UNAVAILABLE');
    this.name = 'C360ImportStorageError';
  }
}

export interface C360ImportObjectClient {
  send(command: object): Promise<unknown>;
}

export interface C360ImportObjectIdentity {
  tenantId: string;
  jobId: string;
  objectId: string;
}

/** Private bucket ต้อง provision โดย environment พร้อม least-privilege ตาม ADR-029 */
export class C360ImportObjectStorage {
  constructor(
    private readonly client: C360ImportObjectClient,
    private readonly bucket: string,
  ) {
    if (!bucket || bucket.trim() !== bucket) throw new C360ImportStorageError();
  }

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env): C360ImportObjectStorage {
    const bucket = environment.S3_BUCKET_C360_IMPORTS;
    if (!bucket) throw new C360ImportStorageError();
    try {
      const config = readS3Configuration({ environment, requireExplicit: true });
      return new C360ImportObjectStorage(
        new S3Client({
          endpoint: config.endpoint,
          region: config.region,
          forcePathStyle: config.forcePathStyle,
          credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
        }),
        bucket,
      );
    } catch {
      throw new C360ImportStorageError();
    }
  }

  private key(identity: C360ImportObjectIdentity): string {
    if (![identity.tenantId, identity.jobId, identity.objectId].every((id) => UUID.test(id)))
      throw new C360ImportStorageError();
    return `c360-imports/${identity.tenantId}/${identity.jobId}/${identity.objectId}`;
  }

  async put(identity: C360ImportObjectIdentity, bytes: Uint8Array): Promise<string> {
    if (bytes.byteLength > C360_IMPORT_STORAGE_MAX_BYTES) throw new C360ImportStorageError();
    const key = this.key(identity);
    const digest = createHash('sha256').update(bytes).digest('hex');
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: bytes,
          ContentType: 'application/octet-stream',
          ContentLength: bytes.byteLength,
          CacheControl: 'private, no-store',
          Metadata: { sha256: digest },
        }),
      );
      return digest;
    } catch {
      throw new C360ImportStorageError();
    }
  }

  /** อ่านแบบจำกัด bytes และตรวจ digest จาก durable job ก่อนคืนข้อมูลส่วนตัว */
  async get(
    identity: C360ImportObjectIdentity,
    expectedDigest: string,
  ): Promise<Uint8Array | null> {
    const key = this.key(identity);
    if (!/^[a-f0-9]{64}$/.test(expectedDigest)) throw new C360ImportStorageError();
    try {
      const result = (await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      )) as {
        Body?: AsyncIterable<Uint8Array>;
        ContentLength?: number;
      };
      if (
        !result.Body ||
        (result.ContentLength !== undefined && result.ContentLength > C360_IMPORT_STORAGE_MAX_BYTES)
      )
        throw new C360ImportStorageError();
      const chunks: Buffer[] = [];
      let length = 0;
      for await (const chunk of result.Body) {
        length += chunk.byteLength;
        if (length > C360_IMPORT_STORAGE_MAX_BYTES) throw new C360ImportStorageError();
        chunks.push(Buffer.from(chunk));
      }
      const bytes = Buffer.concat(chunks, length);
      if (createHash('sha256').update(bytes).digest('hex') !== expectedDigest)
        throw new C360ImportStorageError();
      return bytes;
    } catch (error) {
      const source = error as { name?: unknown; $metadata?: { httpStatusCode?: number } };
      if (
        source?.name === 'NoSuchKey' ||
        (source?.name === 'NotFound' && source.$metadata?.httpStatusCode === 404)
      )
        return null;
      throw new C360ImportStorageError();
    }
  }

  async delete(identity: C360ImportObjectIdentity): Promise<void> {
    const key = this.key(identity);
    try {
      await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
    } catch {
      throw new C360ImportStorageError();
    }
  }
}
