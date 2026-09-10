CREATE TYPE "DvOutboxState" AS ENUM (
    'QUEUED',
    'SUBMITTING',
    'SETTLED'
);

CREATE TABLE "dv_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "action_key" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "reservation_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "provider_request_key" TEXT NOT NULL,
    "lease_version" INTEGER NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID,
    "sender_identity_id" TEXT NOT NULL,
    "content_ref" TEXT NOT NULL,
    "state" "DvOutboxState" NOT NULL DEFAULT 'QUEUED',
    "outcome_ref" TEXT,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "dv_outbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "dv_outbox_tenant_id_id_key"
ON "dv_outbox"("tenant_id", "id");
CREATE UNIQUE INDEX "dv_outbox_tenant_id_action_key_key"
ON "dv_outbox"("tenant_id", "action_key");
CREATE UNIQUE INDEX "dv_outbox_tenant_id_delivery_id_key"
ON "dv_outbox"("tenant_id", "delivery_id");
CREATE UNIQUE INDEX "dv_outbox_tenant_id_provider_request_key_key"
ON "dv_outbox"("tenant_id", "provider_request_key");
CREATE INDEX "dv_outbox_tenant_id_state_idx"
ON "dv_outbox"("tenant_id", "state");

ALTER TABLE "dv_outbox"
ADD CONSTRAINT "dv_outbox_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dv_outbox" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "dv_outbox"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- durable outbox: content/binding fields ไม่ถูกแก้หลังสร้าง มีแค่ state/outcome_ref
-- ที่เปลี่ยนได้ตาม lifecycle (submit/settle) ไม่มีการลบ
GRANT SELECT, INSERT, UPDATE ON "dv_outbox" TO dcontact_app;
REVOKE DELETE ON "dv_outbox" FROM dcontact_app;
