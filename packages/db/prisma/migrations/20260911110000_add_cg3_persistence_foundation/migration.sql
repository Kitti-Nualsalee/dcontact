-- CreateEnum
CREATE TYPE "CgPreferenceDecision" AS ENUM ('ALLOW', 'BLOCK', 'DEFER');

-- CreateEnum
CREATE TYPE "CgPreferenceMutationKind" AS ENUM ('SET', 'REVOKE');

-- CreateEnum
CREATE TYPE "CgSourceKind" AS ENUM ('CUSTOMER', 'PROVIDER', 'AGENT', 'CRM', 'FLOW', 'ADMIN', 'COMPLIANCE', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CgPolicyStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CgCallbackMode" AS ENUM ('NO_OVERRIDE', 'SCOPED_OVERRIDE', 'TIME_POLICY_OVERRIDE');

-- CreateEnum
CREATE TYPE "CgHolidayEffect" AS ENUM ('CLOSED', 'WINDOWS');

-- CreateEnum
CREATE TYPE "CgCallbackMutationKind" AS ENUM ('REQUEST', 'CONSUME', 'REVOKE');

-- CreateEnum
CREATE TYPE "CgAggregateType" AS ENUM ('CONTACT', 'POLICY');

-- CreateEnum
CREATE TYPE "CgEventOutboxState" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED');

-- CreateEnum
CREATE TYPE "CgConsumerAckOutcome" AS ENUM ('APPLIED', 'NO_OP', 'FAILED', 'QUARANTINED');

-- DropForeignKey
ALTER TABLE "cg_restrictions" DROP CONSTRAINT "cg_restrictions_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "cg_restrictions" DROP CONSTRAINT "cg_restrictions_identity_id_fkey";

-- DropForeignKey
ALTER TABLE "cg_consents" DROP CONSTRAINT "cg_consents_contact_id_fkey";

-- DropForeignKey
ALTER TABLE "cg_consents" DROP CONSTRAINT "cg_consents_identity_id_fkey";

-- AlterTable
ALTER TABLE "cg_reservations" ADD COLUMN     "authorization_aggregate_version" INTEGER,
ADD COLUMN     "authorization_decision_id" UUID,
ADD COLUMN     "authorization_policy_version" INTEGER,
ADD CONSTRAINT "cg_reservations_authorization_versions_check"
CHECK (
  ("authorization_aggregate_version" IS NULL OR "authorization_aggregate_version" >= 0) AND
  ("authorization_policy_version" IS NULL OR "authorization_policy_version" > 0)
);

-- AlterTable
ALTER TABLE "cg_decision_logs" ADD COLUMN     "aggregate_version" INTEGER,
ADD COLUMN     "exception_mode" "CgCallbackMode",
ADD COLUMN     "exception_ref" TEXT,
ADD COLUMN     "matched_scope" JSONB,
ADD COLUMN     "matched_window_ref" TEXT,
ADD COLUMN     "next_eligible_at" TIMESTAMP(3),
ADD COLUMN     "preference_version" INTEGER,
ADD COLUMN     "timezone_source" TEXT;

-- CreateTable
CREATE TABLE "cg_preferences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "series_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID,
    "channel" "ChannelType",
    "purpose" TEXT,
    "contact_kind" TEXT,
    "scope_hash" CHAR(64) NOT NULL,
    "decision" "CgPreferenceDecision",
    "timezone" TEXT,
    "preferred_windows" JSONB NOT NULL DEFAULT '[]',
    "source_kind" "CgSourceKind" NOT NULL,
    "source_version" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "mutation_kind" "CgPreferenceMutationKind" NOT NULL,
    "supersedes_id" UUID,
    "request_hash" CHAR(64) NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "actor_class" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cg_preferences_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cg_preferences_version_check" CHECK ("version" > 0),
    CONSTRAINT "cg_preferences_effective_period_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
    CONSTRAINT "cg_preferences_mutation_decision_check" CHECK ("mutation_kind" = 'REVOKE' OR "decision" IS NOT NULL)
);

