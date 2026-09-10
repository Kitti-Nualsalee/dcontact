CREATE TYPE "CgDeliverySettlementStatus" AS ENUM (
    'UNCLAIMED',
    'CLAIMED',
    'UNKNOWN_RECONCILING',
    'ACCEPTED',
    'SETTLED'
);

CREATE TYPE "CgReservationCommandOperation" AS ENUM (
    'CLAIM',
    'RENEW',
    'BEGIN_SUBMISSION',
    'CONFIRM',
    'RELEASE',
    'SETTLE'
);

-- Expand-only: แถว reservation จาก E0 คงอ่านได้โดยใช้ null เป็น UNCLAIMED legacy state
ALTER TABLE "cg_reservations"
ADD COLUMN "delivery_id" TEXT,
ADD COLUMN "sender_identity_id" TEXT,
ADD COLUMN "provider_request_key" TEXT,
ADD COLUMN "lease_version" INTEGER,
ADD COLUMN "lease_expires_at" TIMESTAMP(3),
ADD COLUMN "submission_started_at" TIMESTAMP(3),
ADD COLUMN "settlement_status" "CgDeliverySettlementStatus",
ADD COLUMN "terminal_outcome" "CgFactOutcome",
ADD COLUMN "terminal_outcome_ref" TEXT,
ADD COLUMN "settled_at" TIMESTAMP(3),
ADD CONSTRAINT "cg_reservations_lease_version_check"
CHECK ("lease_version" IS NULL OR "lease_version" > 0);

CREATE UNIQUE INDEX "cg_reservations_tenant_id_delivery_id_key"
ON "cg_reservations"("tenant_id", "delivery_id");
CREATE UNIQUE INDEX "cg_reservations_tenant_id_provider_request_key_key"
ON "cg_reservations"("tenant_id", "provider_request_key");
CREATE INDEX "cg_reservations_tenant_id_settlement_status_lease_expiry_idx"
ON "cg_reservations"("tenant_id", "settlement_status", "lease_expires_at");

CREATE TABLE "cg_reservation_command_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "operation" "CgReservationCommandOperation" NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "response" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cg_reservation_command_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cg_reservation_command_receipts_tenant_operation_key"
ON "cg_reservation_command_receipts"("tenant_id", "operation", "idempotency_key");
CREATE INDEX "cg_reservation_command_receipts_tenant_reservation_created_idx"
ON "cg_reservation_command_receipts"("tenant_id", "reservation_id", "created_at");

ALTER TABLE "cg_reservation_command_receipts"
ADD CONSTRAINT "cg_reservation_command_receipts_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_reservation_command_receipts"
ADD CONSTRAINT "cg_reservation_command_receipts_tenant_reservation_fkey"
FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "cg_reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cg_reservation_command_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg_reservation_command_receipts"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON "cg_reservation_command_receipts" TO dcontact_app;
REVOKE UPDATE, DELETE ON "cg_reservation_command_receipts" FROM dcontact_app;
