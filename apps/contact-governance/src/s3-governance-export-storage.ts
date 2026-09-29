import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readS3Bucket, readS3Configuration, type S3Configuration } from '@d-contact/shared';
import type { Cg5ExportObjectStorage } from './cg5-export-worker.js';

/** Dedicated compliance-export bucket; tenant prefix is verified before every storage action. */
export class S3GovernanceExportStorage implements Cg5ExportObjectStorage {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(
    bucket = readS3Bucket('GOVERNANCE_EXPORTS'),
    configuration: S3Configuration = readS3Configuration(),
  ) {
    this.bucket = bucket;
    this.client = new S3Client({
      endpoint: configuration.endpoint,
      forcePathStyle: configuration.forcePathStyle,
      region: configuration.region,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
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
