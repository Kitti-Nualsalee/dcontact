import { Prisma } from '@d-contact/db';

/**
 * Cus360 C1 (#791) S3: authorization predicates ตาม R1 C และ E1 G (IAM freshness barrier)
 *
 * แหล่งความจริงเดียวคือ SQL fragments ด้านล่าง: detail, list และ count ประกอบจาก fragment เดียวกัน
 * จึงไม่มีทางที่ list นับรายการที่ detail ปฏิเสธ (หรือกลับกัน)
 *
 * - Admin: explicit custodian grant (ที่ยังไม่ถูกถอน) — MANAGE แก้ได้, READ อ่านได้; หรือ IAM VIEW
 *   ของทีมตัวเองแบบ fresh สำหรับการอ่านเท่านั้น. role ADMIN อย่างเดียวไม่ให้สิทธิ์ทั้ง tenant
 * - Supervisor: ทีมที่ active + IAM VIEW แบบ fresh, อ่านอย่างเดียว
 * - Agent/บทบาทอื่น: ไม่มี generic/directory access (งานของ Agent อยู่ที่ work routes ใน C5)
 * - IAM: ALLOW เมื่อ projection IN และ membershipRevision ตรงกับ owner head ที่ IN; ไม่ตรง/ขาด/
 *   INVALIDATED = DEFER (ไม่ใช่ ALLOW); ไม่มีแถวทั้งสองฝั่ง = ไม่ใช่สมาชิก
 * - GET ไม่สร้าง identity head หรือหลักฐานใด ๆ; head ที่ขาด (legacy) อ่านแบบ compatibility ได้แต่แก้ไม่ได้
 */

export type C360ActorRole = 'ADMIN' | 'SUPERVISOR' | 'AGENT';

/** Actor ที่ API ตรวจ verified gateway identity + active User + proof binding แล้ว */
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
      basis: 'CUSTODIAN_MANAGE' | 'CUSTODIAN_READ' | 'TEAM_VIEW';
      identity: C360IdentityView;
    }
  | { decision: 'DEFER'; reasonCode: 'SCOPE_CONTEXT_STALE' }
  | { decision: 'DENY' };

/** ผู้ใช้ปัจจุบันใน transaction ต้องตรงกับ actor ที่ API ตรวจไว้ (role/team/active เปลี่ยนแล้ว = ปฏิเสธ) */
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
 * แถว segment ที่ทีมได้ VIEW พร้อม projection (IAM) และ owner head (C360) ของ contact นี้
 * `fresh` = ฝั่ง IAM ยังตามทัน owner; `member` = ทั้งสองฝั่งบอกว่า IN
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
/** IAM ยังไม่ทัน owner หรือถูก invalidate: ตัดสินไม่ได้ → DEFER */
const STALE = Prisma.sql`(p.state = 'INVALIDATED' OR h.state = 'INVALIDATED'
  OR p.membership_revision IS DISTINCT FROM h.membership_revision)`;

/** Fragment สำหรับ `FROM contacts c WHERE ...` ของ list/count/detail: อ่านได้แบบ ALLOW */
export function c360ReadableContactSql(actor: C360VerifiedActor): Prisma.Sql {
  if (actor.role === 'AGENT') return Prisma.sql`false`;
  return Prisma.sql`(c.tenant_id = ${actor.tenantId}::uuid AND ${actorIsCurrent(actor)} AND (
    ${custodian(actor, ['READ', 'MANAGE'])} OR ${teamViewRows(actor, FRESH_MEMBER)}
  ))`;
}

/**
 * Fragment ของรายการที่ยังตัดสินไม่ได้ (DEFER) และไม่อยู่ในชุด ALLOW
 * C2 ใช้เพื่อแจ้ง unavailable/incomplete แทนการนับเป็น 0 — ห้ามคืนข้อมูลของแถวเหล่านี้
 */
export function c360DeferredContactSql(actor: C360VerifiedActor): Prisma.Sql {
  if (actor.role === 'AGENT') return Prisma.sql`false`;
  return Prisma.sql`(c.tenant_id = ${actor.tenantId}::uuid AND ${actorIsCurrent(actor)}
    AND NOT ${c360ReadableContactSql(actor)} AND ${teamViewRows(actor, STALE)})`;
}

/** แก้โปรไฟล์ได้เฉพาะ Admin ที่มี MANAGE custodian; IAM VIEW ไม่ให้สิทธิ์แก้ */
export function c360ManageableContactSql(actor: C360VerifiedActor): Prisma.Sql {
  if (actor.role !== 'ADMIN') return Prisma.sql`false`;
  return Prisma.sql`(c.tenant_id = ${actor.tenantId}::uuid AND ${actorIsCurrent(actor)}
    AND ${custodian(actor, ['MANAGE'])})`;
}

/** Detail: ประกอบจาก fragment เดียวกับ list/count; ไม่ล็อกและไม่เขียนอะไร */
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
    // แก้ได้เฉพาะ contact ที่ identity ACTIVE; MERGED/AMBIGUOUS/legacy ที่ยังไม่มี head อ่านอย่างเดียว
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

/** R1 C: Admin create ต้องมี CONTACT_CREATE capability ที่ operator ให้และยังไม่ถูกถอน */
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
