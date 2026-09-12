-- J2.5: minimal Dialer ADMIT_CAMPAIGN_TARGET owner slice. Dialer is the sole
-- canonical writer of ob_campaign_* — Journey never creates/starts/pauses/edits
-- a Campaign or originates here (see issue #133).

CREATE TYPE "ObCampaignStatus" AS ENUM ('ACTIVE', 'SCHEDULED', 'PAUSED', 'STOPPED', 'COMPLETED');
CREATE TYPE "ObCampaignTargetState" AS ENUM ('ADMITTED', 'DEFERRED');

CREATE TABLE "ob_campaigns" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "key" TEXT NOT NULL,
  "status" "ObCampaignStatus" NOT NULL DEFAULT 'ACTIVE',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ob_campaigns_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ob_campaigns_tenant_key_key" ON "ob_campaigns"("tenant_id", "key");

CREATE TABLE "ob_campaign_admission_policies" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "allow_cross_campaign_duplicate" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ob_campaign_admission_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ob_campaign_admission_policies_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "ob_campaign_admission_policies_tenant_campaign_key"
  ON "ob_campaign_admission_policies"("tenant_id", "campaign_id");

CREATE TABLE "ob_campaign_targets" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "campaign_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1,
  "state" "ObCampaignTargetState" NOT NULL DEFAULT 'ADMITTED',
  "source_owner_team_id" UUID NOT NULL,
  "target_owner_team_id" UUID NOT NULL,
  "admission_policy_version" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ob_campaign_targets_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ob_campaign_targets_version_check" CHECK ("version" > 0)
);
CREATE UNIQUE INDEX "ob_campaign_targets_tenant_campaign_contact_key"
  ON "ob_campaign_targets"("tenant_id", "campaign_id", "contact_id");
CREATE INDEX "ob_campaign_targets_tenant_contact_idx"
  ON "ob_campaign_targets"("tenant_id", "contact_id");

CREATE TABLE "ob_dialer_command_inbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "command_id" TEXT NOT NULL,
  "action_key" TEXT NOT NULL,
  "command_type" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "status" TEXT NOT NULL,
  "code" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "failure_class" TEXT NOT NULL,
  "retry_disposition" TEXT NOT NULL,
  "record_id" UUID,
  "record_version" INTEGER,
  "correlation_id" TEXT NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ob_dialer_command_inbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "ob_dialer_command_inbox_tenant_action_key"
  ON "ob_dialer_command_inbox"("tenant_id", "action_key");
CREATE INDEX "ob_dialer_command_inbox_tenant_command_idx"
  ON "ob_dialer_command_inbox"("tenant_id", "command_id");

ALTER TABLE "ob_campaigns"
  ADD CONSTRAINT "ob_campaigns_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ob_campaign_admission_policies"
  ADD CONSTRAINT "ob_campaign_admission_policies_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ob_campaign_targets"
  ADD CONSTRAINT "ob_campaign_targets_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ob_campaign_targets"
  ADD CONSTRAINT "ob_campaign_targets_tenant_contact_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ob_dialer_command_inbox"
  ADD CONSTRAINT "ob_dialer_command_inbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ob_campaigns" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ob_campaigns"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "ob_campaign_admission_policies" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ob_campaign_admission_policies"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "ob_campaign_targets" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ob_campaign_targets"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "ob_dialer_command_inbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ob_dialer_command_inbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- fixture/target/command เดินสถานะได้ (UPDATE) แต่ห้ามหายทั้งแถว
GRANT SELECT, INSERT, UPDATE ON
  "ob_campaigns", "ob_campaign_admission_policies", "ob_campaign_targets", "ob_dialer_command_inbox"
TO dcontact_app;
REVOKE DELETE ON
  "ob_campaigns", "ob_campaign_admission_policies", "ob_campaign_targets", "ob_dialer_command_inbox"
FROM dcontact_app;
