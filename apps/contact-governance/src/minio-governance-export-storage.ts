import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { Cg5ExportObjectStorage } from './cg5-export-worker.js';

/** Dedicated compliance-export bucket; tenant prefix is verified before every storage action. */
export class MinioGovernanceExportStorage implements Cg5ExportObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    bucket = process.env.GOVERNANCE_EXPORTS_BUCKET ?? 'governance-exports',
    endpoint = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId = process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey = process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  ) {
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint,
      forcePathStyle: true,
      region: process.env.MINIO_REGION ?? 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
    });
  }

  async put(key: string, body: Uint8Array): Promise<void> {
    this.assertKey(key);
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
      }),
    );
  }

  async delete(key: string): Promise<void> {
    this.assertKey(key);
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async presignDownload(
    tenantId: string,
    key: string,
    expiresInSeconds: number,
  ): Promise<{ url: string; expiresAt: Date }> {
    this.assertKey(key, tenantId);
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ResponseContentDisposition: 'attachment',
      }),
      { expiresIn: expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1_000) };
  }

  private assertKey(key: string, tenantId?: string) {
    const prefix = tenantId ? `governance-exports/${tenantId}/` : 'governance-exports/';
    if (!key.startsWith(prefix) || key.includes('..'))
      throw new Error('export storage key is outside the tenant prefix');
  }
}
