/**
 * Owner: Delivery/Channels — ที่มาของ secret ของ webhook binding (S2.6b #403, #362 §9)
 *
 * channel secret และ payload key ห้ามอยู่ใน env/Git/log — composition root รับจาก env ได้แค่ "โหมด":
 * - `keychain`: อ่านจาก macOS Keychain (service `d-contact.line.<channel>`, account `channel-secret`
 *   และ `webhook-payload-key` แบบ base64 32 bytes) ใช้บนเครื่อง protected runner ของ pilot
 * - `disabled` (ค่าเริ่มต้น): สุ่ม secret/key ในหน่วยความจำ — signature จริงจาก LINE ตรวจไม่ผ่านเสมอ
 *   route จึงตอบ 401 ทุก request (fail closed) แต่ API ยังบูตบน CI/Linux ได้
 */
import { randomBytes } from 'node:crypto';
import type { LineSecretSource } from './line-credential-boundary.js';
import {
  KeychainLineSecretSource,
  lineKeychainServiceName,
} from './line-keychain-secret-source.js';

export const LINE_WEBHOOK_SECRET_MODES = ['keychain', 'disabled'] as const;
export type LineWebhookSecretMode = (typeof LINE_WEBHOOK_SECRET_MODES)[number];

export interface LineWebhookSecrets {
  mode: LineWebhookSecretMode;
  channelSecret: string;
  payloadKey: Buffer;
}

export class LineWebhookSecretError extends Error {
  readonly code = 'CREDENTIAL_UNAVAILABLE';

  constructor(detail: 'MODE_UNKNOWN' | 'KEYCHAIN_UNAVAILABLE' | 'PAYLOAD_KEY_INVALID') {
    super(`webhook secret ใช้ไม่ได้: ${detail}`);
    this.name = 'LineWebhookSecretError';
  }
}

export async function resolveLineWebhookSecrets(input: {
  mode: string | undefined;
  channelAccountId: string;
  source?: LineSecretSource;
}): Promise<LineWebhookSecrets> {
  const mode = input.mode ?? 'disabled';
  if (mode === 'disabled') {
    return { mode, channelSecret: randomBytes(32).toString('hex'), payloadKey: randomBytes(32) };
  }
  if (mode !== 'keychain') throw new LineWebhookSecretError('MODE_UNKNOWN');

  const source = input.source ?? new KeychainLineSecretSource();
  const keychainService = lineKeychainServiceName(input.channelAccountId);
  let channelSecret: string;
  let encodedKey: string;
  try {
    channelSecret = await source.read({ keychainService, keychainAccount: 'channel-secret' });
    encodedKey = await source.read({ keychainService, keychainAccount: 'webhook-payload-key' });
  } catch {
    throw new LineWebhookSecretError('KEYCHAIN_UNAVAILABLE');
  }
  const payloadKey = Buffer.from(encodedKey, 'base64');
  if (payloadKey.byteLength !== 32) throw new LineWebhookSecretError('PAYLOAD_KEY_INVALID');
  return { mode, channelSecret, payloadKey };
}
