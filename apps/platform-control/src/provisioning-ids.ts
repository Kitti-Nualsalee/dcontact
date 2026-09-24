/**
 * id ที่ deterministic ต่อ provisioning request (A1.4/A1.5) — แถวที่ saga seed ใช้ id เหล่านี้เสมอ
 * จึง replay ได้โดยไม่สร้างซ้ำ และตรวจ correlation ได้จาก id โดยไม่ต้องเก็บ mapping เพิ่ม
 */
import { createHash } from 'node:crypto';

/** UUID รูปแบบ v5 จาก sha256(namespace:value) — Postgres `uuid` รับได้ */
export function deterministicUuid(namespace: string, value: string): string {
  const hex = createHash('sha256').update(`${namespace}:${value}`).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function firstAdminUserId(requestId: string): string {
  return deterministicUuid('dcontact:first-admin', requestId);
}

/** แถว baseline ของ PLAN_BOOTSTRAP (#392 Bootstrap scope) */
export function bootstrapRowIds(requestId: string) {
  return {
    adminTeamId: deterministicUuid('dcontact:bootstrap:admin-team', requestId),
    generalTeamId: deterministicUuid('dcontact:bootstrap:general-team', requestId),
    generalQueueId: deterministicUuid('dcontact:bootstrap:general-queue', requestId),
    businessHoursId: deterministicUuid('dcontact:bootstrap:business-hours', requestId),
  };
}
