/**
 * D1.13 (#452): เปิด/ปิด UI flag ระดับ tenant (`ui.shell.v2`) โดย platform operator เท่านั้น
 * (ผู้ใช้ตัดสิน 2026-09-25) — `database` = Prisma ของ role `dcontact_platform`
 *
 * - ทุกการเปลี่ยนต้องมีเหตุผลและ actor และเขียน audit ใน transaction เดียวกัน
 * - การ **เปิด** ต้องยืนยันว่าไม่ขัดกับการเก็บหลักฐาน voice pilot #77 (Phase Contract: ห้ามเปิดระหว่าง #77
 *   จนกว่าผู้ใช้ยืนยัน) — การปิดทำได้ทันทีเสมอเพราะเป็นทาง rollback
 * - ตารางอยู่ใต้ tenant_isolation จึงตั้ง tenant context ก่อนเขียนเหมือนฝั่งแอป
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export const TENANT_UI_FLAGS = ['ui.shell.v2'] as const;
export type TenantUiFlagKey = (typeof TENANT_UI_FLAGS)[number];

export class TenantUiFlagError extends Error {
  constructor(
    readonly code:
      | 'TENANT_NOT_FOUND'
      | 'UNKNOWN_FLAG'
      | 'REASON_REQUIRED'
      | 'ACTOR_REQUIRED'
      | 'VOICE_PILOT_ACK_REQUIRED',
  ) {
    super(code);
    this.name = 'TenantUiFlagError';
  }
}

export interface SetTenantUiFlagInput {
  tenantSlug: string;
  flagKey: string;
  enabled: boolean;
  reason: string;
  actor: string;
  /** ต้องเป็น true เมื่อเปิด `ui.shell.v2` — ยืนยันว่าผู้ใช้อนุญาตแล้วเทียบกับ gate ของ #77 */
  voicePilotAcknowledged?: boolean;
}

export async function setTenantUiFlag(database: PrismaClient, input: SetTenantUiFlagInput) {
  if (!(TENANT_UI_FLAGS as readonly string[]).includes(input.flagKey)) {
    throw new TenantUiFlagError('UNKNOWN_FLAG');
  }
  const reason = input.reason.trim();
  if (reason.length < 3 || reason.length > 500) throw new TenantUiFlagError('REASON_REQUIRED');
  const actor = input.actor.trim();
  if (!actor) throw new TenantUiFlagError('ACTOR_REQUIRED');
  if (input.enabled && input.flagKey === 'ui.shell.v2' && input.voicePilotAcknowledged !== true) {
    throw new TenantUiFlagError('VOICE_PILOT_ACK_REQUIRED');
  }

  const tenant = await database.tenant.findUnique({
    where: { slug: input.tenantSlug },
    select: { id: true },
  });
  if (!tenant) throw new TenantUiFlagError('TENANT_NOT_FOUND');

  return withTenantDatabaseTransaction(database, tenant.id, async (tx) => {
    const key = { tenantId: tenant.id, flagKey: input.flagKey };
    const before = await tx.tenantUiFlag.findUnique({ where: { tenantId_flagKey: key } });
    await tx.tenantUiFlag.upsert({
      where: { tenantId_flagKey: key },
      create: { ...key, enabled: input.enabled, reason, updatedByActor: actor },
      update: { enabled: input.enabled, reason, updatedByActor: actor, updatedAt: new Date() },
    });
    await tx.tenantUiFlagAuditEvent.create({
      data: { ...key, enabled: input.enabled, reason, actor },
    });
    return {
      tenantId: tenant.id,
      flagKey: input.flagKey,
      enabled: input.enabled,
      previous: before?.enabled ?? false,
    };
  });
}
