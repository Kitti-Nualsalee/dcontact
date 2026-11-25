import { DeleteObjectCommand, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readS3Bucket, readS3Configuration, type S3Configuration } from '@d-contact/shared';
import type { RecordingStorage } from './recording-api.js';
import type { RecordingPlaybackStorage } from './recording-playback-api.js';

/** the S3 adapter (ADR-029): the browser gets only a short-lived presigned URL, never the storage credential. */
export class S3RecordingStorage implements RecordingStorage, RecordingPlaybackStorage {
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

  /** #967: reads only a range the API computes from frames; the user does not set the byte or key themselves */
  async readRange(input: {
    tenantId: string;
    storageKey: string;
    start: number;
    endInclusive: number;
  }): Promise<{ bytes: Buffer; objectBytes: number }> {
    if (!input.storageKey.startsWith(`recordings/${input.tenantId}/`)) {
      throw new Error('recording storage key is outside the tenant prefix');
    }
    const response = await this.client.send(
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: input.storageKey,
        Range: `bytes=${input.start}-${input.endInclusive}`,
      }),
    );
    if (!response.Body) throw new Error('recording object has no body');
    // a storage that does not support Range answers the whole file: reject before loading into memory, never forward to the listener
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.ContentRange ?? '');
    const wanted = input.endInclusive - input.start + 1;
    if (
      !range ||
      Number(range[1]) !== input.start ||
      Number(range[2]) > input.endInclusive ||
      (response.ContentLength ?? 0) > wanted
    ) {
      void response.Body.transformToWebStream()
        .cancel()
        .catch(() => undefined);
      throw new Error('recording storage ignored the requested byte range');
    }
    const bytes = Buffer.from(await response.Body.transformToByteArray());
    if (bytes.length > wanted) throw new Error('recording storage returned more than requested');
    return { bytes, objectBytes: Number(range[3]) };
  }

  async deleteObject(storageKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: storageKey }));
  }
}
