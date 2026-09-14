import { Prisma } from '@d-contact/db';
import { stableDigest } from './cg3-persistence.js';

/**
 * CG4.8 (#191): version ของ contact event stream
 *
 * CG3 และ CG4 exception publish ลง aggregate `contact_governance_contact/contactId` เดียวกัน
 * และ #179 §1/§4 กำหนดให้ stream นี้มี monotonic version เดียวจาก `cg_contact_state_heads`
 * ถ้า exception ใช้ counter ของตัวเอง version 1 ของ CG3 กับของ CG4 จะชนกันที่ consumer ทุกตัว
 * และกลายเป็น hash conflict หรือ gap ที่ hold งานไว้ตลอด
 *
 * optimistic concurrency ของ exception command ยังอยู่ที่ `cg_exception_contact_head` ตามเดิม
 * (migration 20260913122000) — ที่นี่ขยับเฉพาะ stream version และไม่แตะ digest chain ของ CG3
 * การ upsert แบบ atomic ถือ row lock ของ head จนจบ transaction จึงเรียงกับ CG3 writer ที่
 * CAS บน row เดียวกันได้โดยไม่ต้องใช้ advisory lock เพิ่ม (ไม่สร้างลำดับ lock ใหม่ให้ deadlock)
 */
const EMPTY_CONTACT_STATE_DIGEST = stableDigest({ preferences: [] });

export async function nextContactStreamVersion(
  transaction: Prisma.TransactionClient,
  input: { tenantId: string; contactId: string; mutationId: string },
): Promise<number> {
  const rows = await transaction.$queryRaw<Array<{ aggregate_version: number }>>(Prisma.sql`
    INSERT INTO "cg_contact_state_heads"
      ("tenant_id", "contact_id", "aggregate_version", "current_digest", "latest_mutation_id", "updated_at")
    VALUES
      (${input.tenantId}::uuid, ${input.contactId}::uuid, 1, ${EMPTY_CONTACT_STATE_DIGEST},
       ${input.mutationId}::uuid, now())
    ON CONFLICT ("tenant_id", "contact_id") DO UPDATE
      SET "aggregate_version" = "cg_contact_state_heads"."aggregate_version" + 1,
          "latest_mutation_id" = EXCLUDED."latest_mutation_id",
          "updated_at" = EXCLUDED."updated_at"
    RETURNING "aggregate_version"
  `);
  const version = rows[0]?.aggregate_version;
  if (version === undefined) throw new Error('ขยับ contact stream version ไม่สำเร็จ');
  return Number(version);
}
