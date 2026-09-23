import assert from 'node:assert/strict';
import test from 'node:test';
import type { LineKeychainReference } from './line-credential-boundary.js';
import { LineWebhookSecretError, resolveLineWebhookSecrets } from './line-webhook-secrets.js';

const CHANNEL = '2007056595';

function source(values: Record<string, string>) {
  const reads: LineKeychainReference[] = [];
  return {
    reads,
    read: async (reference: LineKeychainReference) => {
      reads.push(reference);
      const value = values[reference.keychainAccount];
      if (!value) throw new Error('missing');
      return value;
    },
  };
}

test('S2-LINE webhook secrets: ค่าเริ่มต้น disabled สุ่มในหน่วยความจำทุกครั้งและไม่แตะ Keychain', async () => {
  const keychain = source({});
  const first = await resolveLineWebhookSecrets({
    mode: undefined,
    channelAccountId: CHANNEL,
    source: keychain,
  });
  const second = await resolveLineWebhookSecrets({
    mode: 'disabled',
    channelAccountId: CHANNEL,
    source: keychain,
  });
  assert.equal(first.mode, 'disabled');
  assert.equal(first.payloadKey.byteLength, 32);
  assert.notEqual(first.channelSecret, second.channelSecret);
  assert.equal(keychain.reads.length, 0);
});

test('S2-LINE webhook secrets: keychain อ่าน secret/payload key จาก service ของ channel', async () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const keychain = source({
    'channel-secret': 'synthetic-channel-secret',
    'webhook-payload-key': key,
  });
  const secrets = await resolveLineWebhookSecrets({
    mode: 'keychain',
    channelAccountId: CHANNEL,
    source: keychain,
  });
  assert.equal(secrets.channelSecret, 'synthetic-channel-secret');
  assert.deepEqual(secrets.payloadKey, Buffer.alloc(32, 7));
  assert.deepEqual(
    keychain.reads.map((reference) => reference.keychainService),
    [`d-contact.line.${CHANNEL}`, `d-contact.line.${CHANNEL}`],
  );
});

test('S2-LINE webhook secrets: โหมดแปลก, Keychain ไม่มีค่า หรือ key ผิดขนาด = fail closed', async () => {
  const code = async (mode: string, values: Record<string, string>) => {
    try {
      await resolveLineWebhookSecrets({ mode, channelAccountId: CHANNEL, source: source(values) });
      return 'OK';
    } catch (error) {
      assert.ok(error instanceof LineWebhookSecretError);
      return error.message;
    }
  };
  assert.match(await code('env', {}), /MODE_UNKNOWN/);
  assert.match(await code('keychain', {}), /KEYCHAIN_UNAVAILABLE/);
  assert.match(
    await code('keychain', {
      'channel-secret': 's',
      'webhook-payload-key': Buffer.alloc(16).toString('base64'),
    }),
    /PAYLOAD_KEY_INVALID/,
  );
});
