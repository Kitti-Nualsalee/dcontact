import { Prisma } from '@d-contact/db';

/**
 * Cus360 C1 (#791) S3: authorization predicates per R1 C and E1 G (IAM freshness barrier)
 *
 * The single source of truth is the SQL fragments below: detail, list and count are composed from the same fragments
 * so a list can never count an item that detail rejects (or vice versa)
 *
 * - Admin: explicit custodian grant (not revoked) — MANAGE can edit, READ can read; or IAM VIEW
 *   of the user's own team, fresh, for reading only. The ADMIN role alone does not grant access to the whole tenant
 * - Supervisor: an active team + fresh IAM VIEW, read-only
 * - Agent/other roles: no generic/directory access (Agent work lives in the work routes in C5)
 * - IAM: ALLOW when the projection is IN and membershipRevision matches an owner head that is IN; mismatched/missing/
 *   INVALIDATED = DEFER (not ALLOW); no row on either side = not a member
 * - GET creates no identity head or any evidence; a missing head (legacy) can be read for compatibility but not edited
 */

export type C360ActorRole = 'ADMIN' | 'SUPERVISOR' | 'AGENT';

/** An actor for whom the API has verified gateway identity + active User + proof binding */
export interface C360VerifiedActor {
  tenantId: string;
  userId: string;
  role: C360ActorRole;
  teamId: string | null;
}

export type C360IdentityView = 'ACTIVE' | 'MERGED' | 'AMBIGUOUS' | 'LEGACY_MISSING_HEAD';

export type C360ContactAccess =
  | {
      decision: 'ALLOW';
      read: true;
      manage: boolean;
      basis: 'CUSTODIAN_MANAGE' | 'CUSTODIAN_READ' | 'TEAM_VIEW' | 'SERVICE_READ';
      identity: C360IdentityView;
    }
  | { decision: 'DEFER'; reasonCode: 'SCOPE_CONTEXT_STALE' }
  | { decision: 'DENY' };

/** The current user in the transaction must match the actor the API verified (role/team/active changed = reject) */
function actorIsCurrent(actor: C360VerifiedActor): Prisma.Sql {
  return Prisma.sql`EXISTS (
    SELECT 1 FROM users u
    WHERE u.tenant_id = c.tenant_id AND u.id = ${actor.userId}::uuid AND u.is_active
      AND u.role::text = ${actor.role}
      AND u.team_id IS NOT DISTINCT FROM ${actor.teamId}::uuid
  )`;
}

function custodian(
  actor: C360VerifiedActor,
  permissions: readonly ('READ' | 'MANAGE')[],
): Prisma.Sql {
  if (actor.role !== 'ADMIN') return Prisma.sql`false`;
  return Prisma.sql`EXISTS (
    SELECT 1 FROM c360_contact_custodian_grants g
    WHERE g.tenant_id = c.tenant_id AND g.contact_id = c.id
      AND g.grantee_user_id = ${actor.userId}::uuid
      AND g.permission IN (${Prisma.join(permissions)})
      AND NOT EXISTS (
        SELECT 1 FROM c360_contact_custodian_revocations r
        WHERE r.tenant_id = g.tenant_id AND r.grant_id = g.id
      )
  )`;
}

/**
 * Segment rows the team has VIEW on, with the projection (IAM) and owner head (C360) for this contact
 * `fresh` = the IAM side has caught up with the owner; `member` = both sides say IN
 */
function teamViewRows(actor: C360VerifiedActor, condition: Prisma.Sql): Prisma.Sql {
  if ((actor.role !== 'ADMIN' && actor.role !== 'SUPERVISOR') || !actor.teamId)
    return Prisma.sql`false`;
  return Prisma.sql`EXISTS (
    SELECT 1
    FROM iam_team_segment_scope_active_grants ag
    JOIN teams t ON t.tenant_id = ag.tenant_id AND t.id = ag.team_id AND t.is_active
    LEFT JOIN iam_contact_segment_scope_projection p
      ON p.tenant_id = ag.tenant_id AND p.segment_id = ag.segment_id AND p.contact_id = c.id
    LEFT JOIN c360_segment_membership_heads h
      ON h.tenant_id = ag.tenant_id AND h.segment_id = ag.segment_id AND h.contact_id = c.id
    WHERE ag.tenant_id = c.tenant_id AND ag.team_id = ${actor.teamId}::uuid
      AND ag.permission = 'VIEW'
      AND (${condition})
  )`;
}

const FRESH_MEMBER = Prisma.sql`p.state = 'IN' AND h.state = 'IN' AND p.membership_revision = h.membership_revision`;
/** IAM has not caught up with the owner or was invalidated: cannot decide → DEFER */
const STALE = Prisma.sql`(p.state = 'INVALIDATED' OR h.state = 'INVALIDATED'
  OR p.membership_revision IS DISTINCT FROM h.membership_revision)`;

