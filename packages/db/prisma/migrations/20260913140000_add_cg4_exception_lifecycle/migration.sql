-- CG4.4 (#187): additive lifecycle + evaluator-trace columns only. No writer switch and
-- no backfill; existing rows keep their current meaning.

-- The #177 workflow state machine is PENDING -> APPROVED -> REVOKED, with REJECTED and
-- CANCELLED as terminal branches off PENDING. CG4.2 shipped the enum without the two
-- branch states. Adding values only — nothing in this migration uses them, which is what
-- lets ALTER TYPE ... ADD VALUE run inside the migration transaction on PostgreSQL 12+.
ALTER TYPE "Cg4ExceptionStatus" ADD VALUE IF NOT EXISTS 'REJECTED' AFTER 'APPROVED';
ALTER TYPE "Cg4ExceptionStatus" ADD VALUE IF NOT EXISTS 'CANCELLED' AFTER 'REJECTED';

-- Renewal is a new series referencing the one it renews (#177 §4). It points at the head
-- rather than a revision: what is renewed is the series, not one of its content revisions.
ALTER TABLE "cg_exception" ADD COLUMN "renews_exception_id" UUID;
ALTER TABLE "cg_exception" ADD CONSTRAINT "cg_exception_tenant_renews_fkey"
  FOREIGN KEY ("tenant_id", "renews_exception_id") REFERENCES "cg_exception_head"("tenant_id", "exception_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception" ADD CONSTRAINT "cg_exception_renews_not_self_check"
  CHECK ("renews_exception_id" IS NULL OR "renews_exception_id" <> "exception_id");
CREATE INDEX "cg_exception_tenant_renews_idx" ON "cg_exception"("tenant_id", "renews_exception_id");

-- Cg4DecisionTracePinsV1 for the authorization outcome: which exception revision (and the
-- policy version/digests it was pinned to) actually lifted a provisional failure. Nullable
-- because the overwhelming majority of decisions apply no exception at all.
ALTER TABLE "cg_decision_logs" ADD COLUMN "cg4" JSONB;
