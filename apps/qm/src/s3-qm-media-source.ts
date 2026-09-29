import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import type { S3Configuration } from '@d-contact/shared';
import type { QmRecordingMediaSource } from './qm-transcription-worker.js';

export interface S3QmMediaSourceConfiguration {
  s3: S3Configuration;
  bucket?: string;
}

export class S3QmMediaSource implements QmRecordingMediaSource {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(configuration: S3QmMediaSourceConfiguration) {
    const endpoint = new URL(configuration.s3.endpoint);
    if (endpoint.protocol !== 'https:') throw new Error('QM media endpoint must use HTTPS');
    this.bucket = configuration.bucket ?? 'recordings';
    this.client = new S3Client({
      endpoint: endpoint.toString(),
      forcePathStyle: configuration.s3.forcePathStyle,
      region: configuration.s3.region,
      credentials: {
        accessKeyId: configuration.s3.accessKeyId,
        secretAccessKey: configuration.s3.secretAccessKey,
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
