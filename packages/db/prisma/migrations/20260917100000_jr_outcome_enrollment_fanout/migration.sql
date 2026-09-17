-- J2.7 (#135): an interaction outcome may match more than one published
-- INTERACTION_OUTCOME journey (PER_LOGICAL_OUTCOME per journey, #123), so the
-- enrollment trigger-source uniqueness moves from (tenant, receipt) to
-- (tenant, receipt, journey). Correction revisions re-evaluate the enrollment
-- bound to the first matching revision instead of creating a new one; that
-- lookup is serialized by the logical-stream advisory lock in the processor.
DROP INDEX "jr_enrollments_tenant_outcome_receipt_key";
CREATE UNIQUE INDEX "jr_enrollments_tenant_outcome_receipt_journey_key"
  ON "jr_enrollments"("tenant_id", "outcome_receipt_id", "journey_id");
