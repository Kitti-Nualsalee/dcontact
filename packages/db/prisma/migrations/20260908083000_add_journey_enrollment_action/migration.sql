CREATE TYPE "JrEnrollmentState" AS ENUM (
    'PENDING',
    'REVIEW',
    'BLOCKED',
    'DEFERRED',
    'AUTHORIZED'
);

CREATE TABLE "jr_enrollments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_inbox_id" UUID NOT NULL,
    "journey_version" INTEGER NOT NULL,
    "contact_id" UUID,
    "decision_id" UUID,
    "state" "JrEnrollmentState" NOT NULL DEFAULT 'PENDING',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "jr_enrollments_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jr_actions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "action_key" TEXT NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID NOT NULL,
    "channel" "ChannelType" NOT NULL,
    "purpose" TEXT NOT NULL,
    "decision_id" UUID NOT NULL,
    "reservation_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "jr_actions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "jr_enrollments_tenant_id_event_inbox_id_key"
ON "jr_enrollments"("tenant_id", "event_inbox_id");
CREATE INDEX "jr_enrollments_tenant_id_contact_id_state_idx"
ON "jr_enrollments"("tenant_id", "contact_id", "state");
CREATE UNIQUE INDEX "jr_actions_tenant_id_action_key_key"
ON "jr_actions"("tenant_id", "action_key");
CREATE INDEX "jr_actions_tenant_id_enrollment_id_idx"
ON "jr_actions"("tenant_id", "enrollment_id");
CREATE INDEX "jr_actions_tenant_id_contact_id_created_at_idx"
ON "jr_actions"("tenant_id", "contact_id", "created_at");

ALTER TABLE "jr_enrollments"
ADD CONSTRAINT "jr_enrollments_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_enrollments"
ADD CONSTRAINT "jr_enrollments_event_inbox_id_fkey"
FOREIGN KEY ("event_inbox_id") REFERENCES "jr_event_inbox"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_enrollments"
ADD CONSTRAINT "jr_enrollments_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "jr_enrollments"
ADD CONSTRAINT "jr_enrollments_decision_id_fkey"
FOREIGN KEY ("decision_id") REFERENCES "cg_decision_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "jr_actions"
ADD CONSTRAINT "jr_actions_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_actions"
ADD CONSTRAINT "jr_actions_enrollment_id_fkey"
FOREIGN KEY ("enrollment_id") REFERENCES "jr_enrollments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_actions"
ADD CONSTRAINT "jr_actions_contact_id_fkey"
FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_actions"
ADD CONSTRAINT "jr_actions_identity_id_fkey"
FOREIGN KEY ("identity_id") REFERENCES "contact_identities"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_actions"
ADD CONSTRAINT "jr_actions_decision_id_fkey"
FOREIGN KEY ("decision_id") REFERENCES "cg_decision_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_actions"
ADD CONSTRAINT "jr_actions_reservation_id_fkey"
FOREIGN KEY ("reservation_id") REFERENCES "cg_reservations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_enrollments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jr_actions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "jr_enrollments"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "jr_actions"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE
ON "jr_enrollments", "jr_actions"
TO dcontact_app;
