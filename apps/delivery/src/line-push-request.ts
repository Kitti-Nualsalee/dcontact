/**
 * Owner: Delivery/Channels — canonical request ก่อน submission barrier (S2.4 #370, #357 §2)
 *
 * ทุกอย่างที่ตัดสินเนื้อหาของ request ต้องเกิด "ก่อน" barrier และถูก persist ครั้งเดียว:
 * fixture version, recipient ที่ resolve แล้ว, canonical payload, payload digest และ retry key
 *
 * หลัง barrier ห้ามเปลี่ยน recipient/content และห้าม mint key ใหม่ — retry ทุกครั้งต้องเป็น
 * byte-identical request เดิมพร้อม `X-Line-Retry-Key` เดิม ไม่งั้น LINE จะถือเป็นคนละ request
 * และผู้รับจะได้ข้อความซ้ำ
 */
import { createHash } from 'node:crypto';

/** fixture ที่อนุมัติแล้วของ S2 — immutable และเป็นชุดปิด (#357 §1) */
export const LINE_SERVICE_NOTIFICATION_FIXTURES = Object.freeze({
  'fixture:service-notification/v1': Object.freeze({
    version: 1,
    messages: Object.freeze([
      Object.freeze({
        type: 'text',
        text: 'แจ้งเตือนจากระบบบริการลูกค้า กรุณาตอบกลับข้อความนี้หากต้องการให้ติดต่อกลับ',
      }),
    ]),
  }),
});

export type LineFixtureRef = keyof typeof LINE_SERVICE_NOTIFICATION_FIXTURES;

export class LineFixtureUnknownError extends Error {
  readonly code = 'LINE_FIXTURE_UNKNOWN';
  constructor(readonly contentRef: string) {
    super(`LINE fixture ไม่อยู่ในชุดที่อนุมัติ: ${contentRef}`);
    this.name = 'LineFixtureUnknownError';
  }
}

export function isLineFixtureRef(contentRef: string): contentRef is LineFixtureRef {
  return Object.hasOwn(LINE_SERVICE_NOTIFICATION_FIXTURES, contentRef);
}

export function resolveLineFixture(contentRef: string) {
  if (!isLineFixtureRef(contentRef)) throw new LineFixtureUnknownError(contentRef);
  return LINE_SERVICE_NOTIFICATION_FIXTURES[contentRef];
}

export function lineContentDigest(contentRef: string): string {
  const fixture = resolveLineFixture(contentRef);
  return createHash('sha256')
    .update(JSON.stringify({ contentRef, version: fixture.version, messages: fixture.messages }))
    .digest('hex');
}

export interface LineCanonicalRequest {
  contentRef: string;
  fixtureVersion: number;
  messages: ReadonlyArray<Record<string, unknown>>;
  /** digest ของ payload ที่จะส่งจริง (รวมผู้รับแบบ fingerprint ไม่ใช่ค่าจริง) */
  providerPayloadDigest: string;
  recipientFingerprint: string;
}

/**
 * payload digest ผูกกับผู้รับด้วย fingerprint ไม่ใช่ userId — receipt จึงพิสูจน์ได้ว่า retry
 * เป็น request เดิมโดยไม่ต้องเก็บ raw recipient ไว้ใน evidence (#357 §4)
 */
export function buildLineCanonicalRequest(input: {
  contentRef: string;
  recipientFingerprint: string;
}): LineCanonicalRequest {
  const fixture = resolveLineFixture(input.contentRef);
  const messages = fixture.messages as ReadonlyArray<Record<string, unknown>>;
  const providerPayloadDigest = createHash('sha256')
    .update(
      JSON.stringify({
        contentRef: input.contentRef,
        version: fixture.version,
        messages,
        recipientFingerprint: input.recipientFingerprint,
      }),
    )
    .digest('hex');
  return {
    contentRef: input.contentRef,
    fixtureVersion: fixture.version,
    messages,
    providerPayloadDigest,
    recipientFingerprint: input.recipientFingerprint,
  };
}

const HEX_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** `X-Line-Retry-Key` ต้องเป็น hexadecimal UUID (#357 §2) — ค่าอื่น LINE ปฏิเสธ */
export function isLineRetryKey(value: string): boolean {
  return HEX_UUID.test(value);
}

/**
 * retry key ของ delivery หนึ่งใบ derive จาก identity ที่ persist ไว้แล้ว จึงได้ค่าเดิมทุกครั้ง
 * แม้ worker restart — ไม่ใช้ `randomUUID` เพราะค่าใหม่ = ผู้รับได้ข้อความซ้ำ
 */
export function deriveLineRetryKey(tenantId: string, deliveryId: string): string {
  const digest = createHash('sha256').update(`line-retry|${tenantId}|${deliveryId}`).digest('hex');
  const hex = digest.slice(0, 32);
  // บังคับรูป UUID v4/variant ให้ LINE ยอมรับ โดยยังคงความ deterministic
  const v4 = `${hex.slice(0, 12)}4${hex.slice(13, 16)}`;
  const variant = `${((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16)}${hex.slice(17, 20)}`;
  return `${v4.slice(0, 8)}-${v4.slice(8, 12)}-${v4.slice(12, 16)}-${variant}-${hex.slice(20, 32)}`;
}

// ── Retry window / backoff (#357 §3, #358 caps) ─────────────────────────────

/** หลัง 24 ชม. LINE อาจมอง retry key เดิมเป็น request ใหม่ — เราหยุดก่อนถึงเส้นนั้น */
export const LINE_RETRY_WINDOW_MS = 23 * 60 * 60 * 1000;
export const LINE_BACKOFF_BASE_MS = 30_000;
export const LINE_BACKOFF_MAX_MS = 15 * 60_000;

/** exponential backoff แบบ bounded: ทุก retry นับ rate limit จึงห้ามถี่ (#357 §3) */
export function lineBackoffMs(attemptNo: number): number {
  const exponent = Math.max(0, attemptNo - 1);
  return Math.min(LINE_BACKOFF_BASE_MS * 2 ** exponent, LINE_BACKOFF_MAX_MS);
}

export function lineRetryWindowExpired(firstAttemptAt: Date, now: Date): boolean {
  return now.getTime() - firstAttemptAt.getTime() >= LINE_RETRY_WINDOW_MS;
}
