/**
 * #937 the Agent sets Not Ready (BREAK + reason) and Offline themselves, the after-work state, and the state info in the snapshot
 * per docs/agent-readiness-setup.md section "state model" — reasons come from the tenant's list (#936)
 */
import type { Prisma } from '@d-contact/db';

export type AgentSelfState = 'AVAILABLE' | 'BREAK' | 'OFFLINE';
export type AgentStateChangedBy = 'AGENT' | 'SUPERVISOR' | 'SYSTEM';

export interface AgentNotReadyReason {
  code: string;
  labelTh: string;
  labelEn: string;
}

/** the body of POST availability: { state, reasonCode? } — reasonCode is allowed only for BREAK */
export function parseAgentSelfState(
  body: unknown,
): { state: AgentSelfState; reasonCode?: string } | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  // other fields (e.g. a tenantId/userId the client sneaks in) have no effect — identity comes only from the token
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

/** the body of PUT after-work: { state: 'AVAILABLE' } or { state: 'BREAK', reasonCode } */
export function parseAfterWork(
  body: unknown,
): { state: 'AVAILABLE' } | { state: 'BREAK'; reasonCode: string } | undefined {
  const parsed = parseAgentSelfState(body);
  if (!parsed || parsed.state === 'OFFLINE') return undefined;
  return parsed.state === 'BREAK'
    ? { state: 'BREAK', reasonCode: parsed.reasonCode! }
    : { state: 'AVAILABLE' };
}

/** the reasons the Agent can choose now (enabled), in the order the Admin set */
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
 * after closing work after a call — uses the after-work state the Agent requested (once); none requested = Ready
 * a requested reason closed later is still used as requested (an Agent in a now-closed reason keeps the original state)
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
