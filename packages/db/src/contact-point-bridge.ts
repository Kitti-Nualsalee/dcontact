import { Prisma } from '@prisma/client';

/**
 * Cus360 C3 (#793) S4: compatibility bridge ของ consumer เดิมที่ lookup ContactIdentity จากค่า (E1 E)
 *
 * raw unique match ของ ContactIdentity ไม่ใช่ verified identity อีกต่อไป: identity จะใช้ lookup ได้
 * เมื่อมี contact point ที่ import จาก identity นั้น (source_kind = LEGACY_IDENTITY) และยัง ACTIVE
 * - ไม่มี mapping = ยังตัดสินไม่ได้ (UNMAPPED); REVIEW_REQUIRED / RETIRED = ไม่พบ; ไม่ fallback ไป raw value
 * - normalized key เดียวกัน ACTIVE อยู่บน contact อื่นด้วย = กำกวม (shared ไม่ถูกตีความเป็นคนเดียวกัน)
 *
 * ใช้ภายใน tenant transaction (RLS) เท่านั้น; ไม่แก้ ContactIdentity หรือหลักฐาน CG
 */
/** UNMAPPED = identity ยังไม่ถูก import (ยังตัดสินไม่ได้); INELIGIBLE = import แล้วแต่ REVIEW_REQUIRED/RETIRED */
export type LegacyIdentityEligibility = 'ELIGIBLE' | 'SHARED' | 'UNMAPPED' | 'INELIGIBLE';

export async function legacyIdentityEligibility(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  identityId: string,
): Promise<LegacyIdentityEligibility> {
  const [row] = await transaction.$queryRaw<{ state: string | null; shared: boolean }[]>`
    SELECT p.state,
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
  if (row.state !== 'ACTIVE') return 'INELIGIBLE';
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
  return legacy
    ? { status: 'RESOLVED', contactId: legacy.contact_id, identityId: legacy.identity_id! }
    : { status: 'NOT_FOUND' };
}
