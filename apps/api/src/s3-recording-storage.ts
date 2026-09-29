import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readS3Bucket, readS3Configuration, type S3Configuration } from '@d-contact/shared';
import type { RecordingStorage } from './recording-api.js';

/** S3 adapter (ADR-029): browser ได้เฉพาะ presigned URL อายุสั้น ไม่ได้ credential ของ storage. */
export class S3RecordingStorage implements RecordingStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket = readS3Bucket('RECORDINGS'),
    configuration: S3Configuration = readS3Configuration(),
  ) {
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

  async presignPlayback(input: {
    tenantId: string;
    storageKey: string;
    expiresInSeconds: number;
    download: boolean;
  }): Promise<{ url: string; expiresAt: Date }> {
    if (!input.storageKey.startsWith(`recordings/${input.tenantId}/`)) {
      throw new Error('recording storage key is outside the tenant prefix');
    }
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.storageKey,
        ...(input.download ? { ResponseContentDisposition: 'attachment' } : {}),
      }),
      { expiresIn: input.expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000) };
  }

  async deleteObject(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }
}
