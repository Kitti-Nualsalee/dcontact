/**
 * Owner: Delivery/Channels — parse และตีความ LINE webhook หลัง signature ผ่านแล้วเท่านั้น (S2.5 #369)
 *
 * Authority: #359 §B/§C/§D, #361 §D และ LINE Messaging API webhook schema
 *
 * สองชั้น:
 * 1. `parseLineWebhook` — ingress ใช้ ตรวจแค่ field ที่ inbox ต้องใช้ (event ID/type/mode/timestamp/
 *    redelivery) แบบ forward-compatible: field ที่ไม่รู้จักผ่านได้ และ type ที่ไม่รู้จักยังเก็บได้
 * 2. `interpretLineEvent` — worker ใช้ หลังเปิด protected payload แล้ว แยก event เป็นสัญญาณที่
 *    Channels สนใจ: message projection, quoted response และ postback
 *
 * ผลลัพธ์ของไฟล์นี้ไม่ถือ body ของข้อความ; userId อยู่ใน `interpretLineEvent` เพื่อให้ worker
 * คำนวณ fingerprint แล้วทิ้ง ห้ามส่งค่านี้ต่อไป log, event หรือ evidence
 */
import { createHash } from 'node:crypto';

export interface ParsedLineWebhookEvent {
  webhookEventId: string;
  eventType: string;
  deliveryMode: 'active' | 'standby';
  isRedelivery: boolean;
  providerTimestamp: Date;
  /** sha256 ของ JSON ของ event นี้ — event ID เดิม + hash ต่าง = idempotency conflict (#359 §C) */
  payloadHash: string;
  /** JSON ของ event ทั้งก้อน สำหรับเข้ารหัสเท่านั้น (มี PII) */
  plaintext: Buffer;
}

export interface ParsedLineWebhook {
  destination: string;
  events: ParsedLineWebhookEvent[];
}

const WEBHOOK_EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const EVENT_TYPE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const DESTINATION = /^U[0-9a-f]{32}$/;
const PROVIDER_ID = /^[0-9]{1,32}$/;
const LINE_USER_ID = /^U[0-9a-f]{32}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseEvent(raw: unknown): ParsedLineWebhookEvent | null {
  if (!isRecord(raw)) return null;
  const { webhookEventId, type, mode, timestamp, deliveryContext } = raw;
  if (typeof webhookEventId !== 'string' || !WEBHOOK_EVENT_ID.test(webhookEventId)) return null;
  if (typeof type !== 'string' || !EVENT_TYPE.test(type)) return null;
  if (mode !== 'active' && mode !== 'standby') return null;
  if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
    return null;
  }
  if (!isRecord(deliveryContext) || typeof deliveryContext.isRedelivery !== 'boolean') return null;

  // stringify ของ object ที่ parse จาก bytes เดิมให้ผลเดิมเสมอ (ลำดับ key คงตามต้นฉบับ)
  const plaintext = Buffer.from(JSON.stringify(raw), 'utf8');
  // hash ไม่รวม deliveryContext: LINE เปลี่ยน isRedelivery เป็น true ตอนส่งซ้ำ ถ้านับด้วย
  // redelivery ปกติทุกครั้งจะกลายเป็น idempotency conflict (#359 §D: เป็น metadata ไม่ใช่ identity)
  const { deliveryContext: _redeliveryMetadata, ...identity } = raw;
  return {
    webhookEventId,
    eventType: type,
    deliveryMode: mode,
    isRedelivery: deliveryContext.isRedelivery,
    providerTimestamp: new Date(timestamp),
    payloadHash: createHash('sha256').update(JSON.stringify(identity), 'utf8').digest('hex'),
    plaintext,
  };
}

/**
 * ต้องเรียกหลัง `verifyLineSignature` ผ่านแล้วเท่านั้น — envelope หรือ event ที่ขาด field ของ inbox
 * ทำให้ทั้ง request invalid เพราะเก็บเป็นแถวไม่ได้ (ไม่มีคีย์ให้ dedupe)
 */
