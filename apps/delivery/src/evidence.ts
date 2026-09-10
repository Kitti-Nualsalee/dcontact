/**
 * Owner: Channels/Dialer — PII boundary ของ delivery outbox
 *
 * C1 ห้าม contact reference, เบอร์, อีเมล, LINE id หรือ CRM id ปรากฏใน key, header,
 * log หรือ evidence ใด ๆ ของ delivery ไฟล์นี้เป็นที่เดียวที่ตัดสินว่า field ไหน
 * ปล่อยออกไปข้างนอกได้ — ทุก log/evidence ต้องผ่าน `deliveryEvidence` ห้าม serialize
 * outbox row ตรง ๆ เพราะ row เก็บ contentRef และ binding ที่ไม่ต้องออกไป
 */
import { createHash } from 'node:crypto';
import type { DlDeliveryState, DlOutboxEntry } from '@d-contact/db';

/** field ที่ปล่อยออก log/evidence ได้: opaque id, enum และ timestamp เท่านั้น */
export const DELIVERY_EVIDENCE_FIELDS = [
  'tenantId',
  'deliveryId',
  'providerRequestKey',
  'reservationId',
  'actionKey',
  'adapter',
  'channel',
  'state',
  'outcome',
  'outcomeRef',
  'submittedAt',
  'settledAt',
  'correlationId',
] as const;

export type DeliveryEvidenceField = (typeof DELIVERY_EVIDENCE_FIELDS)[number];

export type DeliveryEvidence = Record<DeliveryEvidenceField, string | null> & {
  state: DlDeliveryState;
};

/**
 * contentRef ถูก resolve เป็นเนื้อหาโดย channel owner ตอนส่งจริงเท่านั้น adapter จึง
 * รับได้เฉพาะ reference สั้น ๆ ที่ไม่มีช่องว่างและไม่มี `@` — พอสำหรับปฏิเสธเคสที่
 * ผู้เรียกเผลอส่ง message body หรืออีเมลลูกค้าเข้ามาเป็น contentRef
 */
const CONTENT_REFERENCE_PATTERN = /^[A-Za-z0-9._:\-/]{1,200}$/;

export class InlineContentRejectedError extends Error {
  readonly code = 'INLINE_CONTENT_REJECTED';

  constructor() {
    super('contentRef ต้องเป็น opaque reference ไม่ใช่เนื้อหาหรือ contact identifier');
    this.name = 'InlineContentRejectedError';
  }
}

export function assertOpaqueContentRef(value: string): void {
  if (!CONTENT_REFERENCE_PATTERN.test(value)) throw new InlineContentRejectedError();
}

export function deliveryEvidence(entry: DlOutboxEntry): DeliveryEvidence {
  return {
    tenantId: entry.tenantId,
    deliveryId: entry.deliveryId,
    providerRequestKey: entry.providerRequestKey,
    reservationId: entry.reservationId,
    actionKey: entry.actionKey,
    adapter: entry.adapter,
    channel: entry.channel,
    state: entry.state,
    outcome: entry.outcome,
    outcomeRef: entry.outcomeRef,
    submittedAt: entry.submittedAt?.toISOString() ?? null,
    settledAt: entry.settledAt?.toISOString() ?? null,
    correlationId: entry.correlationId,
  };
}

/**
 * deliveryId และ providerRequestKey derive จาก (tenantId, actionKey, inputHash) แบบ
 * deterministic: retry หลัง crash จึง mint ค่าเดิมและได้ claim/begin เดิมกลับมาเป็น
 * replay แทนที่จะเปิด delivery ใบใหม่ ค่าที่ได้เป็น digest จึงไม่พา PII ออกไปกับ key
 */
export function mintOpaqueKey(
  kind: 'delivery' | 'provider-request',
  tenantId: string,
  actionKey: string,
  inputHash: string,
): string {
  const digest = createHash('sha256')
    .update([kind, tenantId, actionKey, inputHash].join('|'))
    .digest('hex');
  return `${kind === 'delivery' ? 'dlv' : 'prq'}_${digest.slice(0, 32)}`;
}

export function canonicalInputHash(input: Record<string, unknown>): string {
  const canonical = Object.entries(input)
    .filter(
      ([key, value]) => key !== 'correlationId' && key !== 'causationId' && value !== undefined,
    )
    .sort(([left], [right]) => left.localeCompare(right));
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}
