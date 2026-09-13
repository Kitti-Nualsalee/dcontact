-- J2.7: jr_outcome_receipts was, by design, only a hash-based dedup/ordering
-- ledger in J2.3 (no structured payload). Trigger matching and owner command
-- construction need the actual normalized fields (interactionId, contactId,
-- outcomeCode, timestamps) that produced the hash, so add a payload column
-- carrying the validated `InteractionOutcomePayloadV1` (internal IDs/codes
-- only, no raw PII per #120).
ALTER TABLE "jr_outcome_receipts" ADD COLUMN "payload" JSONB;
UPDATE "jr_outcome_receipts" SET "payload" = '{}'::jsonb WHERE "payload" IS NULL;
ALTER TABLE "jr_outcome_receipts" ALTER COLUMN "payload" SET NOT NULL;

-- J2.7: an INTERACTION_OUTCOME-triggered enrollment needs its own trigger-source
-- reference, mirroring the existing nullable event_inbox_id/occurrence_id
-- pattern (exactly one trigger source per enrollment).
ALTER TABLE "jr_enrollments" ADD COLUMN "outcome_receipt_id" UUID;
ALTER TABLE "jr_enrollments"
  ADD CONSTRAINT "jr_enrollments_outcome_receipt_id_fkey"
  FOREIGN KEY ("outcome_receipt_id") REFERENCES "jr_outcome_receipts"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "jr_enrollments_tenant_outcome_receipt_key"
  ON "jr_enrollments"("tenant_id", "outcome_receipt_id");
