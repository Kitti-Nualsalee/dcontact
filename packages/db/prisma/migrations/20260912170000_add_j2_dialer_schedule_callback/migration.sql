-- J2.6: Dialer SCHEDULE_CALLBACK/CANCEL_CALLBACK/SUPERSEDE_CALLBACK owner slice.
-- Reuses ob_dialer_command_inbox from J2.5 (commandType already reserved for this) —
-- only the canonical ob_callbacks table is new. No actual originate/telephony
-- command here (see issue #134 out of scope).

CREATE TYPE "ObCallbackState" AS ENUM ('SCHEDULED', 'ORIGINATING', 'ACTIVE', 'CONSUMED', 'CANCELLED', 'SUPERSEDED');

CREATE TABLE "ob_callbacks" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "queue_id" UUID NOT NULL,
  "agent_id" UUID,
  "requested_for" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "state" "ObCallbackState" NOT NULL DEFAULT 'SCHEDULED',
  "version" INTEGER NOT NULL DEFAULT 1,
  "source_owner_team_id" UUID NOT NULL,
  "target_owner_team_id" UUID NOT NULL,
  "cancelled_at" TIMESTAMP(3),
  "cancel_reason_code" TEXT,
  "superseded_at" TIMESTAMP(3),
  "superseding_outcome_type" TEXT,
  "superseding_outcome_id" UUID,
  "superseding_outcome_version" INTEGER,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "ob_callbacks_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ob_callbacks_version_check" CHECK ("version" > 0)
);
CREATE INDEX "ob_callbacks_tenant_contact_state_idx"
  ON "ob_callbacks"("tenant_id", "contact_id", "state");

ALTER TABLE "ob_callbacks"
  ADD CONSTRAINT "ob_callbacks_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ob_callbacks"
  ADD CONSTRAINT "ob_callbacks_tenant_contact_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ob_callbacks" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ob_callbacks"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- callback เดินสถานะได้ (UPDATE) แต่ห้ามหายทั้งแถว
GRANT SELECT, INSERT, UPDATE ON "ob_callbacks" TO dcontact_app;
REVOKE DELETE ON "ob_callbacks" FROM dcontact_app;