-- CreateTable
CREATE TABLE "cg_policies" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "purpose" TEXT,
    "contact_kind" TEXT,
    "channel" "ChannelType",
    "timezone_fallback" TEXT,
    "quiet_hours" JSONB NOT NULL DEFAULT '[]',
    "callback_mode" "CgCallbackMode" NOT NULL DEFAULT 'SCOPED_OVERRIDE',
    "overridable_rules" JSONB NOT NULL DEFAULT '[]',
    "status" "CgPolicyStatus" NOT NULL DEFAULT 'DRAFT',
    "content_digest" CHAR(64) NOT NULL,
    "maker_actor_ref" TEXT NOT NULL,
    "checker_actor_ref" TEXT,
    "approval_ref" TEXT,
    "effective_from" TIMESTAMP(3) NOT NULL,
    "effective_to" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cg_policies_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cg_policies_version_check" CHECK ("version" > 0),
    CONSTRAINT "cg_policies_effective_period_check" CHECK ("effective_to" IS NULL OR "effective_to" > "effective_from"),
    CONSTRAINT "cg_policies_checker_separation_check" CHECK ("checker_actor_ref" IS NULL OR "checker_actor_ref" <> "maker_actor_ref"),
    CONSTRAINT "cg_policies_publish_metadata_check" CHECK (
      "status" <> 'PUBLISHED' OR
      ("checker_actor_ref" IS NOT NULL AND "approval_ref" IS NOT NULL AND "published_at" IS NOT NULL)
    )
);

-- CreateTable
CREATE TABLE "cg_holiday_calendar_entries" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "policy_id" UUID NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "local_date" DATE NOT NULL,
    "effect" "CgHolidayEffect" NOT NULL,
    "windows" JSONB NOT NULL DEFAULT '[]',
    "label_code" TEXT,
    "entry_digest" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cg_holiday_calendar_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cg_callback_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "series_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "contact_id" UUID NOT NULL,
    "identity_id" UUID,
    "channel" "ChannelType" NOT NULL,
    "purpose" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "requested_timezone" TEXT NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "source_kind" "CgSourceKind" NOT NULL,
    "source_version" TEXT,
    "one_use_token_hash" CHAR(64) NOT NULL,
    "approved_exception_id" UUID,
    "mutation_kind" "CgCallbackMutationKind" NOT NULL,
    "supersedes_id" UUID,
    "evidence_ref" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "actor_class" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cg_callback_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cg_callback_requests_version_check" CHECK ("version" > 0),
    CONSTRAINT "cg_callback_requests_expiry_check" CHECK ("expires_at" > "requested_at")
);

-- CreateTable
CREATE TABLE "cg_contact_state_heads" (
    "tenant_id" UUID NOT NULL,
    "contact_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL DEFAULT 0,
    "current_digest" CHAR(64) NOT NULL,
    "latest_mutation_id" UUID,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cg_contact_state_heads_pkey" PRIMARY KEY ("tenant_id","contact_id"),
    CONSTRAINT "cg_contact_state_heads_version_check" CHECK ("aggregate_version" >= 0)
);

-- CreateTable
CREATE TABLE "cg_event_outbox" (
    "id" UUID NOT NULL,
    "mutation_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "aggregate_type" "CgAggregateType" NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "event_type" TEXT NOT NULL,
    "ordering_key" TEXT NOT NULL,
    "contract_version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "payload_hash" CHAR(64) NOT NULL,
    "state" "CgEventOutboxState" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "published_at" TIMESTAMP(3),
    "broker_ref" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cg_event_outbox_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cg_event_outbox_versions_check" CHECK ("aggregate_version" > 0 AND "contract_version" > 0),
    CONSTRAINT "cg_event_outbox_attempts_check" CHECK ("attempts" >= 0)
);

-- CreateTable
CREATE TABLE "cg_command_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "operation" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "request_hash" CHAR(64) NOT NULL,
    "expected_version" INTEGER NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "response_status" INTEGER NOT NULL,
    "response_body" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cg_command_receipts_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cg_command_receipts_versions_check" CHECK ("expected_version" >= 0 AND "aggregate_version" > 0),
    CONSTRAINT "cg_command_receipts_status_check" CHECK ("response_status" BETWEEN 100 AND 599)
);

-- CreateTable
CREATE TABLE "cg_audit_logs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "mutation_id" UUID NOT NULL,
    "aggregate_type" "CgAggregateType" NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "aggregate_version" INTEGER NOT NULL,
    "action" TEXT NOT NULL,
    "actor_class" TEXT NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "source_kind" "CgSourceKind" NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "before_digest" CHAR(64),
    "after_digest" CHAR(64) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cg_audit_logs_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cg_audit_logs_version_check" CHECK ("aggregate_version" > 0)
);

-- CreateTable
CREATE TABLE "cg_consumer_acknowledgements" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "event_id" TEXT NOT NULL,
    "consumer" TEXT NOT NULL,
    "aggregate_type" "CgAggregateType" NOT NULL,
    "aggregate_id" UUID NOT NULL,
    "applied_version" INTEGER NOT NULL,
    "outcome" "CgConsumerAckOutcome" NOT NULL,
    "affected_count" INTEGER NOT NULL DEFAULT 0,
    "payload_hash" CHAR(64) NOT NULL,
    "applied_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cg_consumer_acknowledgements_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "cg_consumer_acknowledgements_values_check" CHECK ("applied_version" > 0 AND "affected_count" >= 0)
);

