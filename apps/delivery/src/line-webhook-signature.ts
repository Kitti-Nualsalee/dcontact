/**
 * Owner: Delivery/Channels — signature boundary ของ LINE webhook (S2.5 #369)
 *
 * Authority: webhook decision #359 §A/§B และ Phase Contract #362 §7
 *
 * - secret มาจาก trusted singleton binding **ก่อน** อ่าน body เสมอ — ไม่เลือก secret จาก field ใน body
 * - HMAC-SHA256 คำนวณจาก raw bytes ที่รับมาตรง ๆ ไม่ decode/normalize/reserialize ก่อน
 * - compare แบบ constant-time บน digest ที่ decode แล้ว ความยาวผิดคือ invalid ไม่ใช่ exception
 * - `LineChannelSecret` ไม่เคย serialize ค่าออกมา (`toString`/`toJSON`/`util.inspect` = `[REDACTED]`)
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';

const REDACTED = '[REDACTED]';
const SHA256_BYTES = 32;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** channel secret ใน memory ของ ingress เท่านั้น — อ่านจาก Keychain ตอน start ไม่ผ่าน env */
export class LineChannelSecret {
  readonly #value: Buffer;

  constructor(value: string) {
    if (value.length === 0) throw new TypeError('channel secret ต้องไม่ว่าง');
    this.#value = Buffer.from(value, 'utf8');
  }

  /** HMAC-SHA256 ของ raw bytes; ผู้เรียกได้ digest เท่านั้น ไม่เคยได้ค่า secret */
  sign(rawBody: Buffer): Buffer {
    return createHmac('sha256', this.#value).update(rawBody).digest();
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

/**
 * `x-line-signature` = base64(HMAC-SHA256(channelSecret, rawBody)) — header หาย, ไม่ใช่ base64
 * หรือยาวผิดถือเป็น invalid เหมือนกันหมด เพื่อให้ผู้เรียกตอบ fixed `401` แบบเดียว
 */
export function verifyLineSignature(
  rawBody: Buffer,
  signatureHeader: string | undefined,
  secret: LineChannelSecret,
): boolean {
  if (!signatureHeader || !BASE64.test(signatureHeader)) return false;
  const provided = Buffer.from(signatureHeader, 'base64');
  if (provided.length !== SHA256_BYTES) return false;
  return timingSafeEqual(provided, secret.sign(rawBody));
}

/**
 * fingerprint ของผู้รับ LINE ใน scope ของ channel หนึ่ง — ค่าที่ allowlist (#358) และ webhook
 * correlation (#361 §D) ต้องคำนวณแบบเดียวกัน userId เป็น random 128 bit จึงย้อนกลับจาก hash ไม่ได้
 * ทั้งนี้ไม่ใช่ความลับ แค่ทำให้ตารางและ evidence ไม่ต้องถือ raw user ID
 */
export function lineRecipientFingerprint(channelAccountId: string, lineUserId: string): string {
  return createHash('sha256')
    .update(`line-recipient:v1:${channelAccountId}:${lineUserId}`, 'utf8')
    .digest('hex');
}
