import { Prisma } from '@d-contact/db';
import { stableDigest } from './cg3-persistence.js';

/**
 * CG4.8 (#191): version of the contact event stream
 *
 * CG3 and CG4 exceptions publish to the same aggregate `contact_governance_contact/contactId`,
 * and #179 §1/§4 requires this stream to have a single monotonic version from `cg_contact_state_heads`.
 * If exceptions used their own counter, version 1 of CG3 and of CG4 would collide at every consumer
 * and become a hash conflict or a gap that holds work indefinitely
 *
 * The optimistic concurrency of the exception command remains on `cg_exception_contact_head` as before
 * (migration 20260913122000): here only the stream version advances, and the CG3 digest chain is untouched.
 * The atomic upsert holds the head's row lock until the transaction ends, so it serializes with the CG3 writer that
 * does CAS on the same row without needing an extra advisory lock (no new lock ordering that could deadlock)
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
  if (version === undefined) throw new Error('failed to advance the contact stream version');
  return Number(version);
}
