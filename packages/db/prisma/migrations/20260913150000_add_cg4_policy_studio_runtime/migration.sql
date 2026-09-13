-- CG4.5 (#188): policy studio runtime — immutable versions, deterministic test artifacts,
-- approval binding, atomic/scheduled publish, rollback-as-new-version and scoped kill.
--
-- Additive only: CG4.2 created these tables with no writer, so every new column is either
-- nullable or backfilled from a default that is then dropped.

CREATE TYPE "Cg4PolicyDiffClass" AS ENUM ('TIGHTENING', 'NEUTRAL', 'RELAXATION');
CREATE TYPE "Cg4PolicyTestOutcome" AS ENUM ('PASS', 'FAIL');

-- ── cg_policy ────────────────────────────────────────────────────────────────
ALTER TABLE "cg_policy"
  ADD COLUMN "schema_version"       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "evaluator_version"    TEXT NOT NULL DEFAULT 'CG4_EVALUATOR_V1',
  ADD COLUMN "draft_revision"       INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "diff_class"           "Cg4PolicyDiffClass",
  ADD COLUMN "test_artifact_digest" CHAR(64),
  ADD COLUMN "approval_digest"      CHAR(64),
  ADD COLUMN "base_head_version"    INTEGER,
  ADD COLUMN "base_head_digest"     CHAR(64),
  ADD COLUMN "activate_at"          TIMESTAMP(3),
  ADD COLUMN "rollback_of_id"       UUID;

-- Tenant-bound composite FK, same shape as the CG4.4 renewal reference.
ALTER TABLE "cg_policy"
  ADD CONSTRAINT "cg_policy_tenant_rollback_of_fkey"
  FOREIGN KEY ("tenant_id", "rollback_of_id") REFERENCES "cg_policy"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cg_policy"
  ADD CONSTRAINT "cg_policy_rollback_not_self_check"
  CHECK ("rollback_of_id" IS NULL OR "rollback_of_id" <> "id");

CREATE INDEX "cg_policy_tenant_id_rollback_of_id_idx" ON "cg_policy"("tenant_id", "rollback_of_id");

-- #176 §1: exactly one ACTIVE head per exact scope. Enforced by the database so a bug in
-- the publish path can never leave two winners for the evaluator to disambiguate.
CREATE UNIQUE INDEX "cg_policy_one_active_head_per_scope"
  ON "cg_policy"("tenant_id", "scope_key") WHERE "status" = 'ACTIVE';

-- #176 §4: at most one open scheduled candidate per scope; replacing one must cancel it first.
CREATE UNIQUE INDEX "cg_policy_one_scheduled_candidate_per_scope"
  ON "cg_policy"("tenant_id", "scope_key") WHERE "status" = 'SCHEDULED';

-- ── cg_policy_scope_head ─────────────────────────────────────────────────────
ALTER TABLE "cg_policy_scope_head"
  ADD COLUMN "head_version"       INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "head_digest"        CHAR(64) NOT NULL DEFAULT repeat('0', 64),
  ADD COLUMN "latest_mutation_id" UUID,
  ADD COLUMN "next_activation_at" TIMESTAMP(3);
ALTER TABLE "cg_policy_scope_head" ALTER COLUMN "head_digest" DROP DEFAULT;

-- ── cg_policy_test_artifact ──────────────────────────────────────────────────
-- The table has no writer yet (CG4.2 shipped it empty), so NOT NULL needs no backfill.
ALTER TABLE "cg_policy_test_artifact"
  ADD COLUMN "content_digest"          CHAR(64) NOT NULL,
  ADD COLUMN "platform_fixture_digest" CHAR(64) NOT NULL,
  ADD COLUMN "tenant_fixture_digest"   CHAR(64) NOT NULL,
  ADD COLUMN "base_head_version"       INTEGER NOT NULL,
  ADD COLUMN "base_head_digest"        CHAR(64) NOT NULL,
  ADD COLUMN "diff_class"              "Cg4PolicyDiffClass" NOT NULL,
  ADD COLUMN "outcome"                 "Cg4PolicyTestOutcome" NOT NULL,
  ADD COLUMN "passed"                  INTEGER NOT NULL,
  ADD COLUMN "failed"                  INTEGER NOT NULL;

-- A draft may be re-tested after each edit, so the artifact key widens to include the
-- content it was produced from. The old key is a prefix of the new one.
DROP INDEX IF EXISTS "cg_policy_test_artifact_tenant_policy_suite_key";
CREATE UNIQUE INDEX "cg_policy_test_artifact_tenant_policy_version_suite_content_key"
  ON "cg_policy_test_artifact"("tenant_id", "policy_id", "policy_version", "suite_version", "content_digest");
CREATE INDEX "cg_policy_test_artifact_tenant_policy_version_digest_idx"
  ON "cg_policy_test_artifact"("tenant_id", "policy_id", "policy_version", "artifact_digest");

-- ── Immutability trigger ─────────────────────────────────────────────────────
-- The CG4.2 version predates any writer and encoded a lifecycle #176 §1 does not have:
-- it forced APPROVED -> PUBLISHED, so neither an immediate publish (APPROVED -> ACTIVE in
-- one transaction) nor a scheduled one (APPROVED -> SCHEDULED -> ACTIVE) could commit. Only
-- those two edges out of APPROVED are added; every other transition stays as it was. It
-- also froze `effective_to`, which made it impossible to close the prior active interval
-- while superseding it — the exact step #176 §3 requires. Content stays immutable; the
-- two intervals that legitimately move at a transition are now the ones that may change.
CREATE OR REPLACE FUNCTION cg4_reject_immutable_policy_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'cg_policy superseded history is immutable';
  END IF;
  IF OLD.status IN ('APPROVED', 'PUBLISHED', 'SCHEDULED', 'ACTIVE') THEN
    IF NOT (
      (OLD.status = 'APPROVED' AND NEW.status IN ('PUBLISHED', 'SCHEDULED', 'ACTIVE'))
      OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('SCHEDULED', 'SUPERSEDED'))
      OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('ACTIVE', 'SUPERSEDED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED')
    ) THEN
      RAISE EXCEPTION 'cg_policy published/approved history only allows forward lifecycle transitions';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
       OR NEW.content IS DISTINCT FROM OLD.content
       OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
       OR NEW.registry_version IS DISTINCT FROM OLD.registry_version
       OR NEW.schema_version IS DISTINCT FROM OLD.schema_version
       OR NEW.evaluator_version IS DISTINCT FROM OLD.evaluator_version
       OR NEW.draft_revision IS DISTINCT FROM OLD.draft_revision
       OR NEW.diff_class IS DISTINCT FROM OLD.diff_class
       OR NEW.test_artifact_digest IS DISTINCT FROM OLD.test_artifact_digest
       OR NEW.approval_digest IS DISTINCT FROM OLD.approval_digest
       OR NEW.base_head_version IS DISTINCT FROM OLD.base_head_version
       OR NEW.base_head_digest IS DISTINCT FROM OLD.base_head_digest
       OR NEW.rollback_of_id IS DISTINCT FROM OLD.rollback_of_id
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.maker_actor_ref IS DISTINCT FROM OLD.maker_actor_ref
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'cg_policy published/approved history is immutable except lifecycle progression';
    END IF;
    -- The activation instant is settled while the candidate is still APPROVED; once it is
    -- SCHEDULED or ACTIVE the schedule is fixed and only a new version can change it.
    IF NEW.activate_at IS DISTINCT FROM OLD.activate_at AND OLD.status <> 'APPROVED' THEN
      RAISE EXCEPTION 'cg_policy activate_at is fixed once the candidate leaves APPROVED';
    END IF;
    -- Activating is when a version learns which one it replaced, so this is set once.
    IF NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
       AND NOT (OLD.supersedes_id IS NULL AND NEW.status = 'ACTIVE') THEN
      RAISE EXCEPTION 'cg_policy supersedes_id may only be set when the version activates';
    END IF;
    -- The active interval is closed exactly once, by the supersede that ends it.
    IF NEW.effective_to IS DISTINCT FROM OLD.effective_to
       AND NOT (OLD.effective_to IS NULL AND NEW.status = 'SUPERSEDED') THEN
      RAISE EXCEPTION 'cg_policy effective_to may only be closed by a supersede';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ── cg_policy_activation_job ─────────────────────────────────────────────────
-- #176 §4: one open activation job per scope. The scheduler is an availability mechanism,
-- so this constraint (not the worker) is what keeps duplicate activations impossible.
CREATE UNIQUE INDEX "cg_policy_activation_job_one_open_per_scope"
  ON "cg_policy_activation_job"("tenant_id", "scope_key")
  WHERE "state" IN ('PENDING', 'CLAIMED');

-- ── Grants ───────────────────────────────────────────────────────────────────
-- Mirrors prisma/rls.sql; the blanket GRANT there re-grants everything, so the narrowing
-- REVOKEs must exist in both places or a `db:rls` run silently widens them back.
REVOKE UPDATE, DELETE ON "cg_policy_test_artifact" FROM dcontact_app;
REVOKE DELETE ON "cg_policy" FROM dcontact_app;
REVOKE DELETE ON "cg_policy_scope_head" FROM dcontact_app;
REVOKE DELETE ON "cg_policy_activation_job" FROM dcontact_app;
REVOKE DELETE ON "cg_scope_kill_switch" FROM dcontact_app;
