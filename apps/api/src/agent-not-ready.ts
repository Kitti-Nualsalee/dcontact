/**
 * #937 Agent ตั้ง Not Ready (BREAK + เหตุผล) และ Offline เอง, สถานะหลังจบงาน และข้อมูลสถานะใน snapshot
 * แบบ: docs/agent-readiness-setup.md หัวข้อ "โมเดลสถานะ" — เหตุผลมาจากรายการของ tenant (#936)
 */
import type { Prisma } from '@d-contact/db';

export type AgentSelfState = 'AVAILABLE' | 'BREAK' | 'OFFLINE';
export type AgentStateChangedBy = 'AGENT' | 'SUPERVISOR' | 'SYSTEM';

export interface AgentNotReadyReason {
  code: string;
  labelTh: string;
  labelEn: string;
}

/** body ของ POST availability: { state, reasonCode? } — reasonCode ต้องมีเฉพาะ BREAK */
export function parseAgentSelfState(
  body: unknown,
): { state: AgentSelfState; reasonCode?: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  // field อื่น (เช่น tenantId/userId ที่ client แอบส่ง) ไม่มีผล — ตัวตนมาจาก token เท่านั้น
  const { state, reasonCode } = body as Record<string, unknown>;
  if (state === 'AVAILABLE' || state === 'OFFLINE')
    return reasonCode === undefined ? { state } : undefined;
  if (
    state === 'BREAK' &&
    typeof reasonCode === 'string' &&
    /^[A-Z][A-Z0-9_]{1,31}$/.test(reasonCode)
  )
    return { state, reasonCode };
  return undefined;
}

/** body ของ PUT after-work: { state: 'AVAILABLE' } หรือ { state: 'BREAK', reasonCode } */
export function parseAfterWork(
  body: unknown,
): { state: 'AVAILABLE' } | { state: 'BREAK'; reasonCode: string } | undefined {
  const parsed = parseAgentSelfState(body);
  if (!parsed || parsed.state === 'OFFLINE') return undefined;
  return parsed.state === 'BREAK'
    ? { state: 'BREAK', reasonCode: parsed.reasonCode! }
    : { state: 'AVAILABLE' };
}

/** เหตุผลที่ Agent เลือกได้ตอนนี้ (เปิดอยู่) ตามลำดับที่ Admin ตั้ง */
export async function activeNotReadyReasons(
  tx: Prisma.TransactionClient,
  tenantId: string,
): Promise<AgentNotReadyReason[]> {
  const rows = await tx.$queryRaw<{ code: string; label_th: string; label_en: string }[]>`
    SELECT code, label_th, label_en FROM tenant_not_ready_reasons
      WHERE tenant_id=${tenantId}::uuid AND is_active ORDER BY position`;
  return rows.map((row) => ({ code: row.code, labelTh: row.label_th, labelEn: row.label_en }));
}

export async function isActiveNotReadyReason(
  tx: Prisma.TransactionClient,
  tenantId: string,
  code: string,
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT true AS ok FROM tenant_not_ready_reasons
      WHERE tenant_id=${tenantId}::uuid AND code=${code} AND is_active`;
  return rows.length > 0;
}

/**
 * ปิดงานหลังสายแล้ว — ใช้สถานะหลังจบงานที่ Agent ขอไว้ (ครั้งเดียว) ไม่มีที่ขอไว้ = Ready
 * เหตุผลที่ขอไว้ถูกปิดภายหลังยังใช้ตามที่ขอ (Agent ที่อยู่ในเหตุผลที่ปิดแล้วคงสถานะเดิม)
 */
export async function recordPostWrapupState(
  tx: Prisma.TransactionClient,
  tenantId: string,
  userId: string,
): Promise<{ state: 'AVAILABLE' | 'BREAK'; reasonCode?: string }> {
  const requested = await tx.agentAfterWorkState.findUnique({
    where: { tenantId_userId: { tenantId, userId } },
    select: { reasonCode: true },
  });
  if (requested) {
    await tx.agentAfterWorkState.delete({ where: { tenantId_userId: { tenantId, userId } } });
    await tx.agentStateLog.create({
      data: {
        tenantId,
        userId,
        state: 'BREAK',
        reasonCode: requested.reasonCode,
        actorUserId: userId,
        reason: 'after_work_not_ready',
      },
    });
    return { state: 'BREAK', reasonCode: requested.reasonCode };
  }
  await tx.agentStateLog.create({
    data: { tenantId, userId, state: 'AVAILABLE', reason: 'wrapup_completed' },
  });
  return { state: 'AVAILABLE' };
}

export function stateChangedBy(
  log: { actorUserId: string | null } | undefined,
  userId: string,
): AgentStateChangedBy {
  if (!log?.actorUserId) return 'SYSTEM';
  return log.actorUserId === userId ? 'AGENT' : 'SUPERVISOR';
}
