-- CG4.2 (#185): additive canonical foundation only.
-- ไม่มี writer switch, ไม่มี data backfill และไม่มี historic event ใน migration นี้.

CREATE TYPE "Cg4PolicyStatus" AS ENUM (
  'DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'PUBLISHED', 'SCHEDULED',
  'ACTIVE', 'SUPERSEDED', 'REJECTED', 'WITHDRAWN'
);
CREATE TYPE "Cg4ApprovalDecision" AS ENUM ('APPROVED', 'REJECTED');
CREATE TYPE "Cg4ActivationJobState" AS ENUM ('PENDING', 'CLAIMED', 'COMPLETE', 'FAILED', 'CANCELLED');
CREATE TYPE "Cg4ExceptionScopeKind" AS ENUM ('IDENTITY', 'CONTACT_WIDE');
CREATE TYPE "Cg4ExceptionStatus" AS ENUM ('PENDING', 'APPROVED', 'REVOKED', 'EXPIRED', 'SUPERSEDED');
CREATE TYPE "Cg4ExceptionTier" AS ENUM ('STANDARD', 'HIGH', 'EMERGENCY');
CREATE TYPE "Cg4KillSwitchState" AS ENUM ('ACTIVE', 'CLEARED');

CREATE TABLE "cg_policy" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "policy_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "scope_key" TEXT NOT NULL,
  "content" JSONB NOT NULL,
  "content_digest" CHAR(64) NOT NULL,
  "registry_version" TEXT NOT NULL,
  "status" "Cg4PolicyStatus" NOT NULL DEFAULT 'DRAFT',
  "effective_from" TIMESTAMP(3) NOT NULL,
  "effective_to" TIMESTAMP(3),
  "maker_actor_ref" TEXT NOT NULL,
  "submitted_at" TIMESTAMP(3),
  "approved_at" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "supersedes_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg_policy_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_policy_version_check" CHECK ("version" > 0),
  CONSTRAINT "cg_policy_effective_period_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
  CONSTRAINT "cg_policy_digest_check" CHECK ("content_digest" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "cg_policy_tenant_id_id_key" ON "cg_policy"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_policy_tenant_policy_version_key" ON "cg_policy"("tenant_id", "policy_id", "version");
CREATE INDEX "cg_policy_tenant_scope_status_idx" ON "cg_policy"("tenant_id", "scope_key", "status");

CREATE TABLE "cg_policy_scope_head" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "scope_key" TEXT NOT NULL,
  "head_policy_id" UUID NOT NULL,
  "head_policy_version" INTEGER NOT NULL,
  "head_policy_revision_id" UUID NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cg_policy_scope_head_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cg_policy_scope_head_tenant_id_id_key" ON "cg_policy_scope_head"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_policy_scope_head_tenant_scope_key" ON "cg_policy_scope_head"("tenant_id", "scope_key");
CREATE INDEX "cg_policy_scope_head_tenant_policy_version_idx" ON "cg_policy_scope_head"("tenant_id", "head_policy_id", "head_policy_version");

CREATE TABLE "cg_policy_test_artifact" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "policy_id" UUID NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "suite_version" TEXT NOT NULL,
  "artifact_digest" CHAR(64) NOT NULL,
  "result" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg_policy_test_artifact_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_policy_test_artifact_digest_check" CHECK ("artifact_digest" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "cg_policy_test_artifact_tenant_id_id_key" ON "cg_policy_test_artifact"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_policy_test_artifact_tenant_policy_suite_key" ON "cg_policy_test_artifact"("tenant_id", "policy_id", "policy_version", "suite_version");

CREATE TABLE "cg_policy_approval" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "policy_id" UUID NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "decision" "Cg4ApprovalDecision" NOT NULL,
  "approver_ref" TEXT NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg_policy_approval_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cg_policy_approval_tenant_id_id_key" ON "cg_policy_approval"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_policy_approval_tenant_policy_approver_key" ON "cg_policy_approval"("tenant_id", "policy_id", "policy_version", "approver_ref");
CREATE INDEX "cg_policy_approval_tenant_policy_decided_idx" ON "cg_policy_approval"("tenant_id", "policy_id", "policy_version", "decided_at");

CREATE TABLE "cg_policy_activation_job" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "policy_id" UUID NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "scope_key" TEXT NOT NULL,
  "scheduled_for" TIMESTAMP(3) NOT NULL,
  "state" "Cg4ActivationJobState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg_policy_activation_job_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_policy_activation_job_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "cg_policy_activation_job_tenant_id_id_key" ON "cg_policy_activation_job"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_policy_activation_job_tenant_policy_version_key" ON "cg_policy_activation_job"("tenant_id", "policy_id", "policy_version");
CREATE INDEX "cg_policy_activation_job_tenant_state_scheduled_idx" ON "cg_policy_activation_job"("tenant_id", "state", "scheduled_for");

CREATE TABLE "cg_exception" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "exception_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "contact_id" UUID NOT NULL,
  "identity_id" UUID,
  "scope_kind" "Cg4ExceptionScopeKind" NOT NULL,
  "channel" "ChannelType" NOT NULL,
  "purpose" TEXT NOT NULL,
  "source_type" TEXT NOT NULL,
  "source_id" TEXT NOT NULL,
  "allowed_rule_codes" TEXT[] NOT NULL,
  "policy_id" UUID NOT NULL,
  "policy_version" INTEGER NOT NULL,
  "policy_content_digest" CHAR(64) NOT NULL,
  "registry_version" TEXT NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "tier" "Cg4ExceptionTier" NOT NULL,
  "status" "Cg4ExceptionStatus" NOT NULL DEFAULT 'PENDING',
  "reason_code" TEXT NOT NULL,
  "ticket_ref" TEXT,
  "evidence_ref" TEXT NOT NULL,
  "actor_ref" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "supersedes_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg_exception_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_exception_revision_check" CHECK ("revision" > 0),
  CONSTRAINT "cg_exception_period_check" CHECK ("expires_at" > "starts_at"),
  CONSTRAINT "cg_exception_rules_check" CHECK (cardinality("allowed_rule_codes") > 0 AND NOT ('' = ANY("allowed_rule_codes"))),
  CONSTRAINT "cg_exception_scope_identity_check" CHECK (
    ("scope_kind" = 'IDENTITY' AND "identity_id" IS NOT NULL)
    OR ("scope_kind" = 'CONTACT_WIDE' AND "identity_id" IS NULL)
  ),
  CONSTRAINT "cg_exception_digest_check" CHECK (
    "policy_content_digest" ~ '^[a-f0-9]{64}$' AND "request_hash" ~ '^[a-f0-9]{64}$'
  )
);
CREATE UNIQUE INDEX "cg_exception_tenant_id_id_key" ON "cg_exception"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_exception_tenant_series_revision_key" ON "cg_exception"("tenant_id", "exception_id", "revision");
CREATE INDEX "cg_exception_tenant_contact_status_expiry_idx" ON "cg_exception"("tenant_id", "contact_id", "status", "expires_at");
CREATE INDEX "cg_exception_tenant_policy_version_idx" ON "cg_exception"("tenant_id", "policy_id", "policy_version");

CREATE TABLE "cg_exception_head" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "exception_id" UUID NOT NULL,
  "current_revision_id" UUID NOT NULL,
  "current_revision" INTEGER NOT NULL,
  "status" "Cg4ExceptionStatus" NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cg_exception_head_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_exception_head_revision_check" CHECK ("current_revision" > 0)
);
CREATE UNIQUE INDEX "cg_exception_head_tenant_id_id_key" ON "cg_exception_head"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_exception_head_tenant_exception_key" ON "cg_exception_head"("tenant_id", "exception_id");

