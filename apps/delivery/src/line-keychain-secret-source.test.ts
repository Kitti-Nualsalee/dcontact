import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KeychainLineSecretSource,
  LineKeychainReadError,
  MACOS_SECURITY_BINARY,
  type LineKeychainExec,
} from './line-keychain-secret-source.js';

const REFERENCE = {
  keychainService: 'd-contact.line.2007056595',
  keychainAccount: 'channel-access-token',
};

function recording(stdout = 'synthetic-secret-value\n') {
  const calls: Array<{ file: string; arguments_: readonly string[] }> = [];
  const exec: LineKeychainExec = async (file, arguments_) => {
    calls.push({ file, arguments_ });
    return { stdout };
  };
  return { calls, exec };
}

test('S2-LINE Keychain: เรียก security โดยตรงไม่ผ่าน shell และตัดแค่ newline ท้าย', async () => {
  const { calls, exec } = recording();
  const secret = await new KeychainLineSecretSource(exec, 'darwin').read(REFERENCE);
  assert.equal(secret, 'synthetic-secret-value');
  assert.deepEqual(calls, [
    {
      file: MACOS_SECURITY_BINARY,
      arguments_: [
        'find-generic-password',
        '-s',
        REFERENCE.keychainService,
        '-a',
        REFERENCE.keychainAccount,
        '-w',
      ],
    },
  ]);
});

test('S2-LINE Keychain: นอก macOS หรือ reference แปลกปลอมถูกปฏิเสธก่อนเรียก process', async () => {
  const { calls, exec } = recording();
  await assert.rejects(
    new KeychainLineSecretSource(exec, 'linux').read(REFERENCE),
    LineKeychainReadError,
  );
  await assert.rejects(
    new KeychainLineSecretSource(exec, 'darwin').read({ ...REFERENCE, keychainAccount: '-w; rm' }),
    LineKeychainReadError,
  );
  assert.equal(calls.length, 0);
});

test('S2-LINE Keychain: error หรือค่าว่างจาก Keychain กลายเป็น code เดียวโดยไม่พาข้อความเดิม', async () => {
  const failing: LineKeychainExec = async () => {
    throw new Error('item d-contact.line secret=leaked');
  };
  await assert.rejects(
    new KeychainLineSecretSource(failing, 'darwin').read(REFERENCE),
    (error: Error) => error instanceof LineKeychainReadError && !error.message.includes('leaked'),
  );
  await assert.rejects(
    new KeychainLineSecretSource(recording('\n').exec, 'darwin').read(REFERENCE),
    LineKeychainReadError,
  );
});
