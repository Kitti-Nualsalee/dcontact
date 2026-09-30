-- E1.18 (#520): durable voice delivery extension. Provider traffic remains disabled.
CREATE TYPE "DlVoiceOriginateState" AS ENUM ('QUEUED', 'CANCEL_REQUESTED', 'RECONCILING', 'SETTLED');
CREATE TABLE "dl_voice_originates" (
  "id" UUID NOT NULL, "tenant_id" UUID NOT NULL, "delivery_id" TEXT NOT NULL,
  "adapter" "DlDeliveryAdapter" NOT NULL DEFAULT 'FREESWITCH_ORIGINATE',
  "interaction_id" UUID NOT NULL, "work_session_lease_id" UUID NOT NULL, "agent_user_id" UUID NOT NULL,
  "agent_extension" TEXT NOT NULL, "telephony_node_id" TEXT NOT NULL, "target_identity_id" UUID NOT NULL,
  "origination_uuid" UUID NOT NULL, "state" "DlVoiceOriginateState" NOT NULL DEFAULT 'QUEUED',
  "outcome" "CgFactOutcome", "outcome_ref" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_voice_originates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_voice_originates_shape_check" CHECK ("agent_extension" ~ '^[A-Za-z0-9_.-]{1,64}$' AND "telephony_node_id" ~ '^[A-Za-z0-9_.-]{1,128}$' AND ("outcome_ref" IS NULL OR "outcome_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')),
  CONSTRAINT "dl_voice_originates_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "dl_voice_originates_outbox_fkey" FOREIGN KEY ("tenant_id", "delivery_id", "adapter") REFERENCES "dl_outbox_entries"("tenant_id", "delivery_id", "adapter") ON DELETE RESTRICT ON UPDATE RESTRICT
);
CREATE UNIQUE INDEX "dl_voice_originates_tenant_delivery_key" ON "dl_voice_originates"("tenant_id", "delivery_id");
CREATE UNIQUE INDEX "dl_voice_originates_tenant_origination_key" ON "dl_voice_originates"("tenant_id", "origination_uuid");
CREATE INDEX "dl_voice_originates_tenant_state_updated_idx" ON "dl_voice_originates"("tenant_id", "state", "updated_at");
ALTER TABLE "dl_voice_originates" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dl_voice_originates" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "dl_voice_originates" TO dcontact_app;
REVOKE DELETE ON "dl_voice_originates" FROM dcontact_app;
