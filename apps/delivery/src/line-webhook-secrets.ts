/**
 * Owner: Delivery/Channels — source of the webhook binding secrets (S2.6b #403, #362 §9)
 *
 * the channel secret and payload key must not be in env/Git/log — the composition root accepts only a "mode" from env:
 * - `keychain`: read from the macOS Keychain (service `d-contact.line.<channel>`, account `channel-secret`
 *   and `webhook-payload-key` as base64 32 bytes), used on the pilot's protected runner machine
 * - `file`: read from the Compose `secrets` files on Linux (#565 S4) — `line-channel-secret` and
 *   `line-webhook-payload-key` in `LINE_CREDENTIAL_DIR` (default `/run/secrets`)
 * - `disabled` (default): randomize the secret/key in memory — a real signature from LINE always fails verification,
 *   so the route answers 401 to every request (fail closed) but the API can still boot on CI/Linux
 */
import { randomBytes } from 'node:crypto';
import type { LineSecretSource } from './line-credential-boundary.js';
import { FileLineSecretSource } from './line-file-secret-source.js';
import {
  KeychainLineSecretSource,
  lineKeychainServiceName,
} from './line-keychain-secret-source.js';

export const LINE_WEBHOOK_SECRET_MODES = ['keychain', 'file', 'disabled'] as const;
export type LineWebhookSecretMode = (typeof LINE_WEBHOOK_SECRET_MODES)[number];

export interface LineWebhookSecrets {
  mode: LineWebhookSecretMode;
  channelSecret: string;
  payloadKey: Buffer;
}

export class LineWebhookSecretError extends Error {
  readonly code = 'CREDENTIAL_UNAVAILABLE';

  constructor(
    detail: 'MODE_UNKNOWN' | 'KEYCHAIN_UNAVAILABLE' | 'FILE_UNAVAILABLE' | 'PAYLOAD_KEY_INVALID',
  ) {
    super(`webhook secret unusable: ${detail}`);
    this.name = 'LineWebhookSecretError';
  }
}

export async function resolveLineWebhookSecrets(input: {
  mode: string | undefined;
  channelAccountId: string;
  source?: LineSecretSource;
  /** directory of the secret files in `file` mode */
  secretDir?: string;
}): Promise<LineWebhookSecrets> {
  const mode = input.mode ?? 'disabled';
  if (mode === 'disabled') {
    return { mode, channelSecret: randomBytes(32).toString('hex'), payloadKey: randomBytes(32) };
  }
  if (mode !== 'keychain' && mode !== 'file') throw new LineWebhookSecretError('MODE_UNKNOWN');

  const source =
    input.source ??
    (mode === 'file'
      ? new FileLineSecretSource({
          channelAccountId: input.channelAccountId,
          ...(input.secretDir ? { secretDir: input.secretDir } : {}),
        })
      : new KeychainLineSecretSource());
  const keychainService = lineKeychainServiceName(input.channelAccountId);
  let channelSecret: string;
  let encodedKey: string;
  try {
    channelSecret = await source.read({ keychainService, keychainAccount: 'channel-secret' });
    encodedKey = await source.read({ keychainService, keychainAccount: 'webhook-payload-key' });
  } catch {
    throw new LineWebhookSecretError(mode === 'file' ? 'FILE_UNAVAILABLE' : 'KEYCHAIN_UNAVAILABLE');
  }
  const payloadKey = Buffer.from(encodedKey, 'base64');
  if (payloadKey.byteLength !== 32) throw new LineWebhookSecretError('PAYLOAD_KEY_INVALID');
  return { mode, channelSecret, payloadKey };
}
