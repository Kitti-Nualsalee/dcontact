import { Prisma, lockTeamReferences } from '@d-contact/db';
import {
  authorizeC360ContactAccess,
  type C360ContactAccess,
  type C360VerifiedActor,
} from './profile-authorization.js';
import { C360ProfileCommandError } from './profile-command.js';

/**
 * Cus360 C1 (#791) S4: transaction-aware owner fences per E1 G
 *
 * Every key belongs to the original owner and the owner writer really holds the same key; this is not a one-sided namespace:
 * - identity: the canonical writer holds exclusive; membership commit and Cus360 hold shared
 * - IAM scope-version: grant/revoke UPDATE the row, Cus360 holds FOR SHARE
 * - IAM contact projection: the projection consumer holds exclusive, Cus360 holds shared
 *
 * Cus360 uses try/NOWAIT throughout, so it adds no wait back into the owner or Voice; failing to lock =
 * RESOURCE_BUSY, so the engine rolls back and retries the whole transaction and never continues in an aborted transaction
 */

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Existing key of the canonical writer (`segment-membership-repository.ts`); its format must not change */
export function c360IdentityFenceKey(tenantId: string, contactId: string): string {
  return `c360-membership:${tenantId}:identity:${contactId}`;
}

/** Key of the IAM projection consumer per contact (E1 G: `iam-contact-scope:<tenant>:<contact>`) */
export function iamContactScopeFenceKey(tenantId: string, contactId: string): string {
  return `iam-contact-scope:${tenantId}:${contactId}`;
}

/** Orders custodian grant/revoke against profile writes after the identity fence */
export async function tryC360CustodianFences(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactIds: readonly string[],
): Promise<void> {
  for (const contactId of sortedUnique(contactIds)) {
    const key = `c360-custodian:${tenantId}:${contactId}`;
    const [row] = await tx.$queryRaw<{ locked: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${key}, 0)) AS locked`;
    if (!row?.locked) throw busy();
  }
}

function busy(): C360ProfileCommandError {
  return new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
}

/** Shared try-style identity fence for Cus360 commands; blocks a canonical transition during a command */
export async function tryC360IdentityFences(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactIds: readonly string[],
): Promise<void> {
  for (const contactId of sortedUnique(contactIds)) {
    const [row] = await tx.$queryRaw<{ locked: boolean }[]>(
      Prisma.sql`SELECT pg_try_advisory_xact_lock_shared(hashtext(${c360IdentityFenceKey(tenantId, contactId)})) AS locked`,
    );
    if (!row?.locked) throw busy();
  }
}

/** Shared try-style projection fence; blocks the consumer from changing the projection while freshness is being decided */
export async function tryIamContactProjectionFences(
  tx: Prisma.TransactionClient,
  tenantId: string,
  contactIds: readonly string[],
): Promise<void> {
  for (const contactId of sortedUnique(contactIds)) {
    const [row] = await tx.$queryRaw<{ locked: boolean }[]>(
      Prisma.sql`SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${iamContactScopeFenceKey(tenantId, contactId)}, 0)) AS locked`,
    );
    if (!row?.locked) throw busy();
  }
}

/** FOR SHARE NOWAIT on the team's scope-version; conflicts with the UPDATE of IAM grant/revoke */
export async function lockIamScopeVersionsShared(
  tx: Prisma.TransactionClient,
  tenantId: string,
  teamIds: readonly string[],
): Promise<void> {
  const ids = sortedUnique(teamIds);
  if (ids.length === 0) return;
  await tx.$queryRaw(Prisma.sql`
    SELECT team_id FROM iam_team_scope_versions
    WHERE tenant_id = ${tenantId}::uuid AND team_id IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
    ORDER BY team_id FOR SHARE NOWAIT`);
}

function lockErrorToBusy(error: unknown): never {
  const text = error instanceof Error ? error.message : '';
  if (/55P03|lock_not_available|could not obtain lock|TEAM_REFERENCE_BUSY/.test(text)) throw busy();
  throw error;
}

/**
 * Locks in the E1 G order for a Cus360 mutation, then decides permission from the state after locking:
 * Team reference → IAM scope-version → User → identities of the whole contact set → IAM projection
 *
 * Called after the command fence (S2) and before capability/profile/tag/point rows. The decision belongs to
 * this transaction only; an outside pre-read is used only to collect IDs
 */
export async function fenceC360ContactMutation(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactIds: readonly string[],
): Promise<Map<string, C360ContactAccess>> {
  const contacts = sortedUnique(contactIds);
  // IAM applies only to actors with a team (Admin read via VIEW, or Supervisor); a custodian does not depend on a team
  const team = actor.teamId && actor.role !== 'AGENT' ? actor.teamId : null;
  try {
    if (team) {
      await lockTeamReferences(tx, actor.tenantId, [team]);
      await lockIamScopeVersionsShared(tx, actor.tenantId, [team]);
    }
    await tx.$queryRaw(Prisma.sql`
      SELECT id FROM users WHERE tenant_id = ${actor.tenantId}::uuid AND id = ${actor.userId}::uuid
      FOR SHARE NOWAIT`);
  } catch (error) {
    lockErrorToBusy(error);
  }
  await tryC360IdentityFences(tx, actor.tenantId, contacts);
  if (team) await tryIamContactProjectionFences(tx, actor.tenantId, contacts);
  await tryC360CustodianFences(tx, actor.tenantId, contacts);

  const access = new Map<string, C360ContactAccess>();
  for (const contactId of contacts) {
    access.set(contactId, await authorizeC360ContactAccess(tx, actor, contactId));
  }
  return access;
}
