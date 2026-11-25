import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KeychainLineSecretSource,
  KeychainLineSecretWriter,
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

test('S2-LINE Keychain: calls security directly not through a shell and trims only the trailing newline', async () => {
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

test('S2-LINE Keychain: non-macOS or a bogus reference is rejected before calling the process', async () => {
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

test('S2-LINE Keychain: an error or empty value from the Keychain becomes a single code without carrying the original message', async () => {
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

test('S2-LINE Keychain writer: the value goes through the stdin of `security -i` and is not in argv', async () => {
  const calls: Array<{ file: string; arguments_: readonly string[]; stdin: string }> = [];
  const writer = new KeychainLineSecretWriter(async (file, arguments_, stdin) => {
    calls.push({ file, arguments_, stdin });
  }, 'darwin');
  await writer.write(REFERENCE, 'U0123456789abcdef0123456789abcdef');
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.file, MACOS_SECURITY_BINARY);
  assert.deepEqual(calls[0]!.arguments_, ['-i']);
  assert.equal(
    calls[0]!.stdin,
    `add-generic-password -U -s ${REFERENCE.keychainService} -a ${REFERENCE.keychainAccount} -w U0123456789abcdef0123456789abcdef\n`,
  );
});

test('S2-LINE Keychain writer: a value that could inject a command, non-macOS or a process error is rejected without carrying the value', async () => {
  const calls: string[] = [];
  const recordingWriter = (platform: NodeJS.Platform) =>
    new KeychainLineSecretWriter(async (_file, _arguments, stdin) => {
      calls.push(stdin);
    }, platform);
  await assert.rejects(
    recordingWriter('darwin').write(REFERENCE, 'value\ndelete-keychain'),
    LineKeychainReadError,
  );
  await assert.rejects(
    recordingWriter('darwin').write(REFERENCE, 'a "quoted" value'),
    LineKeychainReadError,
  );
  await assert.rejects(recordingWriter('linux').write(REFERENCE, 'value'), LineKeychainReadError);
  assert.equal(calls.length, 0);
  const failing = new KeychainLineSecretWriter(async () => {
    throw new Error('security: secret-value leaked');
  }, 'darwin');
  await assert.rejects(
    failing.write(REFERENCE, 'secret-value'),
    (error: Error) =>
      error instanceof LineKeychainReadError && !error.message.includes('secret-value'),
  );
});