/** Fragment for `FROM contacts c WHERE ...` of list/count/detail: readable as ALLOW */
export function c360ReadableContactSql(actor: C360VerifiedActor): Prisma.Sql {
  if (actor.role === 'AGENT') return Prisma.sql`false`;
  return Prisma.sql`(c.tenant_id = ${actor.tenantId}::uuid AND ${actorIsCurrent(actor)} AND (
    ${custodian(actor, ['READ', 'MANAGE'])} OR ${teamViewRows(actor, FRESH_MEMBER)}
  ))`;
}

/**
 * Fragment for items that cannot be decided yet (DEFER) and are not in the ALLOW set
 * C2 uses it to report unavailable/incomplete instead of counting 0 — never return data of these rows
 */
export function c360DeferredContactSql(actor: C360VerifiedActor): Prisma.Sql {
  if (actor.role === 'AGENT') return Prisma.sql`false`;
  return Prisma.sql`(c.tenant_id = ${actor.tenantId}::uuid AND ${actorIsCurrent(actor)}
    AND NOT ${c360ReadableContactSql(actor)} AND ${teamViewRows(actor, STALE)})`;
}

/** Only an Admin with a MANAGE custodian can edit the profile; IAM VIEW does not grant edit rights */
export function c360ManageableContactSql(actor: C360VerifiedActor): Prisma.Sql {
  if (actor.role !== 'ADMIN') return Prisma.sql`false`;
  return Prisma.sql`(c.tenant_id = ${actor.tenantId}::uuid AND ${actorIsCurrent(actor)}
    AND ${custodian(actor, ['MANAGE'])})`;
}

/** Detail: composed from the same fragments as list/count; takes no lock and writes nothing */
export async function authorizeC360ContactAccess(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactId: string,
): Promise<C360ContactAccess> {
  const [row] = await tx.$queryRaw<
    {
      readable: boolean;
      deferred: boolean;
      manageable: boolean;
      custodian_read: boolean;
      identity: string | null;
    }[]
  >(Prisma.sql`
    SELECT ${c360ReadableContactSql(actor)} AS readable,
           ${c360DeferredContactSql(actor)} AS deferred,
           ${c360ManageableContactSql(actor)} AS manageable,
           (c.tenant_id = ${actor.tenantId}::uuid AND ${actorIsCurrent(actor)}
             AND ${custodian(actor, ['READ'])}) AS custodian_read,
           (SELECT ih.state::text FROM c360_identity_heads ih
             WHERE ih.tenant_id = c.tenant_id AND ih.contact_id = c.id) AS identity
    FROM contacts c
    WHERE c.tenant_id = ${actor.tenantId}::uuid AND c.id = ${contactId}::uuid`);
  if (!row) return { decision: 'DENY' };
  if (row.readable) {
    const identity = (row.identity ?? 'LEGACY_MISSING_HEAD') as C360IdentityView;
    // Editable only for contacts whose identity is ACTIVE; MERGED/AMBIGUOUS/legacy without a head are read-only
    const manage = row.manageable && identity === 'ACTIVE';
    return {
      decision: 'ALLOW',
      read: true,
      manage,
      basis: row.manageable
        ? 'CUSTODIAN_MANAGE'
        : row.custodian_read
          ? 'CUSTODIAN_READ'
          : 'TEAM_VIEW',
      identity,
    };
  }
  if (row.deferred) return { decision: 'DEFER', reasonCode: 'SCOPE_CONTEXT_STALE' };
  return { decision: 'DENY' };
}

/** R1 C: Admin create requires a CONTACT_CREATE capability that an operator granted and has not revoked */
export async function authorizeC360ContactCreate(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
): Promise<boolean> {
  if (actor.role !== 'ADMIN') return false;
  const [row] = await tx.$queryRaw<{ allowed: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM users u
      JOIN c360_actor_capability_grants g
        ON g.tenant_id = u.tenant_id AND g.grantee_user_id = u.id AND g.capability = 'CONTACT_CREATE'
      WHERE u.tenant_id = ${actor.tenantId}::uuid AND u.id = ${actor.userId}::uuid
        AND u.is_active AND u.role::text = 'ADMIN'
        AND u.team_id IS NOT DISTINCT FROM ${actor.teamId}::uuid
        AND NOT EXISTS (
          SELECT 1 FROM c360_actor_capability_revocations r
          WHERE r.tenant_id = g.tenant_id AND r.grant_id = g.id
        )
    ) AS allowed`);
  return row?.allowed === true;
}
