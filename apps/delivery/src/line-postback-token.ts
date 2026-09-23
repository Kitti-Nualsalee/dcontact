/**
 * Owner: Delivery/Channels — opaque one-use correlation token ของ signed postback (S2.5 #369)
 *
 * Authority: Touch decision #361 §D ข้อ 2
 *
 * token ผูก delivery + config digest + เวลาหมดอายุ และลงนาม HMAC-SHA256 ด้วยกุญแจจาก Keychain
 * (ไม่ใช่ channel secret) รูปแบบ `dcpb1.<claims>.<mac>` เป็น base64url ทั้งสองท่อน
 *
 * S2.4 เป็นผู้ `issue` ตอนประกอบ approved postback template; S2.5 เป็นผู้ `verify` ใน worker
 * "ใช้ได้ครั้งเดียว" บังคับที่ database: Touch หนึ่งใบต่อ Attempt (`cg_touches (tenant_id, attempt_id)`)
 * และ response evidence ref unique — postback ใบที่สองของ token เดิมจึงเป็น conflict ไม่ใช่ Touch ที่สอง
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { inspect } from 'node:util';

const PREFIX = 'dcpb1';
const MAC_BYTES = 32;
const REDACTED = '[REDACTED]';
const BASE64URL = /^[A-Za-z0-9_-]+$/;
/** LINE จำกัด postback data ไว้ 300 ตัวอักษร */
const MAX_TOKEN_LENGTH = 300;

export interface LinePostbackClaims {
  deliveryId: string;
  configDigest: string;
  expiresAt: Date;
}

export type LinePostbackVerification =
  { status: 'VALID'; claims: LinePostbackClaims } | { status: 'INVALID' } | { status: 'EXPIRED' };

export class LinePostbackTokenCodec {
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length < 32) throw new TypeError('postback key ต้องยาวอย่างน้อย 32 bytes');
    this.#key = Buffer.from(key);
  }

  issue(claims: LinePostbackClaims): string {
    const body = Buffer.from(
      JSON.stringify({
        d: claims.deliveryId,
        c: claims.configDigest,
        e: claims.expiresAt.getTime(),
        n: randomBytes(12).toString('base64url'),
      }),
      'utf8',
    ).toString('base64url');
    const token = `${PREFIX}.${body}.${this.mac(body).toString('base64url')}`;
    if (token.length > MAX_TOKEN_LENGTH) throw new RangeError('postback token ยาวเกินที่ LINE รับ');
    return token;
  }

  /** เทียบ expiry กับ provider timestamp ของ event ไม่ใช่เวลาที่รับ (#361 §F) */
  verify(token: string, providerTimestamp: Date): LinePostbackVerification {
    if (token.length > MAX_TOKEN_LENGTH) return { status: 'INVALID' };
    const parts = token.split('.');
    if (parts.length !== 3 || parts[0] !== PREFIX) return { status: 'INVALID' };
    const [, body, mac] = parts as [string, string, string];
    if (!BASE64URL.test(body) || !BASE64URL.test(mac)) return { status: 'INVALID' };
    const provided = Buffer.from(mac, 'base64url');
    if (provided.length !== MAC_BYTES || !timingSafeEqual(provided, this.mac(body))) {
      return { status: 'INVALID' };
    }
    let claims: unknown;
    try {
      claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return { status: 'INVALID' };
    }
    if (
      typeof claims !== 'object' ||
      claims === null ||
      typeof (claims as { d?: unknown }).d !== 'string' ||
      typeof (claims as { c?: unknown }).c !== 'string' ||
      typeof (claims as { e?: unknown }).e !== 'number'
    ) {
      return { status: 'INVALID' };
    }
    const { d, c, e } = claims as { d: string; c: string; e: number };
    const expiresAt = new Date(e);
    if (Number.isNaN(expiresAt.getTime())) return { status: 'INVALID' };
    if (providerTimestamp.getTime() >= expiresAt.getTime()) return { status: 'EXPIRED' };
    return { status: 'VALID', claims: { deliveryId: d, configDigest: c, expiresAt } };
  }

  private mac(body: string): Buffer {
    return createHmac('sha256', this.#key).update(`${PREFIX}.${body}`, 'utf8').digest();
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
