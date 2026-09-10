-- Keep the full C1 canonical identity visible at the database boundary in
-- addition to tenant/outcome_ref dedupe, which rejects outcome reuse.
CREATE UNIQUE INDEX "cg_attempts_binding_key"
ON "cg_attempts"("tenant_id", "reservation_id", "delivery_id", "outcome_ref");

CREATE UNIQUE INDEX "cg_touches_binding_key"
ON "cg_touches"("tenant_id", "reservation_id", "delivery_id", "outcome_ref");
