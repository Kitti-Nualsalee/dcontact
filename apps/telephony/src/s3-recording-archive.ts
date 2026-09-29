import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname, relative, resolve, sep } from 'node:path';
import type { S3Configuration } from '@d-contact/shared';
import type { RecordingArchive } from './recording-lifecycle.js';

export interface S3RecordingArchiveConfiguration {
  bucket: string;
  s3: S3Configuration;
  telephonyDirectory: string;
  hostDirectory: string;
}

export interface RecordingObjectWriter {
  send(command: PutObjectCommand): Promise<unknown>;
}

/** ย้าย recording จาก shared FreeSWITCH volume เข้า tenant prefix ของ object storage (S3). */
export class S3RecordingArchive implements RecordingArchive {
  private readonly writer: RecordingObjectWriter;

  constructor(
    private readonly configuration: S3RecordingArchiveConfiguration,
    writer?: RecordingObjectWriter,
  ) {
    this.writer =
      writer ??
      new S3Client({
        endpoint: configuration.s3.endpoint,
        forcePathStyle: configuration.s3.forcePathStyle,
        region: configuration.s3.region,
        credentials: {
          accessKeyId: configuration.s3.accessKeyId,
          secretAccessKey: configuration.s3.secretAccessKey,
        },
      });
  }

  async prepare(input: { tenantId: string; telephonyPath: string }): Promise<void> {
    const directory = dirname(this.hostPath(input));
    await mkdir(directory, { recursive: true });
    // FreeSWITCH runs as a different UID inside the dev Compose container.
    await chmod(directory, 0o777);
  }

  async archive(input: {
    tenantId: string;
    storageKey: string;
    telephonyPath: string;
  }): Promise<void> {
    if (!input.storageKey.startsWith(`recordings/${input.tenantId}/`)) {
      throw new Error('recording storage key is outside the tenant prefix');
    }
    const body = await readFile(this.hostPath(input));
    await this.writer.send(
      new PutObjectCommand({
        Bucket: this.configuration.bucket,
        Key: input.storageKey,
        Body: body,
        ContentType: 'audio/wav',
      }),
    );
  }

  private hostPath(input: { tenantId: string; telephonyPath: string }): string {
    const telephonyRoot = resolve(this.configuration.telephonyDirectory);
    const relativePath = relative(telephonyRoot, resolve(input.telephonyPath));
    if (
      relativePath.startsWith(`..${sep}`) ||
      relativePath === '..' ||
      relativePath.split(sep)[0] !== input.tenantId
    ) {
      throw new Error('recording path is outside the tenant directory');
    }
    const tenantRoot = resolve(this.configuration.hostDirectory, input.tenantId);
    const hostPath = resolve(this.configuration.hostDirectory, relativePath);
    if (hostPath !== tenantRoot && !hostPath.startsWith(`${tenantRoot}${sep}`)) {
      throw new Error('recording path is outside the tenant directory');
    }
    return hostPath;
  }
}
