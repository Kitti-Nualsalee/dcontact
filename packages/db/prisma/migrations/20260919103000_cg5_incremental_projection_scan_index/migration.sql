-- CG5.4 (#288): reader uses tenant + decided-at + id keyset pagination.
-- CONCURRENTLY keeps this additive index from blocking authorizeAndReserve writes.
CREATE INDEX CONCURRENTLY "cg_decision_logs_cg5_projection_scan_idx"
ON "cg_decision_logs" ("tenant_id", "decided_at", "id");
