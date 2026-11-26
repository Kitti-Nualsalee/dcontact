/**
 * D1.13 (#452): turn a tenant-level UI flag (`ui.shell.v2`) on/off, by a platform operator only
 * (the user decided 2026-09-25) — `database` = Prisma with role `dcontact_platform`
 *
 * - every change needs a reason and an actor and writes an audit in the same transaction
 * - **turning on** must confirm it does not conflict with collecting voice pilot #77 evidence (Phase Contract: must not be enabled during #77
 *   until the user confirms) — turning off is always allowed immediately because it is the rollback path
 * - the table is under tenant_isolation, so set the tenant context before writing, as the app side does
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export const TENANT_UI_FLAGS = [
  'ui.shell.v2',
  // #583: `workSession.lease.enforced` was removed — the work-session lease is enforced for every tenant (the old row in the DB has no effect)
  // E1.11 (#485): allows embedding dphone in the customer's system (also needs an allowlist + entitlement)
  'dphone.embed.enabled',
] as const;
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
  /** must be true when turning on any flag — confirms the user has approved it against the gate of #77 (D1/E1 Phase Contract) */
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
  if (input.enabled && input.voicePilotAcknowledged !== true) {
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
