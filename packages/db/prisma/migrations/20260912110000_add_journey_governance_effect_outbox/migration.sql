CREATE TYPE "JrGovernanceEffectState" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "JrGovernanceEffectKind" AS ENUM ('RELEASE_BEFORE_BARRIER', 'REQUEST_RECONCILE');

CREATE TABLE "jr_governance_effect_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "action_id" UUID NOT NULL,
  "action_key" TEXT NOT NULL,
  "reservation_id" UUID NOT NULL,
  "delivery_id" UUID,
  "provider_request_key" TEXT,
  "correlation_id" TEXT NOT NULL,
  "kind" "JrGovernanceEffectKind" NOT NULL,
  "state" "JrGovernanceEffectState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_governance_effect_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_governance_effect_outbox_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "jr_governance_effect_outbox_event_action_kind_key"
  ON "jr_governance_effect_outbox"("tenant_id", "event_id", "action_id", "kind");
CREATE INDEX "jr_governance_effect_outbox_ready_idx"
  ON "jr_governance_effect_outbox"("tenant_id", "state", "available_at");

ALTER TABLE "jr_governance_effect_outbox"
  ADD CONSTRAINT "jr_governance_effect_outbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_governance_effect_outbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_governance_effect_outbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "jr_governance_effect_outbox" TO dcontact_app;
REVOKE DELETE ON "jr_governance_effect_outbox" FROM dcontact_app;
