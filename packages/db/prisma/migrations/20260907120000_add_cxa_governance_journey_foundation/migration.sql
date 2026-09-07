CREATE TYPE "CgRestrictionType" AS ENUM (
    'DNC',
    'OBJECTION',
    'CONSENT_REVOKED',
    'INBOUND_SAFETY',
    'REGULATORY'
);

CREATE TYPE "CgConsentStatus" AS ENUM ('GRANTED', 'REVOKED', 'EXPIRED');
CREATE TYPE "CgDecision" AS ENUM ('ALLOW', 'BLOCK', 'DEFER', 'REVIEW');
CREATE TYPE "CgReservationState" AS ENUM ('RESERVED', 'CONFIRMED', 'RELEASED', 'REFUNDED');
CREATE TYPE "JrEventInboxState" AS ENUM ('PENDING', 'PUBLISHED', 'PROCESSED', 'FAILED');

CREATE TABLE "cg_restrictions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID,
    "identity_id" UUID,
    "type" "CgRestrictionType" NOT NULL,
    "channel" "ChannelType",
    "purpose" TEXT,
    "scope" TEXT NOT NULL,
    "overridable" BOOLEAN NOT NULL DEFAULT false,
    "reason_code" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "evidence" JSONB,
    "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "created_by" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cg_restrictions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cg_consents" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID,
    "purpose" TEXT NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "status" "CgConsentStatus" NOT NULL,
    "lawful_basis" TEXT NOT NULL,
    "notice_version" TEXT,
    "evidence" JSONB NOT NULL DEFAULT '{}',
    "granted_at" TIMESTAMP(3),
    "revoked_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cg_consents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cg_reservations" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID,
    "channel" "ChannelType" NOT NULL,
    "purpose" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "team_id" UUID,
    "segment_snapshot" JSONB,
    "scope_version" INTEGER,
    "action_key" TEXT NOT NULL,
    "input_hash" TEXT NOT NULL,
    "state" "CgReservationState" NOT NULL DEFAULT 'RESERVED',
    "expires_at" TIMESTAMP(3) NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "released_at" TIMESTAMP(3),
    "refunded_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "cg_reservations_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "cg_decision_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID,
    "identity_id" UUID,
    "channel" "ChannelType" NOT NULL,
    "purpose" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "team_id" UUID,
    "segment_snapshot" JSONB,
    "scope_version" INTEGER,
    "action_key" TEXT NOT NULL,
    "input_hash" TEXT,
    "decision" "CgDecision" NOT NULL,
    "reason_code" TEXT NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "gate" TEXT NOT NULL,
    "trace" JSONB NOT NULL,
    "reservation_id" UUID,
    "decided_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "cg_decision_logs_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jr_event_inbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "event_id" TEXT NOT NULL,
    "event_type" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "payload" JSONB NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "state" "JrEventInboxState" NOT NULL DEFAULT 'PENDING',
    "publish_attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "published_at" TIMESTAMP(3),
    "processed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "jr_event_inbox_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "cg_restrictions_tenant_id_contact_id_starts_at_idx"
ON "cg_restrictions"("tenant_id", "contact_id", "starts_at");
CREATE INDEX "cg_restrictions_tenant_id_identity_id_starts_at_idx"
ON "cg_restrictions"("tenant_id", "identity_id", "starts_at");
CREATE INDEX "cg_restrictions_tenant_id_type_starts_at_idx"
ON "cg_restrictions"("tenant_id", "type", "starts_at");

CREATE INDEX "cg_consents_tenant_id_contact_id_purpose_channel_status_idx"
ON "cg_consents"("tenant_id", "contact_id", "purpose", "channel", "status");
CREATE INDEX "cg_consents_tenant_id_identity_id_purpose_channel_status_idx"
ON "cg_consents"("tenant_id", "identity_id", "purpose", "channel", "status");

CREATE UNIQUE INDEX "cg_reservations_tenant_id_action_key_key"
ON "cg_reservations"("tenant_id", "action_key");
CREATE INDEX "cg_reservations_tenant_id_contact_id_state_created_at_idx"
ON "cg_reservations"("tenant_id", "contact_id", "state", "created_at");
CREATE INDEX "cg_reservations_tenant_id_state_expires_at_idx"
ON "cg_reservations"("tenant_id", "state", "expires_at");

CREATE INDEX "cg_decision_logs_tenant_id_action_key_decided_at_idx"
ON "cg_decision_logs"("tenant_id", "action_key", "decided_at");
CREATE INDEX "cg_decision_logs_tenant_id_contact_id_decided_at_idx"
ON "cg_decision_logs"("tenant_id", "contact_id", "decided_at");

CREATE UNIQUE INDEX "jr_event_inbox_tenant_id_source_event_id_key"
ON "jr_event_inbox"("tenant_id", "source", "event_id");
CREATE INDEX "jr_event_inbox_tenant_id_state_created_at_idx"
ON "jr_event_inbox"("tenant_id", "state", "created_at");

ALTER TABLE "cg_restrictions"
ADD CONSTRAINT "cg_restrictions_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_restrictions"
ADD CONSTRAINT "cg_restrictions_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cg_restrictions"
ADD CONSTRAINT "cg_restrictions_identity_id_fkey"
FOREIGN KEY ("identity_id") REFERENCES "contact_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cg_consents"
ADD CONSTRAINT "cg_consents_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_consents"
ADD CONSTRAINT "cg_consents_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_consents"
ADD CONSTRAINT "cg_consents_identity_id_fkey"
FOREIGN KEY ("identity_id") REFERENCES "contact_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cg_reservations"
ADD CONSTRAINT "cg_reservations_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_reservations"
ADD CONSTRAINT "cg_reservations_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_reservations"
ADD CONSTRAINT "cg_reservations_identity_id_fkey"
FOREIGN KEY ("identity_id") REFERENCES "contact_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "cg_decision_logs"
ADD CONSTRAINT "cg_decision_logs_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_decision_logs"
ADD CONSTRAINT "cg_decision_logs_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cg_decision_logs"
ADD CONSTRAINT "cg_decision_logs_identity_id_fkey"
FOREIGN KEY ("identity_id") REFERENCES "contact_identities"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "cg_decision_logs"
ADD CONSTRAINT "cg_decision_logs_reservation_id_fkey"
FOREIGN KEY ("reservation_id") REFERENCES "cg_reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "jr_event_inbox"
ADD CONSTRAINT "jr_event_inbox_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cg_restrictions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_decision_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_reservations" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jr_event_inbox" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "cg_restrictions"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_consents"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_decision_logs"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_reservations"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "jr_event_inbox"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE
ON "cg_restrictions", "cg_consents", "cg_decision_logs", "cg_reservations", "jr_event_inbox"
TO dcontact_app;

-- Decision logs เป็นหลักฐานแบบ append-only ผ่าน application role
REVOKE UPDATE, DELETE ON "cg_decision_logs" FROM dcontact_app;