export function parseLineWebhook(rawBody: Buffer): ParsedLineWebhook | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(rawBody));
  } catch {
    return null;
  }
  if (!isRecord(decoded)) return null;
  const { destination, events } = decoded;
  if (typeof destination !== 'string' || !DESTINATION.test(destination)) return null;
  // ไม่จำกัดจำนวน event: LINE ไม่ได้ประกาศเพดาน และ request ที่ลงนามถูกแต่ถูกปัดด้วย 4xx จะถูก
  // redeliver ซ้ำแบบเดิมจนข้อมูลหาย — ขนาดถูกคุมแล้วด้วยเพดาน body ก่อน verify
  if (!Array.isArray(events)) return null;
  const parsed: ParsedLineWebhookEvent[] = [];
  const seen = new Set<string>();
  for (const raw of events) {
    const event = parseEvent(raw);
    if (!event) return null;
    // event ID ซ้ำใน request เดียวกันแปลว่า payload เชื่อไม่ได้ทั้งก้อน
    if (seen.has(event.webhookEventId)) return null;
    seen.add(event.webhookEventId);
    parsed.push(event);
  }
  return { destination, events: parsed };
}

// ── การตีความใน worker ──────────────────────────────────────────────────────

/**
 * ชนิด event ที่เอกสาร LINE Messaging API ประกาศไว้ — นอกชุดนี้ quarantine เป็น
 * `WEBHOOK_UNSUPPORTED_EVENT_TYPE` (#359 §D) แต่ endpoint ยัง ack ได้ตามปกติ
 */
export const LINE_KNOWN_EVENT_TYPES: readonly string[] = Object.freeze([
  'message',
  'unsend',
  'follow',
  'unfollow',
  'join',
  'leave',
  'memberJoined',
  'memberLeft',
  'postback',
  'videoPlayComplete',
  'beacon',
  'accountLink',
  'things',
  'membership',
  'module',
  'activated',
  'deactivated',
  'botSuspended',
  'botResumed',
]);

export type LineInterpretedEvent =
  | { kind: 'UNSUPPORTED' }
  | { kind: 'SCHEMA_INVALID' }
  | {
      kind: 'SIGNAL';
      /** มีเฉพาะ event ที่มาจาก chat หนึ่งต่อหนึ่ง — group/room ไม่นับเป็น response ของผู้รับ */
      oneToOneUserId?: string;
      message?: { providerMessageId: string; messageType: string; quotedMessageId?: string };
      postbackData?: string;
    };

export function interpretLineEvent(plaintext: Buffer): LineInterpretedEvent {
  let event: unknown;
  try {
    event = JSON.parse(plaintext.toString('utf8'));
  } catch {
    return { kind: 'SCHEMA_INVALID' };
  }
  if (!isRecord(event) || typeof event.type !== 'string') return { kind: 'SCHEMA_INVALID' };
  if (!LINE_KNOWN_EVENT_TYPES.includes(event.type)) return { kind: 'UNSUPPORTED' };

  const source = isRecord(event.source) ? event.source : undefined;
  const oneToOneUserId =
    source?.type === 'user' && typeof source.userId === 'string' && LINE_USER_ID.test(source.userId)
      ? source.userId
      : undefined;

  if (event.type === 'message') {
    const message = event.message;
    if (!isRecord(message)) return { kind: 'SCHEMA_INVALID' };
    const { id, type, quotedMessageId } = message;
    if (typeof id !== 'string' || !PROVIDER_ID.test(id)) return { kind: 'SCHEMA_INVALID' };
    if (typeof type !== 'string' || !/^[a-z][A-Za-z0-9_]{0,31}$/.test(type)) {
      return { kind: 'SCHEMA_INVALID' };
    }
    if (
      quotedMessageId !== undefined &&
      (typeof quotedMessageId !== 'string' || !PROVIDER_ID.test(quotedMessageId))
    ) {
      return { kind: 'SCHEMA_INVALID' };
    }
    return {
      kind: 'SIGNAL',
      ...(oneToOneUserId ? { oneToOneUserId } : {}),
      message: {
        providerMessageId: id,
        messageType: type,
        ...(typeof quotedMessageId === 'string' ? { quotedMessageId } : {}),
      },
    };
  }

  if (event.type === 'postback') {
    const postback = event.postback;
    if (!isRecord(postback) || typeof postback.data !== 'string') {
      return { kind: 'SCHEMA_INVALID' };
    }
    return {
      kind: 'SIGNAL',
      ...(oneToOneUserId ? { oneToOneUserId } : {}),
      postbackData: postback.data,
    };
  }

  return { kind: 'SIGNAL', ...(oneToOneUserId ? { oneToOneUserId } : {}) };
}
