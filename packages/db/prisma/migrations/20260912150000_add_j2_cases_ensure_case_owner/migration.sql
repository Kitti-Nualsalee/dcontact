-- J2.4: minimal Cases ENSURE_CASE owner slice. Cases is the sole canonical writer
-- of cs_* — Journey never selects caseId or writes here directly (see issue #132).

CREATE TYPE "CsCaseStatus" AS ENUM ('OPEN', 'RESOLVED', 'CLOSED');
CREATE TYPE "CsActivityKind" AS ENUM ('CREATED', 'LINKED', 'REOPENED');

CREATE TABLE "cs_case_type_policies" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "policy_ref" TEXT NOT NULL,
  "case_type_key" TEXT NOT NULL,
  "reopen_allowed" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cs_case_type_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cs_case_type_policies_tenant_ref_key"
  ON "cs_case_type_policies"("tenant_id", "policy_ref");

CREATE TABLE "cs_routing_policies" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "policy_ref" TEXT NOT NULL,
  "queue_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cs_routing_policies_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cs_routing_policies_tenant_ref_key"
  ON "cs_routing_policies"("tenant_id", "policy_ref");

CREATE TABLE "cs_cases" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "case_type_key" TEXT NOT NULL,
  "routing_ref" TEXT,
  "status" "CsCaseStatus" NOT NULL DEFAULT 'OPEN',
  "version" INTEGER NOT NULL DEFAULT 1,
  "reopen_count" INTEGER NOT NULL DEFAULT 0,
  "resolved_at" TIMESTAMP(3),
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cs_cases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cs_cases_version_check" CHECK ("version" > 0),
  CONSTRAINT "cs_cases_reopen_count_check" CHECK ("reopen_count" >= 0)
);
CREATE INDEX "cs_cases_tenant_contact_type_status_idx"
  ON "cs_cases"("tenant_id", "contact_id", "case_type_key", "status");

CREATE TABLE "cs_case_links" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "case_id" UUID NOT NULL,
  "related_case_id" UUID NOT NULL,
  "kind" TEXT NOT NULL DEFAULT 'RELATED',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cs_case_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cs_case_links_tenant_case_related_kind_key"
  ON "cs_case_links"("tenant_id", "case_id", "related_case_id", "kind");

CREATE TABLE "cs_case_activities" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "case_id" UUID NOT NULL,
  "kind" "CsActivityKind" NOT NULL,
  "interaction_id" TEXT NOT NULL,
  "outcome_type" TEXT NOT NULL,
  "outcome_id" UUID NOT NULL,
  "outcome_version" INTEGER NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cs_case_activities_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "cs_case_activities_tenant_case_occurred_idx"
  ON "cs_case_activities"("tenant_id", "case_id", "occurred_at");

CREATE TABLE "cs_command_inbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "command_id" TEXT NOT NULL,
  "action_key" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "status" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "failure_class" TEXT NOT NULL,
  "retry_disposition" TEXT NOT NULL,
  "case_id" UUID,
  "case_version" INTEGER,
  "correlation_id" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cs_command_inbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "cs_command_inbox_tenant_action_key"
  ON "cs_command_inbox"("tenant_id", "action_key");
CREATE INDEX "cs_command_inbox_tenant_command_idx"
  ON "cs_command_inbox"("tenant_id", "command_id");

ALTER TABLE "cs_case_type_policies"
  ADD CONSTRAINT "cs_case_type_policies_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cs_routing_policies"
  ADD CONSTRAINT "cs_routing_policies_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cs_cases"
  ADD CONSTRAINT "cs_cases_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cs_cases"
  ADD CONSTRAINT "cs_cases_tenant_contact_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cs_case_links"
  ADD CONSTRAINT "cs_case_links_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cs_case_activities"
  ADD CONSTRAINT "cs_case_activities_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cs_command_inbox"
  ADD CONSTRAINT "cs_command_inbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cs_case_type_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cs_case_type_policies"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "cs_routing_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cs_routing_policies"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "cs_cases" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cs_cases"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "cs_case_links" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cs_case_links"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "cs_case_activities" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cs_case_activities"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "cs_command_inbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cs_command_inbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- fixtures/case/link/activity เดินสถานะได้ (UPDATE) แต่ห้ามหายทั้งแถว
GRANT SELECT, INSERT, UPDATE ON
  "cs_case_type_policies", "cs_routing_policies", "cs_cases",
  "cs_case_links", "cs_case_activities", "cs_command_inbox"
TO dcontact_app;
REVOKE DELETE ON
  "cs_case_type_policies", "cs_routing_policies", "cs_cases",
  "cs_case_links", "cs_case_activities", "cs_command_inbox"
FROM dcontact_app;
