-- CreateEnum
CREATE TYPE "DlDeliveryState" AS ENUM ('QUEUED', 'SUBMITTING', 'SUBMITTED', 'RECONCILING', 'SETTLED');

-- CreateEnum
CREATE TYPE "DlDeliveryAdapter" AS ENUM ('TEST_ADAPTER');

-- CreateTable
CREATE TABLE "dl_outbox_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "action_key" TEXT NOT NULL,
    "reservation_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "provider_request_key" TEXT NOT NULL,
    "adapter" "DlDeliveryAdapter" NOT NULL DEFAULT 'TEST_ADAPTER',
    "channel" "ChannelType" NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID,
    "purpose" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "sender_identity_id" TEXT NOT NULL,
    "content_ref" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "state" "DlDeliveryState" NOT NULL DEFAULT 'QUEUED',
    "lease_version" INTEGER NOT NULL,
    "lease_expires_at" TIMESTAMP(3) NOT NULL,
    "submitted_at" TIMESTAMP(3),
    "outcome" "CgFactOutcome",
    "outcome_ref" TEXT,
    "settled_at" TIMESTAMP(3),
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dl_outbox_entries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "dl_outbox_entries_tenant_state_lease_expiry_idx" ON "dl_outbox_entries"("tenant_id", "state", "lease_expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "dl_outbox_entries_tenant_action_key" ON "dl_outbox_entries"("tenant_id", "action_key");

-- CreateIndex
CREATE UNIQUE INDEX "dl_outbox_entries_tenant_delivery_key" ON "dl_outbox_entries"("tenant_id", "delivery_id");

-- CreateIndex
CREATE UNIQUE INDEX "dl_outbox_entries_tenant_provider_request_key" ON "dl_outbox_entries"("tenant_id", "provider_request_key");

-- CreateIndex
CREATE UNIQUE INDEX "dl_outbox_entries_tenant_outcome_ref_key" ON "dl_outbox_entries"("tenant_id", "outcome_ref");

-- AddForeignKey
ALTER TABLE "dl_outbox_entries" ADD CONSTRAINT "dl_outbox_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dl_outbox_entries" ADD CONSTRAINT "dl_outbox_entries_tenant_reservation_fkey" FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "cg_reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dl_outbox_entries" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dl_outbox_entries"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- outbox เดินสถานะได้ (UPDATE ต้องผ่าน) แต่ delivery ที่ claim ไปแล้วห้ามหายทั้งแถว
GRANT SELECT, INSERT, UPDATE ON "dl_outbox_entries" TO dcontact_app;
REVOKE DELETE ON "dl_outbox_entries" FROM dcontact_app;
