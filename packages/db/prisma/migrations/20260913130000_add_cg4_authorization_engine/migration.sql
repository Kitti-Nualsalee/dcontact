-- CG4.3 (#186): additive maker-checker authorization primitives only. No writer for
-- these tables exists yet outside this migration's own repositories/tests.

CREATE TYPE "Cg4CapabilitySource" AS ENUM ('DIRECT', 'DELEGATED');

-- Approval snapshot columns: the capability actually used, whether it was direct or
-- delegated, whether the checker held direct-Compliance/emergency authority, and the
-- IAM epoch/scope version at evaluation. Table is empty on every environment so far
-- (CG4.2 never wrote to it), so these can be added NOT NULL without a default.
ALTER TABLE "cg_policy_approval"
  ADD COLUMN "capability" TEXT NOT NULL,
  ADD COLUMN "capability_source" "Cg4CapabilitySource" NOT NULL,
  ADD COLUMN "delegation_id" UUID,
  ADD COLUMN "direct_compliance" BOOLEAN NOT NULL,
  ADD COLUMN "emergency_authority" BOOLEAN NOT NULL,
  ADD COLUMN "authorization_epoch" INTEGER NOT NULL,
  ADD COLUMN "scope_version" INTEGER NOT NULL;
ALTER TABLE "cg_policy_approval" ADD CONSTRAINT "cg_policy_approval_capability_check"
  CHECK ("capability" IN ('cg.policy.publish', 'cg.policy.publish.relaxation'));

ALTER TABLE "cg_exception_approval"
  ADD COLUMN "capability" TEXT NOT NULL,
  ADD COLUMN "capability_source" "Cg4CapabilitySource" NOT NULL,
  ADD COLUMN "delegation_id" UUID,
  ADD COLUMN "direct_compliance" BOOLEAN NOT NULL,
  ADD COLUMN "emergency_authority" BOOLEAN NOT NULL,
  ADD COLUMN "authorization_epoch" INTEGER NOT NULL,
  ADD COLUMN "scope_version" INTEGER NOT NULL;
ALTER TABLE "cg_exception_approval" ADD CONSTRAINT "cg_exception_approval_capability_check"
  CHECK ("capability" IN ('cg.exception.approve.standard', 'cg.exception.approve.high'));

-- Delegation is append-only: created once, only ever allowed to expire. Capability is
-- restricted at the DB layer to the delegable set so a stray write can never grant a
-- HIGH/EMERGENCY or policy-publish/rollback capability by delegation, and the ≤8h
-- window from #173 §3 is enforced here rather than trusted to application code alone.
CREATE TABLE "cg_delegation" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "delegator_subject_id" TEXT NOT NULL,
  "delegate_subject_id" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "scope_key" TEXT NOT NULL,
  "grant_version" INTEGER NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cg_delegation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_delegation_capability_check"
    CHECK ("capability" IN ('cg.exception.request', 'cg.exception.approve.standard')),
  CONSTRAINT "cg_delegation_not_self_check" CHECK ("delegator_subject_id" <> "delegate_subject_id"),
  CONSTRAINT "cg_delegation_window_check" CHECK (
    "expires_at" > "starts_at" AND "expires_at" <= "starts_at" + INTERVAL '8 hours'
  )
);
CREATE UNIQUE INDEX "cg_delegation_tenant_id_id_key" ON "cg_delegation"("tenant_id", "id");
CREATE INDEX "cg_delegation_tenant_delegate_capability_scope_idx"
  ON "cg_delegation"("tenant_id", "delegate_subject_id", "capability", "scope_key", "expires_at");

ALTER TABLE "cg_delegation" ADD CONSTRAINT "cg_delegation_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_policy_approval" ADD CONSTRAINT "cg_policy_approval_tenant_delegation_fkey"
  FOREIGN KEY ("tenant_id", "delegation_id") REFERENCES "cg_delegation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception_approval" ADD CONSTRAINT "cg_exception_approval_tenant_delegation_fkey"
  FOREIGN KEY ("tenant_id", "delegation_id") REFERENCES "cg_delegation"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cg_delegation" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg_delegation" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON "cg_delegation" TO dcontact_app;
REVOKE UPDATE, DELETE ON "cg_delegation" FROM dcontact_app;