CREATE TABLE "cg_exception_approval" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "exception_id" UUID NOT NULL,
  "exception_revision" INTEGER NOT NULL,
  "decision" "Cg4ApprovalDecision" NOT NULL,
  "approver_ref" TEXT NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg_exception_approval_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cg_exception_approval_tenant_id_id_key" ON "cg_exception_approval"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_exception_approval_tenant_revision_approver_key" ON "cg_exception_approval"("tenant_id", "exception_id", "exception_revision", "approver_ref");
CREATE INDEX "cg_exception_approval_tenant_revision_decided_idx" ON "cg_exception_approval"("tenant_id", "exception_id", "exception_revision", "decided_at");

CREATE TABLE "cg_scope_kill_switch" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "scope_key" TEXT NOT NULL,
  "state" "Cg4KillSwitchState" NOT NULL DEFAULT 'ACTIVE',
  "reason_code" TEXT NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "activated_by_ref" TEXT NOT NULL,
  "activated_at" TIMESTAMP(3) NOT NULL,
  "clear_approval_ref" TEXT,
  "cleared_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg_scope_kill_switch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_scope_kill_switch_clear_check" CHECK (
    ("state" = 'ACTIVE' AND "clear_approval_ref" IS NULL AND "cleared_at" IS NULL)
    OR ("state" = 'CLEARED' AND "clear_approval_ref" IS NOT NULL AND "cleared_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "cg_scope_kill_switch_tenant_id_id_key" ON "cg_scope_kill_switch"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_scope_kill_switch_one_active_scope_key" ON "cg_scope_kill_switch"("tenant_id", "scope_key") WHERE "state" = 'ACTIVE';
CREATE INDEX "cg_scope_kill_switch_tenant_scope_state_idx" ON "cg_scope_kill_switch"("tenant_id", "scope_key", "state");

-- Mapping ledger เป็น scaffold ที่ deterministic สำหรับ backfill ticket ถัดไปเท่านั้น.
CREATE TABLE "cg4_backfill_ledger" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "source_table" TEXT NOT NULL,
  "source_key" TEXT NOT NULL,
  "target_kind" TEXT NOT NULL,
  "target_id" UUID NOT NULL,
  "source_digest" CHAR(64) NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg4_backfill_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg4_backfill_ledger_digest_check" CHECK ("source_digest" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "cg4_backfill_ledger_tenant_id_id_key" ON "cg4_backfill_ledger"("tenant_id", "id");
CREATE UNIQUE INDEX "cg4_backfill_ledger_tenant_source_key" ON "cg4_backfill_ledger"("tenant_id", "source_table", "source_key");

ALTER TABLE "cg_policy" ADD CONSTRAINT "cg_policy_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy" ADD CONSTRAINT "cg_policy_tenant_supersedes_fkey"
  FOREIGN KEY ("tenant_id", "supersedes_id") REFERENCES "cg_policy"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_scope_head" ADD CONSTRAINT "cg_policy_scope_head_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_scope_head" ADD CONSTRAINT "cg_policy_scope_head_tenant_policy_version_fkey"
  FOREIGN KEY ("tenant_id", "head_policy_id", "head_policy_version") REFERENCES "cg_policy"("tenant_id", "policy_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_scope_head" ADD CONSTRAINT "cg_policy_scope_head_tenant_revision_fkey"
  FOREIGN KEY ("tenant_id", "head_policy_revision_id") REFERENCES "cg_policy"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_test_artifact" ADD CONSTRAINT "cg_policy_test_artifact_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_test_artifact" ADD CONSTRAINT "cg_policy_test_artifact_tenant_policy_fkey"
  FOREIGN KEY ("tenant_id", "policy_id", "policy_version") REFERENCES "cg_policy"("tenant_id", "policy_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_approval" ADD CONSTRAINT "cg_policy_approval_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_approval" ADD CONSTRAINT "cg_policy_approval_tenant_policy_fkey"
  FOREIGN KEY ("tenant_id", "policy_id", "policy_version") REFERENCES "cg_policy"("tenant_id", "policy_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_activation_job" ADD CONSTRAINT "cg_policy_activation_job_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_activation_job" ADD CONSTRAINT "cg_policy_activation_job_tenant_policy_fkey"
  FOREIGN KEY ("tenant_id", "policy_id", "policy_version") REFERENCES "cg_policy"("tenant_id", "policy_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception" ADD CONSTRAINT "cg_exception_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception" ADD CONSTRAINT "cg_exception_tenant_contact_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception" ADD CONSTRAINT "cg_exception_tenant_identity_fkey"
  FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "contact_identities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception" ADD CONSTRAINT "cg_exception_tenant_policy_fkey"
  FOREIGN KEY ("tenant_id", "policy_id", "policy_version") REFERENCES "cg_policy"("tenant_id", "policy_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception" ADD CONSTRAINT "cg_exception_tenant_supersedes_fkey"
  FOREIGN KEY ("tenant_id", "supersedes_id") REFERENCES "cg_exception"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception_head" ADD CONSTRAINT "cg_exception_head_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception_head" ADD CONSTRAINT "cg_exception_head_tenant_revision_fkey"
  FOREIGN KEY ("tenant_id", "current_revision_id") REFERENCES "cg_exception"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception_approval" ADD CONSTRAINT "cg_exception_approval_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception_approval" ADD CONSTRAINT "cg_exception_approval_tenant_revision_fkey"
  FOREIGN KEY ("tenant_id", "exception_id", "exception_revision") REFERENCES "cg_exception"("tenant_id", "exception_id", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_scope_kill_switch" ADD CONSTRAINT "cg_scope_kill_switch_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg4_backfill_ledger" ADD CONSTRAINT "cg4_backfill_ledger_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Published/approved policy ต้องไม่แก้โดย application role แม้ role จะต้อง update DRAFT
-- เพื่อเดิน workflow ช่วงต้น. Exception, approval, artifact และ ledger append-only เสมอ.
CREATE FUNCTION cg4_reject_immutable_policy_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status IN ('APPROVED', 'PUBLISHED', 'SCHEDULED', 'ACTIVE', 'SUPERSEDED') THEN
    RAISE EXCEPTION 'cg_policy published/approved history is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cg4_policy_immutable_after_approval
  BEFORE UPDATE ON "cg_policy"
  FOR EACH ROW EXECUTE FUNCTION cg4_reject_immutable_policy_update();

CREATE FUNCTION cg4_validate_kill_switch_clear() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'ACTIVE' OR NEW.state <> 'CLEARED'
     OR NEW.clear_approval_ref IS NULL OR NEW.cleared_at IS NULL
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref
     OR NEW.activated_by_ref IS DISTINCT FROM OLD.activated_by_ref
     OR NEW.activated_at IS DISTINCT FROM OLD.activated_at
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'cg_scope_kill_switch may only transition ACTIVE to CLEARED with approval';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER cg4_kill_switch_clear_requires_approval
  BEFORE UPDATE ON "cg_scope_kill_switch"
  FOR EACH ROW EXECUTE FUNCTION cg4_validate_kill_switch_clear();

ALTER TABLE "cg_policy" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_policy_scope_head" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_policy_test_artifact" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_policy_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_policy_activation_job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_exception" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_exception_head" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_exception_approval" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_scope_kill_switch" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg4_backfill_ledger" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "cg_policy" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_policy_scope_head" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_policy_test_artifact" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_policy_approval" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_policy_activation_job" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_exception" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_exception_head" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_exception_approval" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_scope_kill_switch" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg4_backfill_ledger" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "cg_policy", "cg_policy_scope_head", "cg_policy_activation_job", "cg_scope_kill_switch" TO dcontact_app;
GRANT SELECT, INSERT ON "cg_policy_test_artifact", "cg_policy_approval", "cg_exception", "cg_exception_approval" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "cg_exception_head" TO dcontact_app;
REVOKE DELETE ON "cg_policy", "cg_policy_scope_head", "cg_policy_activation_job", "cg_scope_kill_switch", "cg_exception_head" FROM dcontact_app;
REVOKE UPDATE, DELETE ON "cg_policy_test_artifact", "cg_policy_approval", "cg_exception", "cg_exception_approval", "cg4_backfill_ledger" FROM dcontact_app;
