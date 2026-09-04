import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { RecordingStorage } from './recording-api.js';

/** MinIO/S3 adapter: browser ได้เฉพาะ presigned URL อายุสั้น ไม่ได้ credential ของ storage. */
export class MinioRecordingStorage implements RecordingStorage {
  private readonly client: S3Client;

  constructor(
    private readonly bucket = process.env.RECORDINGS_BUCKET ?? 'recordings',
    endpoint = process.env.MINIO_ENDPOINT ?? 'http://localhost:9000',
    accessKeyId = process.env.MINIO_ACCESS_KEY ?? 'minioadmin',
    secretAccessKey = process.env.MINIO_SECRET_KEY ?? 'minioadmin',
  ) {
    this.client = new S3Client({
      endpoint,
      forcePathStyle: true,
      region: process.env.MINIO_REGION ?? 'us-east-1',
      credentials: { accessKeyId, secretAccessKey },
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
