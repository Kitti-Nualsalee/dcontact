import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { MinioRecordingArchive } from './minio-recording-archive.js';

test('recording archive maps the FreeSWITCH path to a tenant-safe shared volume and uploads WAV', async (t) => {
  const hostDirectory = await mkdtemp(join(tmpdir(), 'dcontact-recording-'));
  t.after(() => rm(hostDirectory, { recursive: true, force: true }));
  const writes: unknown[] = [];
  const archive = new MinioRecordingArchive(
    {
      bucket: 'recordings',
      endpoint: 'http://localhost:9000',
      accessKeyId: 'test',
      secretAccessKey: 'test',
      telephonyDirectory: '/var/lib/freeswitch/recordings',
      hostDirectory,
    },
    { send: async (command: unknown) => void writes.push(command) },
  );
  const tenantId = '11111111-1111-4111-8111-111111111111';
  const telephonyPath = `/var/lib/freeswitch/recordings/${tenantId}/call.wav`;

  await archive.prepare({ tenantId, telephonyPath });
  const recordingDirectory = await stat(join(hostDirectory, tenantId));
  assert.equal(
    recordingDirectory.mode & 0o777,
    0o777,
    'FreeSWITCH container ต้องเขียน tenant recording directory ได้',
  );
  await writeFile(join(hostDirectory, tenantId, 'call.wav'), Buffer.from('RIFF-test-wave'));
  await archive.archive({
    tenantId,
    telephonyPath,
    storageKey: `recordings/${tenantId}/call.wav`,
  });

  assert.equal(writes.length, 1);
  const input = (writes[0] as { input: { Bucket: string; Key: string; Body: Buffer } }).input;
  assert.equal(input.Bucket, 'recordings');
  assert.equal(input.Key, `recordings/${tenantId}/call.wav`);
  assert.equal(input.Body.toString(), 'RIFF-test-wave');
  await assert.rejects(
    () =>
      archive.archive({
        tenantId,
        telephonyPath,
        storageKey: 'recordings/22222222-2222-4222-8222-222222222222/call.wav',
      }),
    /outside the tenant prefix/,
  );
});
