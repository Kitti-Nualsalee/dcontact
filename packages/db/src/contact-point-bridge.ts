import { Prisma } from '@prisma/client';

/**
 * Cus360 C3 (#793) S4: compatibility bridge ของ consumer เดิมที่ lookup ContactIdentity จากค่า (E1 E)
 *
 * raw unique match ของ ContactIdentity ไม่ใช่ verified identity อีกต่อไป: identity จะใช้ lookup ได้
 * เมื่อมี contact point ที่ import จาก identity นั้น (source_kind = LEGACY_IDENTITY) และยัง ACTIVE
 * - ไม่มี mapping = ยังตัดสินไม่ได้ (UNMAPPED); REVIEW_REQUIRED / RETIRED = ไม่พบ; ไม่ fallback ไป raw value
 * - แถวที่ถูกแทนที่ตั้งแต่ import (ค่าซ้ำบน contact เดียว) ตัดสินตาม ACTIVE ค่าเดียวกันบน contact เดียวกัน
 * - normalized key เดียวกัน ACTIVE อยู่บน contact อื่นด้วย = กำกวม (shared ไม่ถูกตีความเป็นคนเดียวกัน)
 *
 * ใช้ภายใน tenant transaction (RLS) เท่านั้น; ไม่แก้ ContactIdentity หรือหลักฐาน CG
 */
/** UNMAPPED = identity ยังไม่ถูก import (ยังตัดสินไม่ได้); INELIGIBLE = import แล้วแต่ REVIEW_REQUIRED/RETIRED */
export type LegacyIdentityEligibility = 'ELIGIBLE' | 'SHARED' | 'UNMAPPED' | 'INELIGIBLE';

/**
 * แถวที่ import ซ้ำค่ากับ ACTIVE บน contact เดียวกันถูกเก็บเป็น RETIRED โดย command เดียวกับที่สร้าง
 * (ถูกแทนที่ตั้งแต่ import) แถวนี้ใช้ได้เมื่อ ACTIVE ค่าเดียวกันบน contact เดียวกันยังอยู่ (ชี้ไปตัวเดียวกัน)
 * point ที่ถูก retire ภายหลังโดยคำสั่งอื่นไม่เข้าเงื่อนไขนี้
 */
const SUPERSEDED_AT_IMPORT = Prisma.sql`p.state = 'RETIRED' AND p.normalized_value IS NOT NULL
  AND p.retired_command_id = p.created_command_id
  AND p.retired_actor_identity_key = p.created_actor_identity_key`;

export async function legacyIdentityEligibility(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  identityId: string,
): Promise<LegacyIdentityEligibility> {
  const [row] = await transaction.$queryRaw<{ usable: boolean; shared: boolean }[]>`
    SELECT (p.state = 'ACTIVE' OR (${SUPERSEDED_AT_IMPORT} AND EXISTS (
             SELECT 1 FROM c360_contact_points a
             WHERE a.tenant_id = p.tenant_id AND a.contact_id = p.contact_id AND a.state = 'ACTIVE'
               AND a.kind = p.kind AND a.normalization_version = p.normalization_version
               AND a.normalized_value = p.normalized_value))) AS usable,
           EXISTS (
             SELECT 1 FROM c360_contact_points o
             WHERE o.tenant_id = p.tenant_id AND o.state = 'ACTIVE' AND o.kind = p.kind
               AND o.normalization_version = p.normalization_version
               AND o.normalized_value = p.normalized_value AND o.contact_id <> p.contact_id
           ) AS shared
    FROM c360_contact_points p
    WHERE p.tenant_id = ${tenantId}::uuid AND p.source_kind = 'LEGACY_IDENTITY'
      AND p.source_identity_id = ${identityId}::uuid`;
  if (!row) return 'UNMAPPED';
  if (!row.usable) return 'INELIGIBLE';
  return row.shared ? 'SHARED' : 'ELIGIBLE';
}

/**
 * หา identity เดิมจาก normalized key: ต้องเป็นของ contact เดียว และ contact นั้นต้องมี ACTIVE point
 * ที่มาจาก legacy identity ค่านี้ (point ที่สร้างใหม่ไม่มี identity evidence จึงไม่สร้างเพื่อให้ dispatch ผ่าน)
 */
export async function eligibleLegacyIdentityByKey(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  input: { kind: 'PHONE' | 'EMAIL'; normalizationVersion: string; normalizedValue: string },
): Promise<
  | { status: 'RESOLVED'; contactId: string; identityId: string }
  | { status: 'AMBIGUOUS' }
  | { status: 'NOT_FOUND' }
> {
  const rows = await transaction.$queryRaw<{ contact_id: string; identity_id: string | null }[]>`
    SELECT p.contact_id::text AS contact_id, p.source_identity_id::text AS identity_id
    FROM c360_contact_points p
    WHERE p.tenant_id = ${tenantId}::uuid AND p.state = 'ACTIVE' AND p.kind = ${input.kind}
      AND p.normalization_version = ${input.normalizationVersion}
      AND p.normalized_value = ${input.normalizedValue}
    ORDER BY p.contact_id, p.source_identity_id NULLS LAST`;
  const contacts = new Set(rows.map((row) => row.contact_id));
  if (contacts.size > 1) return { status: 'AMBIGUOUS' };
  const legacy = rows.find((row) => row.identity_id !== null);
  if (legacy)
    return { status: 'RESOLVED', contactId: legacy.contact_id, identityId: legacy.identity_id! };
  const [contactId] = contacts;
  if (!contactId) return { status: 'NOT_FOUND' };
  // ACTIVE ของค่านี้ไม่ได้มาจาก legacy (เช่น สร้างผ่าน profile command) แต่มี legacy identity ค่าเดียวกัน
  // บน contact เดียวกันที่ถูกแทนที่ตั้งแต่ import: ใช้ identity นั้นเป็นหลักฐาน (ชี้ไป ACTIVE ตัวเดียวกัน)
  const [superseded] = await transaction.$queryRaw<{ identity_id: string }[]>`
    SELECT p.source_identity_id::text AS identity_id FROM c360_contact_points p
    WHERE p.tenant_id = ${tenantId}::uuid AND p.contact_id = ${contactId}::uuid
      AND p.source_kind = 'LEGACY_IDENTITY' AND p.kind = ${input.kind}
      AND p.normalization_version = ${input.normalizationVersion}
      AND p.normalized_value = ${input.normalizedValue} AND ${SUPERSEDED_AT_IMPORT}
    ORDER BY p.source_identity_id LIMIT 1`;
  return superseded
    ? { status: 'RESOLVED', contactId, identityId: superseded.identity_id }
    : { status: 'NOT_FOUND' };
}
