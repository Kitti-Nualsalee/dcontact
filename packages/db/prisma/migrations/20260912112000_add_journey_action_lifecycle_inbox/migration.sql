CREATE TYPE "JrActionLifecycleState" AS ENUM ('PRE_BARRIER', 'POST_BARRIER', 'ACCEPTED');

CREATE TABLE "jr_action_lifecycle_inbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "action_key" TEXT NOT NULL,
  "reservation_id" UUID NOT NULL,
  "delivery_id" UUID NOT NULL,
  "provider_request_key" TEXT NOT NULL,
  "state" "JrActionLifecycleState" NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "binding_hash" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_action_lifecycle_inbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "jr_action_lifecycle_inbox_event_key"
  ON "jr_action_lifecycle_inbox"("tenant_id", "event_id");
CREATE INDEX "jr_action_lifecycle_inbox_action_idx"
  ON "jr_action_lifecycle_inbox"("tenant_id", "action_key", "occurred_at");
ALTER TABLE "jr_action_lifecycle_inbox"
  ADD CONSTRAINT "jr_action_lifecycle_inbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_action_lifecycle_inbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_action_lifecycle_inbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "jr_action_lifecycle_inbox" TO dcontact_app;
REVOKE DELETE ON "jr_action_lifecycle_inbox" FROM dcontact_app;
