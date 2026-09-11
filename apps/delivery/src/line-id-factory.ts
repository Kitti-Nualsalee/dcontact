/**
 * Owner: Delivery/Channels — deterministic id minting ของ LINE simulation (S1.6)
 *
 * ทุก id derive จาก (tenantId, actionKey, kind, salt) ผ่าน sha256 ไม่มี `randomUUID`
 * หรือ counter ที่ผูกกับ process — restart บน shared store ต้อง mint id เดิมซ้ำได้
 * เมื่อ input เดิม (ดู `line-delivery-port.ts` §restart/replay)
 */
import { createHash } from 'node:crypto';

export type LineIdKind = 'delivery' | 'provider-request' | 'outcome' | 'event';

const PREFIX: Record<LineIdKind, string> = {
  delivery: 'line-dlv',
  'provider-request': 'line-prq',
  outcome: 'line-ocr',
  event: 'line-evt',
};

export function mintLineId(
  kind: LineIdKind,
  tenantId: string,
  actionKey: string,
  salt: string,
): string {
  const digest = createHash('sha256')
    .update([kind, tenantId, actionKey, salt].join('|'))
    .digest('hex');
  return `${PREFIX[kind]}_${digest.slice(0, 32)}`;
}
