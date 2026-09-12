-- S1.7: Dialer เป็นเจ้าของ consumer และ raw outbound attempt ของตนเอง;
-- Contact Governance ยังคงเป็นผู้เขียน canonical ของ preference, policy,
-- reservation, attempt/touch และ settlement เพียงผู้เดียว.

CREATE TYPE "ObAttemptRealtimeState" AS ENUM (
  'QUEUED', 'RESERVED', 'PRE_BARRIER', 'POST_BARRIER', 'ACCEPTED', 'IN_PROGRESS',
  'CANCELLED', 'DEFERRED', 'PARKED', 'HELD', 'CANCEL_REQUESTED', 'SETTLED'
);
CREATE TYPE "ObGovernanceConsumerState" AS ENUM ('APPLIED', 'NO_OP', 'GAP', 'QUARANTINED');
CREATE TYPE "ObGovernanceAcknowledgementState" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');
CREATE TYPE "ObGovernanceEffectState" AS ENUM ('PENDING', 'PROCESSING', 'SUCCEEDED', 'FAILED');
CREATE TYPE "ObGovernanceEffectKind" AS ENUM ('RELEASE_BEFORE_BARRIER', 'REQUEST_RECONCILE');

CREATE TABLE "ob_attempts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "action_key" TEXT NOT NULL,
  "contact_id" UUID NOT NULL,
  "identity_id" UUID NOT NULL,
  "channel" "ChannelType" NOT NULL,
  "purpose" TEXT NOT NULL,
  "reservation_id" UUID NOT NULL,
  "realtime_state" "ObAttemptRealtimeState" NOT NULL DEFAULT 'RESERVED',
  "next_eligible_at" TIMESTAMP(3),
  "applied_aggregate_version" INTEGER,
  "applied_payload_hash" TEXT,
  "delivery_id" UUID,
  "provider_request_key" TEXT,
  "cancel_requested_at" TIMESTAMP(3),
  "next_outbound_blocked" BOOLEAN NOT NULL DEFAULT false,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ob_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ob_attempts_applied_aggregate_version_check"
    CHECK ("applied_aggregate_version" IS NULL OR "applied_aggregate_version" > 0)
);
CREATE UNIQUE INDEX "ob_attempts_tenant_action_key_key" ON "ob_attempts"("tenant_id", "action_key");
CREATE INDEX "ob_attempts_tenant_contact_realtime_state_idx"
  ON "ob_attempts"("tenant_id", "contact_id", "realtime_state");
ALTER TABLE "ob_attempts" ADD CONSTRAINT "ob_attempts_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ob_governance_consumer_inbox" (
  "id" UUID NOT NULL,
  "consumer" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "aggregate_type" "CgAggregateType" NOT NULL,
  "aggregate_id" UUID NOT NULL,
  "aggregate_version" INTEGER NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "state" "ObGovernanceConsumerState" NOT NULL,
  "affected_count" INTEGER NOT NULL DEFAULT 0,
  "applied_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ob_governance_consumer_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ob_governance_consumer_inbox_version_check" CHECK ("aggregate_version" > 0),
  CONSTRAINT "ob_governance_consumer_inbox_affected_count_check" CHECK ("affected_count" >= 0)
);
CREATE UNIQUE INDEX "ob_governance_consumer_inbox_consumer_tenant_event_key"
  ON "ob_governance_consumer_inbox"("consumer", "tenant_id", "event_id");
CREATE UNIQUE INDEX "ob_governance_consumer_inbox_aggregate_version_hash_key"
  ON "ob_governance_consumer_inbox"("consumer", "tenant_id", "aggregate_type", "aggregate_id", "aggregate_version", "payload_hash");
CREATE INDEX "ob_governance_consumer_inbox_aggregate_idx"
  ON "ob_governance_consumer_inbox"("tenant_id", "aggregate_type", "aggregate_id", "aggregate_version");
ALTER TABLE "ob_governance_consumer_inbox" ADD CONSTRAINT "ob_governance_consumer_inbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ob_governance_acknowledgement_outbox" (
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
  "state" "ObGovernanceAcknowledgementState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ob_governance_acknowledgement_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ob_governance_acknowledgement_outbox_version_check" CHECK ("applied_version" > 0),
  CONSTRAINT "ob_governance_acknowledgement_outbox_affected_count_check" CHECK ("affected_count" >= 0),
  CONSTRAINT "ob_governance_acknowledgement_outbox_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "ob_governance_acknowledgement_outbox_event_key"
  ON "ob_governance_acknowledgement_outbox"("tenant_id", "event_id", "consumer", "applied_version");
CREATE INDEX "ob_governance_acknowledgement_outbox_ready_idx"
  ON "ob_governance_acknowledgement_outbox"("tenant_id", "state", "available_at");
ALTER TABLE "ob_governance_acknowledgement_outbox" ADD CONSTRAINT "ob_governance_acknowledgement_outbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "ob_governance_effect_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "attempt_id" UUID NOT NULL,
  "action_key" TEXT NOT NULL,
  "reservation_id" UUID NOT NULL,
  "delivery_id" UUID,
  "provider_request_key" TEXT,
  "correlation_id" TEXT NOT NULL,
  "kind" "ObGovernanceEffectKind" NOT NULL,
  "state" "ObGovernanceEffectState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ob_governance_effect_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ob_governance_effect_outbox_attempts_check" CHECK ("attempts" >= 0)
);
CREATE UNIQUE INDEX "ob_governance_effect_outbox_event_attempt_kind_key"
  ON "ob_governance_effect_outbox"("tenant_id", "event_id", "attempt_id", "kind");
CREATE INDEX "ob_governance_effect_outbox_ready_idx"
  ON "ob_governance_effect_outbox"("tenant_id", "state", "available_at");
ALTER TABLE "ob_governance_effect_outbox" ADD CONSTRAINT "ob_governance_effect_outbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "ob_attempts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ob_governance_consumer_inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ob_governance_acknowledgement_outbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ob_governance_effect_outbox" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "ob_attempts"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "ob_governance_consumer_inbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "ob_governance_acknowledgement_outbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "ob_governance_effect_outbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "ob_attempts" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "ob_governance_consumer_inbox" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "ob_governance_acknowledgement_outbox" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "ob_governance_effect_outbox" TO dcontact_app;
REVOKE DELETE ON "ob_attempts" FROM dcontact_app;
REVOKE DELETE ON "ob_governance_consumer_inbox" FROM dcontact_app;
REVOKE DELETE ON "ob_governance_acknowledgement_outbox" FROM dcontact_app;
REVOKE DELETE ON "ob_governance_effect_outbox" FROM dcontact_app;
