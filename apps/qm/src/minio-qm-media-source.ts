import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { QmRecordingMediaSource } from './qm-transcription-worker.js';

export interface MinioQmMediaSourceConfiguration {
  endpoint: string;
  bucket?: string;
  region?: string;
  accessKeyId: string;
  secretAccessKey: string;
}

export class MinioQmMediaSource implements QmRecordingMediaSource {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configuration: MinioQmMediaSourceConfiguration) {
    const endpoint = new URL(configuration.endpoint);
    if (endpoint.protocol !== 'https:') throw new Error('QM media endpoint must use HTTPS');
    this.bucket = configuration.bucket ?? 'recordings';
    this.client = new S3Client({
      endpoint: endpoint.toString(),
      forcePathStyle: true,
      region: configuration.region ?? 'us-east-1',
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    });
  }

  async createEncryptedReadUrl(input: {
    tenantId: string;
    storageKey: string;
    expiresInSeconds: number;
  }): Promise<{ url: string; expiresAt: Date }> {
    if (!input.storageKey.startsWith(`recordings/${input.tenantId}/`)) {
      throw new Error('recording storage key is outside the tenant prefix');
    }
    const url = await getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: input.storageKey }),
      { expiresIn: input.expiresInSeconds },
    );
    return { url, expiresAt: new Date(Date.now() + input.expiresInSeconds * 1_000) };
  }
}
