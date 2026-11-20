/**
 * #936 รายการเหตุผล Not Ready ต่อ tenant (docs/agent-readiness-setup.md, คำตัดสิน owner ข้อ 4)
 *
 * ทั้งรายการเป็น resource เดียวต่อ tenant (resource_id = tenant_id เหมือน ORGANIZATION) แก้ด้วย command
 * `NOT_READY_REASONS_UPDATE` ที่ส่งรายการใหม่ทั้งชุด: ลำดับในรายการ = ลำดับที่ Agent เห็น,
 * เหตุผลที่ไม่มี code = เพิ่มใหม่, code เดิมที่หายไป = ลบ (ลบได้เฉพาะที่ยังไม่เคยถูกใช้)
 * สิทธิ์ใช้กติกา Core Settings เดิม: ทุกบทบาทที่เข้า Core Settings อ่านได้ เฉพาะ ADMIN แก้ได้
 */
import type { Prisma, PrismaClient } from '@d-contact/db';
import {
  coreActor,
  coreTransaction,
  executeCoreCommand,
  prepareCoreCommand,
  type CoreIdentity,
} from './tenant-core-command.js';
import { coreFail } from './tenant-core-errors.js';

export const NOT_READY_REASON_LIMIT = 30;
export const NOT_READY_REASON_LABEL_MAX = 40;
const CODE = /^[A-Z][A-Z0-9_]{1,31}$/;

export interface NotReadyReason {
  code: string;
  labelTh: string;
  labelEn: string;
  isActive: boolean;
  /** เคยถูกใช้แล้ว = ลบไม่ได้ ปิดได้เท่านั้น */
  inUse: boolean;
}
export interface NotReadyReasonsSnapshot {
  id: string;
  revision: string;
  reasons: NotReadyReason[];
}
export interface NotReadyReasonDraft {
  code?: string;
  labelTh: string;
  labelEn: string;
  isActive: boolean;
}

export async function notReadyReasonsSnapshot(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<NotReadyReasonsSnapshot> {
  const rows = await tx.$queryRaw<
    {
      code: string;
      label_th: string;
      label_en: string;
      is_active: boolean;
      in_use: boolean;
    }[]
  >`SELECT code, label_th, label_en, is_active, first_used_at IS NOT NULL AS in_use
      FROM tenant_not_ready_reasons WHERE tenant_id=${tenantId}::uuid ORDER BY position`;
  const [revision] = await tx.$queryRaw<{ revision: bigint }[]>`
    SELECT revision FROM tenant_not_ready_reason_revisions WHERE tenant_id=${tenantId}::uuid`;
  return {
    id: tenantId,
    revision: (revision?.revision ?? 0n).toString(),
    reasons: rows.map((row) => ({
      code: row.code,
      labelTh: row.label_th,
      labelEn: row.label_en,
      isActive: row.is_active,
      inUse: row.in_use,
    })),
  };
}

export function readNotReadyReasons(db: PrismaClient, identity: CoreIdentity) {
  return coreTransaction(db, identity.tenantId, async (tx) => {
    await coreActor(tx, identity, false);
    return { notReadyReasons: await notReadyReasonsSnapshot(tx, identity.tenantId) };
  });
}

/** ตรวจรูปแบบ request (400) แยกจากกติกาทางธุรกิจที่ตรวจกับข้อมูลปัจจุบัน (422/409) */
export function parseNotReadyReasonsRequest(body: unknown): {
  commandId: unknown;
  expectedRevision: unknown;
  reasons: NotReadyReasonDraft[];
} {
  if (!body || typeof body !== 'object' || Array.isArray(body)) coreFail('INVALID_REQUEST', 400);
  const input = body as Record<string, unknown>;
  if (Object.keys(input).some((k) => !['commandId', 'expectedRevision', 'reasons'].includes(k)))
    coreFail('INVALID_REQUEST', 400);
  if (
    !Array.isArray(input.reasons) ||
    input.reasons.length === 0 ||
    input.reasons.length > NOT_READY_REASON_LIMIT
  )
    coreFail('INVALID_REQUEST', 400);
  const codes = new Set<string>();
  const reasons = input.reasons.map((raw): NotReadyReasonDraft => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) coreFail('INVALID_REQUEST', 400);
    const item = raw as Record<string, unknown>;
    if (Object.keys(item).some((k) => !['code', 'labelTh', 'labelEn', 'isActive'].includes(k)))
      coreFail('INVALID_REQUEST', 400);
    if (
      typeof item.labelTh !== 'string' ||
      typeof item.labelEn !== 'string' ||
      typeof item.isActive !== 'boolean' ||
      (item.code !== undefined && (typeof item.code !== 'string' || !CODE.test(item.code)))
    )
      coreFail('INVALID_REQUEST', 400);
    if (item.code !== undefined) {
      if (codes.has(item.code as string)) coreFail('INVALID_REQUEST', 400);
      codes.add(item.code as string);
    }
    return {
      ...(item.code !== undefined ? { code: item.code as string } : {}),
      labelTh: item.labelTh.trim(),
      labelEn: item.labelEn.trim(),
      isActive: item.isActive,
    };
  });
  return { commandId: input.commandId, expectedRevision: input.expectedRevision, reasons };
}

/**
 * กติกาของรายการใหม่เทียบกับรายการปัจจุบัน — คืน field error ตามตำแหน่ง (`reasons.<i>.labelTh`)
 * ให้หน้าจอชี้แถวที่ต้องแก้ได้
 */
