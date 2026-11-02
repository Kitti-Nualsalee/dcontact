import { Prisma, lockTeamReferences } from '@d-contact/db';
import {
  authorizeC360ContactAccess,
  type C360ContactAccess,
  type C360VerifiedActor,
} from './profile-authorization.js';
import { C360ProfileCommandError } from './profile-command.js';

/**
 * Cus360 C1 (#791) S4: transaction-aware owner fences ตาม E1 G
 *
 * Key ทุกตัวเป็นของ owner เดิมและ owner writer ถือ key เดียวกันจริง ไม่ใช่ namespace ฝ่ายเดียว:
 * - identity: canonical writer ถือ exclusive, membership commit และ Cus360 ถือ shared
 * - IAM scope-version: grant/revoke UPDATE row, Cus360 ถือ FOR SHARE
 * - IAM contact projection: projection consumer ถือ exclusive, Cus360 ถือ shared
 *
 * ฝั่ง Cus360 ใช้ try/NOWAIT ทั้งหมด จึงไม่เพิ่มการรอย้อนเข้า owner หรือ Voice; ล็อกไม่ได้ =
 * RESOURCE_BUSY ให้ engine rollback แล้ว retry ทั้ง transaction ไม่ทำต่อใน aborted transaction
 */

function sortedUnique(ids: readonly string[]): string[] {
  return [...new Set(ids)].sort();
}

/** Key เดิมของ canonical writer (`segment-membership-repository.ts`) ห้ามเปลี่ยนรูปแบบ */
export function c360IdentityFenceKey(tenantId: string, contactId: string): string {
  return `c360-membership:${tenantId}:identity:${contactId}`;
}

/** Key ของ IAM projection consumer ต่อ contact (E1 G: `iam-contact-scope:<tenant>:<contact>`) */
export function iamContactScopeFenceKey(tenantId: string, contactId: string): string {
  return `iam-contact-scope:${tenantId}:${contactId}`;
}

function busy(): C360ProfileCommandError {
  return new C360ProfileCommandError('RESOURCE_BUSY', 503, true);
}

/** Shared identity fence แบบ try สำหรับ Cus360 command; กัน canonical transition ระหว่าง command */
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

/** Shared projection fence แบบ try; กัน consumer เปลี่ยน projection ระหว่างตัดสิน freshness */
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

/** FOR SHARE NOWAIT บน scope-version ของทีม ขัดกับ UPDATE ของ IAM grant/revoke */
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
 * ล็อกตามลำดับ E1 G สำหรับ Cus360 mutation แล้วตัดสินสิทธิ์จาก state หลังล็อก:
 * Team reference → IAM scope-version → User → identity ของ contact ทั้งชุด → IAM projection
 *
 * เรียกหลัง command fence (S2) และก่อน capability/profile/tag/point rows. ผลตัดสินเป็นของ
 * transaction นี้เท่านั้น pre-read ภายนอกใช้รวบรวม IDs อย่างเดียว
 */
export async function fenceC360ContactMutation(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactIds: readonly string[],
): Promise<Map<string, C360ContactAccess>> {
  const contacts = sortedUnique(contactIds);
  // IAM เกี่ยวเฉพาะ actor ที่มีทีม (Admin read ผ่าน VIEW หรือ Supervisor); custodian ไม่พึ่งทีม
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

  const access = new Map<string, C360ContactAccess>();
  for (const contactId of contacts) {
    access.set(contactId, await authorizeC360ContactAccess(tx, actor, contactId));
  }
  return access;
}
