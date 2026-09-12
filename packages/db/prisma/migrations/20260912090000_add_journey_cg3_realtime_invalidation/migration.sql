-- S1.5: Journey-owned CG3 realtime invalidation boundary.  These rows are
-- tenant-local ledgers/outboxes; Contact Governance remains the writer of
-- policy, reservation and delivery-settlement facts.

CREATE TYPE "JrRealtimeActionState" AS ENUM (
  'QUEUED', 'RESERVED', 'PRE_BARRIER', 'POST_BARRIER', 'ACCEPTED',
  'CANCELLED', 'DEFERRED', 'PARKED', 'HELD', 'CANCEL_REQUESTED', 'SETTLED'
);

CREATE TYPE "JrGovernanceConsumerState" AS ENUM ('APPLIED', 'NO_OP', 'GAP', 'QUARANTINED');
CREATE TYPE "JrGovernanceAcknowledgementState" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');

ALTER TABLE "jr_actions"
  ADD COLUMN "realtime_state" "JrRealtimeActionState" NOT NULL DEFAULT 'RESERVED',
  ADD COLUMN "next_eligible_at" TIMESTAMP(3),
  ADD COLUMN "applied_aggregate_version" INTEGER,
  ADD COLUMN "applied_payload_hash" TEXT,
  ADD COLUMN "delivery_id" UUID,
  ADD COLUMN "provider_request_key" TEXT,
  ADD COLUMN "cancel_requested_at" TIMESTAMP(3),
  ADD CONSTRAINT "jr_actions_applied_aggregate_version_check"
    CHECK ("applied_aggregate_version" IS NULL OR "applied_aggregate_version" > 0);

CREATE INDEX "jr_actions_tenant_contact_realtime_state_idx"
  ON "jr_actions"("tenant_id", "contact_id", "realtime_state");

CREATE TABLE "jr_governance_consumer_inbox" (
  "id" UUID NOT NULL,
  "consumer" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "aggregate_type" "CgAggregateType" NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "aggregate_version" INTEGER NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "state" "JrGovernanceConsumerState" NOT NULL,
  "affected_count" INTEGER NOT NULL DEFAULT 0,
  "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "jr_governance_consumer_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_governance_consumer_inbox_version_check" CHECK ("aggregate_version" > 0),
  CONSTRAINT "jr_governance_consumer_inbox_affected_count_check" CHECK ("affected_count" >= 0)
);

CREATE UNIQUE INDEX "jr_governance_consumer_inbox_consumer_tenant_event_key"
  ON "jr_governance_consumer_inbox"("consumer", "tenant_id", "event_id");
CREATE UNIQUE INDEX "jr_governance_consumer_inbox_aggregate_version_hash_key"
  ON "jr_governance_consumer_inbox"("consumer", "tenant_id", "aggregate_type", "aggregate_id", "aggregate_version", "payload_hash");
CREATE INDEX "jr_governance_consumer_inbox_aggregate_idx"
  ON "jr_governance_consumer_inbox"("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version");

CREATE TABLE "jr_governance_acknowledgement_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "consumer" TEXT NOT NULL,
  "aggregate_type" "CgAggregateType" NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "applied_version" INTEGER NOT NULL,
  "outcome" "CgConsumerAckOutcome" NOT NULL,
  "affected_count" INTEGER NOT NULL DEFAULT 0,
  "source_payload_hash" TEXT NOT NULL,
  "state" "JrGovernanceAcknowledgementState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "jr_governance_acknowledgement_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_governance_acknowledgement_outbox_version_check" CHECK ("applied_version" > 0),
  CONSTRAINT "jr_governance_acknowledgement_outbox_affected_count_check" CHECK ("affected_count" >= 0),
  CONSTRAINT "jr_governance_acknowledgement_outbox_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "jr_governance_acknowledgement_outbox_event_key"
  ON "jr_governance_acknowledgement_outbox"("tenant_id", "event_id", "consumer", "applied_version");
CREATE INDEX "jr_governance_acknowledgement_outbox_ready_idx"
  ON "jr_governance_acknowledgement_outbox"("tenant_id", "state", "available_at");

ALTER TABLE "jr_governance_consumer_inbox"
  ADD CONSTRAINT "jr_governance_consumer_inbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_governance_acknowledgement_outbox"
  ADD CONSTRAINT "jr_governance_acknowledgement_outbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_governance_consumer_inbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_governance_consumer_inbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_governance_acknowledgement_outbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_governance_acknowledgement_outbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "jr_governance_consumer_inbox" TO dcontact_app;
REVOKE DELETE ON "jr_governance_consumer_inbox" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "jr_governance_acknowledgement_outbox" TO dcontact_app;
REVOKE DELETE ON "jr_governance_acknowledgement_outbox" FROM dcontact_app;
