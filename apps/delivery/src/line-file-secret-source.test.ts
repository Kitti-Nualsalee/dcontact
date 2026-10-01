import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { FileLineSecretSource, FileLineSecretWriter } from './line-file-secret-source.js';
import { LineKeychainReadError } from './line-keychain-secret-source.js';
import { resolveLinePilotRuntime, LinePilotRuntimeError } from './line-pilot-runtime.js';
import { resolveLineWebhookSecrets } from './line-webhook-secrets.js';

const CHANNEL = '2007056595';
const SERVICE = `d-contact.line.${CHANNEL}`;
const RECIPIENT = 'kc-recipient-00000000-0000-4000-8000-000000000001';

async function fixture() {
  const secretDir = await mkdtemp(join(tmpdir(), 'line-secrets-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'line-state-'));
  const put = async (name: string, value: string, mode = 0o400) => {
    await writeFile(join(secretDir, name), value);
    await chmod(join(secretDir, name), mode);
  };
  return { secretDir, stateDir, put };
}

test('#565 file secret: อ่านไฟล์ตามชื่อคงที่และตัด newline ท้าย', async () => {
  const { secretDir, put } = await fixture();
  await put('line-channel-access-token', 'synthetic-token\n');
  const source = new FileLineSecretSource({ channelAccountId: CHANNEL, secretDir });
  assert.equal(
    await source.read({ keychainService: SERVICE, keychainAccount: 'channel-access-token' }),
    'synthetic-token',
  );
});

test('#565 file secret: สิทธิ์กว้าง, ไฟล์หาย, ค่าว่าง, symlink, account/service แปลก = fail closed', async () => {
  const { secretDir, put } = await fixture();
  const source = new FileLineSecretSource({ channelAccountId: CHANNEL, secretDir });
  const read = (account: string, service = SERVICE) =>
    source.read({ keychainService: service, keychainAccount: account });

  await put('line-channel-secret', 'synthetic-secret', 0o444);
  await assert.rejects(read('channel-secret'), LineKeychainReadError);
  await assert.rejects(read('channel-access-token'), LineKeychainReadError);
  await put('line-webhook-payload-key', '\n');
  await assert.rejects(read('webhook-payload-key'), LineKeychainReadError);
  await writeFile(join(secretDir, 'real'), 'synthetic');
  await chmod(join(secretDir, 'real'), 0o400);
  await symlink(join(secretDir, 'real'), join(secretDir, 'line-channel-access-token'));
  await assert.rejects(read('channel-access-token'), LineKeychainReadError);
  await assert.rejects(read('../etc/passwd'), LineKeychainReadError);
  await assert.rejects(read('channel-secret', 'd-contact.line.other'), LineKeychainReadError);
  // recipient ต้องมี state directory
  await assert.rejects(read(`recipient.${RECIPIENT}`), LineKeychainReadError);
});

test('#565 file secret: error ไม่มี path หรือค่า', async () => {
  const { secretDir } = await fixture();
  const source = new FileLineSecretSource({ channelAccountId: CHANNEL, secretDir });
  const error = await source
    .read({ keychainService: SERVICE, keychainAccount: 'channel-secret' })
    .catch((caught: unknown) => caught as Error);
  assert.ok(error instanceof LineKeychainReadError);
  assert.ok(!error.message.includes(secretDir));
});

test('#565 file secret: recipient เขียนเป็น 0600 ใน state directory แล้วอ่านกลับได้', async () => {
  const { secretDir, stateDir } = await fixture();
  const options = { channelAccountId: CHANNEL, secretDir, stateDir };
  const reference = { keychainService: SERVICE, keychainAccount: `recipient.${RECIPIENT}` };
  const userId = `U${'a'.repeat(32)}`;
  await new FileLineSecretWriter(options).write(reference, userId);
  const path = join(stateDir, 'recipients', RECIPIENT);
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(join(stateDir, 'recipients'))).mode & 0o777, 0o700);
  assert.equal(await readFile(path, 'utf8'), userId);
  assert.equal(await new FileLineSecretSource(options).read(reference), userId);
});

test('#565 file secret: writer เขียน secret ของ operator ไม่ได้', async () => {
  const { secretDir, stateDir } = await fixture();
  const writer = new FileLineSecretWriter({ channelAccountId: CHANNEL, secretDir, stateDir });
  await assert.rejects(
    writer.write({ keychainService: SERVICE, keychainAccount: 'channel-access-token' }, 'x'),
    LineKeychainReadError,
  );
  await assert.rejects(
    writer.write({ keychainService: SERVICE, keychainAccount: `recipient.${RECIPIENT}` }, 'a b'),
    LineKeychainReadError,
  );
});

test('#565 webhook secrets: โหมด file อ่าน channel secret + payload key จากไฟล์', async () => {
  const { secretDir, put } = await fixture();
  await put('line-channel-secret', 'synthetic-channel-secret');
  await put('line-webhook-payload-key', Buffer.alloc(32, 7).toString('base64'));
  const secrets = await resolveLineWebhookSecrets({
    mode: 'file',
    channelAccountId: CHANNEL,
    secretDir,
  });
  assert.equal(secrets.mode, 'file');
  assert.equal(secrets.channelSecret, 'synthetic-channel-secret');
  assert.deepEqual(secrets.payloadKey, Buffer.alloc(32, 7));
});

test('#565 pilot runtime: keychain บนเครื่องที่ไม่ใช่ macOS และโหมดแปลก = ปฏิเสธ', () => {
  assert.throws(
    () => resolveLinePilotRuntime({ environment: {}, platform: 'linux' }),
    (error: unknown) =>
      error instanceof LinePilotRuntimeError && error.code === 'PLATFORM_MISMATCH',
  );
  assert.throws(
    () =>
      resolveLinePilotRuntime({ environment: { LINE_SECRET_SOURCE: 'env' }, platform: 'darwin' }),
    (error: unknown) =>
      error instanceof LinePilotRuntimeError && error.code === 'SECRET_SOURCE_UNKNOWN',
  );
});

test('#565 pilot runtime: โหมด file ต้องมี state dir และ release SHA ของ image', () => {
  assert.throws(
    () =>
      resolveLinePilotRuntime({ environment: { LINE_SECRET_SOURCE: 'file' }, platform: 'linux' }),
    (error: unknown) => error instanceof LinePilotRuntimeError && error.code === 'PATH_REQUIRED',
  );
  const base = {
    LINE_SECRET_SOURCE: 'file',
    LINE_PILOT_STATE_DIR: '/var/lib/line-pilot',
    LINE_PILOT_MIGRATIONS_DIR: '/ops/prisma/migrations',
    LINE_PILOT_REGISTRY_PATH: '/ops/scripts/cxa-s2-readiness.mjs',
  };
  const runtime = resolveLinePilotRuntime({ environment: base, platform: 'linux' });
  assert.equal(runtime.kind, 'file');
  assert.equal(runtime.bundleDir, '/var/lib/line-pilot/provider');
  assert.throws(
    () => runtime.provenance(),
    (error: unknown) =>
      error instanceof LinePilotRuntimeError && error.code === 'RELEASE_SHA_INVALID',
  );

  const sha = 'a'.repeat(40);
  const release = resolveLinePilotRuntime({
    environment: { ...base, DCONTACT_BUILD_SHA: sha },
    platform: 'linux',
  }).provenance();
  assert.equal(release.commitSha, sha);
  release.assertFinalMain(sha);
  assert.throws(
    () => release.assertFinalMain('b'.repeat(40)),
    (error: unknown) => error instanceof LinePilotRuntimeError && error.code === 'NOT_FINAL_MAIN',
  );
});