-- CreateIndex
CREATE INDEX "cg_preferences_tenant_id_contact_id_effective_from_effectiv_idx" ON "cg_preferences"("tenant_id", "contact_id", "effective_from", "effective_to", "version" DESC);

-- CreateIndex
CREATE INDEX "cg_preferences_tenant_id_identity_id_scope_hash_version_idx" ON "cg_preferences"("tenant_id", "identity_id", "scope_hash", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cg_preferences_tenant_id_id_key" ON "cg_preferences"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cg_preferences_tenant_id_series_id_version_key" ON "cg_preferences"("tenant_id", "series_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "cg_preferences_tenant_id_contact_id_scope_hash_version_key" ON "cg_preferences"("tenant_id", "contact_id", "scope_hash", "version");

-- CreateIndex
CREATE UNIQUE INDEX "cg_preferences_source_version_key" ON "cg_preferences"("tenant_id", "contact_id", "scope_hash", "source_kind", "source_version");

-- CreateIndex
CREATE INDEX "cg_policies_tenant_id_status_effective_from_effective_to_ve_idx" ON "cg_policies"("tenant_id", "status", "effective_from", "effective_to", "version" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "cg_policies_tenant_id_id_key" ON "cg_policies"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cg_policies_tenant_id_policy_id_version_key" ON "cg_policies"("tenant_id", "policy_id", "version");

-- CreateIndex
CREATE INDEX "cg_holiday_calendar_entries_tenant_id_local_date_policy_id__idx" ON "cg_holiday_calendar_entries"("tenant_id", "local_date", "policy_id", "policy_version");

-- CreateIndex
CREATE UNIQUE INDEX "cg_holiday_calendar_entries_tenant_id_policy_id_policy_vers_key" ON "cg_holiday_calendar_entries"("tenant_id", "policy_id", "policy_version", "local_date");

-- CreateIndex
CREATE INDEX "cg_callback_requests_tenant_id_contact_id_expires_at_versio_idx" ON "cg_callback_requests"("tenant_id", "contact_id", "expires_at", "version" DESC);

-- CreateIndex
CREATE INDEX "cg_callback_requests_tenant_id_identity_id_channel_purpose__idx" ON "cg_callback_requests"("tenant_id", "identity_id", "channel", "purpose", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "cg_callback_requests_tenant_id_id_key" ON "cg_callback_requests"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cg_callback_requests_tenant_id_series_id_version_key" ON "cg_callback_requests"("tenant_id", "series_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "cg_callback_requests_tenant_id_one_use_token_hash_key" ON "cg_callback_requests"("tenant_id", "one_use_token_hash");

-- CreateIndex
CREATE UNIQUE INDEX "cg_callback_requests_source_version_key" ON "cg_callback_requests"("tenant_id", "contact_id", "source_kind", "source_version");

-- CreateIndex
CREATE INDEX "cg_event_outbox_tenant_id_state_available_at_lease_expires__idx" ON "cg_event_outbox"("tenant_id", "state", "available_at", "lease_expires_at");

-- CreateIndex
CREATE INDEX "cg_event_outbox_tenant_id_aggregate_type_aggregate_id_aggre_idx" ON "cg_event_outbox"("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE UNIQUE INDEX "cg_event_outbox_tenant_id_mutation_id_event_type_key" ON "cg_event_outbox"("tenant_id", "mutation_id", "event_type");

-- CreateIndex
CREATE INDEX "cg_command_receipts_tenant_id_created_at_idx" ON "cg_command_receipts"("tenant_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "cg_command_receipts_tenant_id_operation_idempotency_key_key" ON "cg_command_receipts"("tenant_id", "operation", "idempotency_key");

-- CreateIndex
CREATE INDEX "cg_audit_logs_tenant_id_aggregate_type_aggregate_id_aggrega_idx" ON "cg_audit_logs"("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version");

-- CreateIndex
CREATE INDEX "cg_audit_logs_tenant_id_occurred_at_idx" ON "cg_audit_logs"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "cg_audit_logs_tenant_id_mutation_id_key" ON "cg_audit_logs"("tenant_id", "mutation_id");

-- CreateIndex
CREATE INDEX "cg_consumer_acknowledgements_tenant_id_aggregate_type_aggre_idx" ON "cg_consumer_acknowledgements"("tenant_id", "aggregate_type", "aggregate_id", "applied_version");

-- CreateIndex
CREATE UNIQUE INDEX "cg_consumer_acknowledgements_tenant_id_event_id_consumer_ap_key" ON "cg_consumer_acknowledgements"("tenant_id", "event_id", "consumer", "applied_version");

-- CreateIndex
CREATE UNIQUE INDEX "cg_decision_logs_tenant_id_id_key" ON "cg_decision_logs"("tenant_id", "id");

-- AddForeignKey
ALTER TABLE "cg_restrictions" ADD CONSTRAINT "cg_restrictions_tenant_contact_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "cg_restrictions" ADD CONSTRAINT "cg_restrictions_tenant_identity_fkey" FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "contact_identities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "cg_consents" ADD CONSTRAINT "cg_consents_tenant_contact_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "cg_consents" ADD CONSTRAINT "cg_consents_tenant_identity_fkey" FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "contact_identities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE NOT VALID;

-- AddForeignKey
ALTER TABLE "cg_reservations" ADD CONSTRAINT "cg_reservations_tenant_authorization_decision_fkey" FOREIGN KEY ("tenant_id", "authorization_decision_id") REFERENCES "cg_decision_logs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_preferences" ADD CONSTRAINT "cg_preferences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_preferences" ADD CONSTRAINT "cg_preferences_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_preferences" ADD CONSTRAINT "cg_preferences_tenant_id_identity_id_fkey" FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "contact_identities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_preferences" ADD CONSTRAINT "cg_preferences_tenant_id_supersedes_id_fkey" FOREIGN KEY ("tenant_id", "supersedes_id") REFERENCES "cg_preferences"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_policies" ADD CONSTRAINT "cg_policies_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_holiday_calendar_entries" ADD CONSTRAINT "cg_holiday_calendar_entries_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_holiday_calendar_entries" ADD CONSTRAINT "cg_holiday_calendar_entries_tenant_id_policy_id_policy_ver_fkey" FOREIGN KEY ("tenant_id", "policy_id", "policy_version") REFERENCES "cg_policies"("tenant_id", "policy_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_callback_requests" ADD CONSTRAINT "cg_callback_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_callback_requests" ADD CONSTRAINT "cg_callback_requests_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_callback_requests" ADD CONSTRAINT "cg_callback_requests_tenant_id_identity_id_fkey" FOREIGN KEY ("tenant_id", "identity_id") REFERENCES "contact_identities"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_callback_requests" ADD CONSTRAINT "cg_callback_requests_tenant_id_supersedes_id_fkey" FOREIGN KEY ("tenant_id", "supersedes_id") REFERENCES "cg_callback_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_contact_state_heads" ADD CONSTRAINT "cg_contact_state_heads_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_contact_state_heads" ADD CONSTRAINT "cg_contact_state_heads_tenant_id_contact_id_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_event_outbox" ADD CONSTRAINT "cg_event_outbox_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_command_receipts" ADD CONSTRAINT "cg_command_receipts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_audit_logs" ADD CONSTRAINT "cg_audit_logs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cg_consumer_acknowledgements" ADD CONSTRAINT "cg_consumer_acknowledgements_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Existing C1 rows are checked before these tenant-bound constraints become authoritative.
ALTER TABLE "cg_restrictions" VALIDATE CONSTRAINT "cg_restrictions_tenant_contact_fkey";
ALTER TABLE "cg_restrictions" VALIDATE CONSTRAINT "cg_restrictions_tenant_identity_fkey";
ALTER TABLE "cg_consents" VALIDATE CONSTRAINT "cg_consents_tenant_contact_fkey";
ALTER TABLE "cg_consents" VALIDATE CONSTRAINT "cg_consents_tenant_identity_fkey";

-- New canonical tables are tenant-isolated from their first writable deployment.
ALTER TABLE "cg_preferences" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_policies" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_holiday_calendar_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_callback_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_contact_state_heads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_event_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_command_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_audit_logs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_consumer_acknowledgements" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "cg_preferences"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_policies"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_holiday_calendar_entries"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_callback_requests"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_contact_state_heads"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_event_outbox"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_command_receipts"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_audit_logs"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg_consumer_acknowledgements"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON
  "cg_preferences", "cg_policies", "cg_holiday_calendar_entries",
  "cg_callback_requests", "cg_contact_state_heads", "cg_event_outbox",
  "cg_command_receipts", "cg_audit_logs", "cg_consumer_acknowledgements"
TO dcontact_app;

REVOKE UPDATE, DELETE ON
  "cg_preferences", "cg_holiday_calendar_entries", "cg_callback_requests",
  "cg_command_receipts", "cg_audit_logs", "cg_consumer_acknowledgements"
FROM dcontact_app;
REVOKE DELETE ON "cg_policies", "cg_contact_state_heads", "cg_event_outbox" FROM dcontact_app;
