/**
 * Owner: Delivery/Channels — encrypted operational payload ของ LINE webhook (S2.5 #369)
 *
 * Authority: #359 §C ("encrypted operational payload/ref"), #361 §G และ #362 §3/§9
 *
 * webhook event ทั้งก้อนมี userId, message body, replyToken และ quoteToken จึงเก็บได้เฉพาะแบบ
 * ciphertext: AES-256-GCM ฝั่งแอป nonce สุ่มต่อแถว และ AAD ผูก tenant + payload ref ไว้ด้วย
 * ciphertext ที่ถูกย้ายไปแถว/tenant อื่นจึงเปิดไม่ได้แม้ใช้กุญแจเดียวกัน
 *
 * กุญแจมาจาก `LinePayloadKeyring` ที่ runtime ฉีดเข้ามา (Keychain) — ไม่อยู่ใน env, database หรือ log
 * และมี version เพื่อให้หมุนกุญแจได้โดยแถวเก่ายังเปิดด้วย version ของมันเอง
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { inspect } from 'node:util';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const REDACTED = '[REDACTED]';

export interface LinePayloadKeyring {
  readonly currentVersion: number;
  key(version: number): Buffer | undefined;
}

/** keyring ใน memory ที่ runtime สร้างหลังอ่าน Keychain; serialize ออกมาเป็น `[REDACTED]` */
export class StaticLinePayloadKeyring implements LinePayloadKeyring {
  readonly #keys: ReadonlyMap<number, Buffer>;

  constructor(
    readonly currentVersion: number,
    keys: ReadonlyMap<number, Buffer>,
  ) {
    for (const [version, key] of keys) {
      if (!Number.isInteger(version) || version < 1) throw new TypeError('key version ต้อง ≥ 1');
      if (key.length !== KEY_BYTES) throw new TypeError('payload key ต้องยาว 32 bytes');
    }
    if (!keys.has(currentVersion)) throw new TypeError('ไม่มีกุญแจของ current version');
    this.#keys = new Map([...keys].map(([version, key]) => [version, Buffer.from(key)]));
  }

  key(version: number): Buffer | undefined {
    return this.#keys.get(version);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [inspect.custom](): string {
    return REDACTED;
  }
}

export interface SealedLinePayload {
  payloadRef: string;
  keyVersion: number;
  nonce: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
}

export class LineProtectedPayloadError extends Error {
  readonly code = 'LINE_PROTECTED_PAYLOAD_UNREADABLE';

  constructor() {
    // ไม่บอกเหตุผลละเอียด (กุญแจผิด/ข้อมูลถูกแก้/tenant ไม่ตรง) — ผลเหมือนกันคือเปิดไม่ได้
    super('protected payload ของ LINE เปิดไม่ได้');
    this.name = 'LineProtectedPayloadError';
  }
}

function additionalData(tenantId: string, payloadRef: string): Buffer {
  return Buffer.from(`line-payload:v1:${tenantId}:${payloadRef}`, 'utf8');
}

export function sealLinePayload(
  keyring: LinePayloadKeyring,
  tenantId: string,
  payloadRef: string,
  plaintext: Buffer,
): SealedLinePayload {
  const key = keyring.key(keyring.currentVersion);
  if (!key) throw new LineProtectedPayloadError();
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce, { authTagLength: TAG_BYTES });
  cipher.setAAD(additionalData(tenantId, payloadRef));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    payloadRef,
    keyVersion: keyring.currentVersion,
    nonce,
    authTag: cipher.getAuthTag(),
    ciphertext,
  };
}

export function openLinePayload(
  keyring: LinePayloadKeyring,
  tenantId: string,
  sealed: SealedLinePayload,
): Buffer {
  const key = keyring.key(sealed.keyVersion);
  if (!key || sealed.nonce.length !== NONCE_BYTES || sealed.authTag.length !== TAG_BYTES) {
    throw new LineProtectedPayloadError();
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.nonce, {
      authTagLength: TAG_BYTES,
    });
    decipher.setAAD(additionalData(tenantId, sealed.payloadRef));
    decipher.setAuthTag(sealed.authTag);
    return Buffer.concat([decipher.update(sealed.ciphertext), decipher.final()]);
  } catch {
    throw new LineProtectedPayloadError();
  }
}