export function notReadyReasonsFieldErrors(
  drafts: readonly NotReadyReasonDraft[],
): Record<string, string> {
  const errors: Record<string, string> = {};
  const seenTh = new Map<string, number>();
  const seenEn = new Map<string, number>();
  drafts.forEach((draft, index) => {
    for (const [field, value, seen] of [
      ['labelTh', draft.labelTh, seenTh],
      ['labelEn', draft.labelEn, seenEn],
    ] as const) {
      if (!value || [...value].length > NOT_READY_REASON_LABEL_MAX)
        errors[`reasons.${index}.${field}`] = 'core.validation.notReadyReasonLabel';
      else {
        const key = value.toLocaleLowerCase();
        if (seen.has(key))
          errors[`reasons.${index}.${field}`] = 'core.validation.notReadyReasonDuplicate';
        else seen.set(key, index);
      }
    }
  });
  if (!drafts.some((draft) => draft.isActive))
    errors.reasons = 'core.validation.notReadyReasonActiveRequired';
  return errors;
}

/** code ของเหตุผลใหม่จากชื่อภาษาอังกฤษ — ไม่ชนกับ code ที่มีอยู่ (ทั้งที่ยังอยู่และที่เพิ่มในคำสั่งเดียวกัน) */
export function newNotReadyReasonCode(labelEn: string, taken: ReadonlySet<string>): string {
  const base =
    labelEn
      .normalize('NFKD')
      .toUpperCase()
      .replace(/[^A-Z0-9]+/g, '_')
      .replace(/^[^A-Z]+|_+$/g, '')
      .slice(0, 24) || 'REASON';
  const stem = base.length >= 2 ? base : `${base}_X`;
  if (!taken.has(stem)) return stem;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function updateNotReadyReasons(
  db: PrismaClient,
  identity: CoreIdentity,
  body: unknown,
) {
  const request = parseNotReadyReasonsRequest(body);
  const command = prepareCoreCommand({
    commandId: request.commandId,
    expectedRevision: request.expectedRevision,
    action: 'NOT_READY_REASONS_UPDATE',
    resourceType: 'NOT_READY_REASONS',
    resourceId: identity.tenantId,
    payload: { reasons: request.reasons as unknown as Prisma.InputJsonArray },
  });
  return executeCoreCommand(db, identity, command, async (tx) => {
    const locks = await tx.$queryRaw<
      { locked: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`core-not-ready-reasons:${identity.tenantId}`},0)) AS locked`;
    if (!locks[0]?.locked) coreFail('CONFIG_BUSY', 409, { retryable: true });
    const before = await notReadyReasonsSnapshot(tx, identity.tenantId);
    if (before.revision !== command.expectedRevision)
      coreFail('REVISION_CONFLICT', 409, { currentRevision: before.revision });

    const current = new Map(before.reasons.map((reason) => [reason.code, reason]));
    const fieldErrors = notReadyReasonsFieldErrors(request.reasons);
    request.reasons.forEach((draft, index) => {
      if (draft.code !== undefined && !current.has(draft.code))
        fieldErrors[`reasons.${index}.code`] = 'core.validation.notReadyReasonUnknown';
    });
    if (Object.keys(fieldErrors).length) coreFail('VALIDATION_FAILED', 422, { fieldErrors });

    const kept = new Set(request.reasons.flatMap((draft) => (draft.code ? [draft.code] : [])));
    const removed = before.reasons.filter((reason) => !kept.has(reason.code));
    const inUse = removed.filter((reason) => reason.inUse);
    if (inUse.length)
      coreFail('NOT_READY_REASON_IN_USE', 409, {
        blockers: inUse.map((reason) => ({ kind: reason.code, count: 1 })),
      });

    const taken = new Set(before.reasons.map((reason) => reason.code));
    const next = request.reasons.map((draft) => {
      const code = draft.code ?? newNotReadyReasonCode(draft.labelEn, taken);
      taken.add(code);
      return { ...draft, code };
    });
    const unchanged =
      next.length === before.reasons.length &&
      next.every((reason, index) => {
        const prior = before.reasons[index]!;
        return (
          prior.code === reason.code &&
          prior.labelTh === reason.labelTh &&
          prior.labelEn === reason.labelEn &&
          prior.isActive === reason.isActive
        );
      });
    if (unchanged)
      return {
        outcome: 'NO_OP',
        revision: BigInt(before.revision),
        snapshot: before as unknown as Prisma.InputJsonObject,
      };

    if (removed.length)
      await tx.$executeRaw`DELETE FROM tenant_not_ready_reasons
        WHERE tenant_id=${identity.tenantId}::uuid AND code = ANY(${removed.map((r) => r.code)}::text[])`;
    for (const [position, reason] of next.entries()) {
      await tx.$executeRaw`INSERT INTO tenant_not_ready_reasons(tenant_id, code, label_th, label_en, is_active, position)
        VALUES (${identity.tenantId}::uuid, ${reason.code}, ${reason.labelTh}, ${reason.labelEn}, ${reason.isActive}, ${position})
        ON CONFLICT (tenant_id, code) DO UPDATE SET label_th=EXCLUDED.label_th, label_en=EXCLUDED.label_en,
          is_active=EXCLUDED.is_active, position=EXCLUDED.position`;
    }
    if (before.revision === '0')
      await tx.$executeRaw`INSERT INTO tenant_not_ready_reason_revisions(tenant_id, revision) VALUES (${identity.tenantId}::uuid, 1)`;
    else
      await tx.$executeRaw`UPDATE tenant_not_ready_reason_revisions SET revision = revision + 1
        WHERE tenant_id=${identity.tenantId}::uuid`;
    const snapshot = await notReadyReasonsSnapshot(tx, identity.tenantId);
    return {
      outcome: 'APPLIED',
      revision: BigInt(snapshot.revision),
      beforeRevision: BigInt(before.revision),
      before: before as unknown as Prisma.InputJsonObject,
      snapshot: snapshot as unknown as Prisma.InputJsonObject,
    };
  });
}
