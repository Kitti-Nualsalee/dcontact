CREATE TYPE "CgFactOutcome" AS ENUM (
    'PROVIDER_REJECTED',
    'DELIVERED',
    'DELIVERY_FAILED'
);

-- Composite keys let every new foreign key carry tenant_id, so an opaque ID
-- cannot be swapped across tenants even when the referenced UUID exists.
CREATE UNIQUE INDEX "contacts_tenant_id_id_key"
ON "contacts"("tenant_id", "id");
CREATE UNIQUE INDEX "contact_identities_tenant_id_id_key"
ON "contact_identities"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_reservations_tenant_id_id_key"
ON "cg_reservations"("tenant_id", "id");

CREATE TABLE "cg_attempts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "outcome_ref" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID,
    "channel" "ChannelType" NOT NULL,
    "purpose" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "outcome" "CgFactOutcome" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cg_attempts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cg_touches" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "attempt_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "delivery_id" TEXT NOT NULL,
    "outcome_ref" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID,
    "channel" "ChannelType" NOT NULL,
    "purpose" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "outcome" "CgFactOutcome" NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cg_touches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cg_attempts_tenant_id_id_key"
ON "cg_attempts"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_attempts_tenant_id_outcome_ref_key"
ON "cg_attempts"("tenant_id", "outcome_ref");
CREATE INDEX "cg_attempts_tenant_id_contact_id_occurred_at_idx"
ON "cg_attempts"("tenant_id", "contact_id", "occurred_at");
CREATE INDEX "cg_attempts_tenant_id_reservation_id_occurred_at_idx"
ON "cg_attempts"("tenant_id", "reservation_id", "occurred_at");
CREATE INDEX "cg_attempts_tenant_id_delivery_id_occurred_at_idx"
ON "cg_attempts"("tenant_id", "delivery_id", "occurred_at");

CREATE UNIQUE INDEX "cg_touches_tenant_id_id_key"
ON "cg_touches"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_touches_tenant_id_attempt_id_key"
ON "cg_touches"("tenant_id", "attempt_id");
CREATE UNIQUE INDEX "cg_touches_tenant_id_outcome_ref_key"
ON "cg_touches"("tenant_id", "outcome_ref");
CREATE INDEX "cg_touches_tenant_id_contact_id_occurred_at_idx"
ON "cg_touches"("tenant_id", "contact_id", "occurred_at");
CREATE INDEX "cg_touches_tenant_id_reservation_id_occurred_at_idx"
ON "cg_touches"("tenant_id", "reservation_id", "occurred_at");
CREATE INDEX "cg_touches_tenant_id_delivery_id_occurred_at_idx"
ON "cg_touches"("tenant_id", "delivery_id", "occurred_at");

ALTER TABLE "cg_attempts"
ADD CONSTRAINT "cg_attempts_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_attempts"
ADD CONSTRAINT "cg_attempts_tenant_id_reservation_id_fkey"
FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "cg_reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_attempts"
ADD CONSTRAINT "cg_attempts_tenant_id_contact_id_fkey"
FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_attempts"
ADD CONSTRAINT "cg_attempts_tenant_id_identity_id_fkey"
FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "contact_identities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cg_touches"
ADD CONSTRAINT "cg_touches_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_touches"
ADD CONSTRAINT "cg_touches_tenant_id_attempt_id_fkey"
FOREIGN KEY ("tenant_id", "attempt_id") REFERENCES "cg_attempts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_touches"
ADD CONSTRAINT "cg_touches_tenant_id_reservation_id_fkey"
FOREIGN KEY ("tenant_id", "reservation_id") REFERENCES "cg_reservations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_touches"
ADD CONSTRAINT "cg_touches_tenant_id_contact_id_fkey"
FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_touches"
ADD CONSTRAINT "cg_touches_tenant_id_identity_id_fkey"
FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "contact_identities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cg_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_touches" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "cg_attempts"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_touches"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON "cg_attempts", "cg_touches" TO dcontact_app;
REVOKE UPDATE, DELETE ON "cg_attempts", "cg_touches" FROM dcontact_app;
