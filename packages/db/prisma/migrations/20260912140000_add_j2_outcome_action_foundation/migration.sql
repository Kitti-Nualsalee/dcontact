-- J2.3: Journey-owned outcome receipt/head, owner action, command outbox, result
-- inbox and recovery audit foundation. Schema/primitives only — no trigger matching,
-- owner implementation or relay transport yet (see issue #131).

CREATE TYPE "JrOutcomeReceiptState" AS ENUM (
  'RECEIVED', 'WAITING_FOR_GAP', 'READY', 'PROCESSING', 'APPLIED',
  'IGNORED_SUPERSEDED', 'REVIEW', 'QUARANTINED'
);

CREATE TYPE "JrOwnerActionKind" AS ENUM ('ENSURE_CASE', 'ADMIT_CAMPAIGN_TARGET', 'SCHEDULE_CALLBACK');

CREATE TYPE "JrOwnerActionState" AS ENUM (
  'PENDING', 'DISPATCHED', 'ACKNOWLEDGED', 'REJECTED', 'ACK_UNKNOWN',
  'CANCEL_REQUESTED', 'CANCELLED', 'TOO_LATE', 'RECONCILING'
);

CREATE TYPE "JrOwnerCommandState" AS ENUM ('PENDING', 'SENT', 'FAILED');

CREATE TYPE "JrOwnerResultKind" AS ENUM (
  'ACKNOWLEDGED', 'REJECTED', 'ACK_UNKNOWN', 'CANCELLED', 'TOO_LATE', 'RECONCILING'
);

CREATE TYPE "JrOwnerResultOutcome" AS ENUM ('APPLIED', 'DUPLICATE', 'CONFLICT');

CREATE TYPE "JrRecoveryOperation" AS ENUM ('REPLAY', 'RECONCILE', 'CANCEL', 'SKIP_QUARANTINE');

CREATE TYPE "JrRecoveryTargetKind" AS ENUM ('RECEIPT', 'ACTION');

CREATE TABLE "jr_outcome_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "outcome_type" TEXT NOT NULL,
  "outcome_id" UUID NOT NULL,
  "outcome_version" INTEGER NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "state" "JrOutcomeReceiptState" NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "review_reason_code" TEXT,
  "last_error" TEXT,
  "correlation_id" TEXT NOT NULL,
  "causation_id" TEXT,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_at" TIMESTAMP(3),

  CONSTRAINT "jr_outcome_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_outcome_receipts_version_check" CHECK ("outcome_version" > 0),
  CONSTRAINT "jr_outcome_receipts_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "jr_outcome_receipts_tenant_source_event_key"
  ON "jr_outcome_receipts"("tenant_id", "source", "event_id");
CREATE UNIQUE INDEX "jr_outcome_receipts_tenant_outcome_version_key"
  ON "jr_outcome_receipts"("tenant_id", "outcome_type", "outcome_id", "outcome_version");
CREATE INDEX "jr_outcome_receipts_ready_idx"
  ON "jr_outcome_receipts"("tenant_id", "state", "available_at");

CREATE TABLE "jr_outcome_heads" (
  "tenant_id" UUID NOT NULL,
  "outcome_type" TEXT NOT NULL,
  "outcome_id" UUID NOT NULL,
  "last_applied_version" INTEGER NOT NULL DEFAULT 0,
  "last_applied_receipt_id" UUID,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "jr_outcome_heads_pkey" PRIMARY KEY ("tenant_id", "outcome_type", "outcome_id"),
  CONSTRAINT "jr_outcome_heads_version_check" CHECK ("last_applied_version" >= 0)
);

CREATE TABLE "jr_owner_actions" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "action_key" TEXT NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "outcome_receipt_id" UUID,
  "kind" "JrOwnerActionKind" NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "state" "JrOwnerActionState" NOT NULL DEFAULT 'PENDING',
  "owner_aggregate_ref" TEXT,
  "owner_aggregate_version" INTEGER,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "dispatched_at" TIMESTAMP(3),
  "acknowledged_at" TIMESTAMP(3),
  "cancel_requested_at" TIMESTAMP(3),
  "last_error" TEXT,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "jr_owner_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_owner_actions_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "jr_owner_actions_tenant_action_key"
  ON "jr_owner_actions"("tenant_id", "action_key");
CREATE INDEX "jr_owner_actions_tenant_enrollment_idx"
  ON "jr_owner_actions"("tenant_id", "enrollment_id");
CREATE INDEX "jr_owner_actions_tenant_state_idx"
  ON "jr_owner_actions"("tenant_id", "state");

CREATE TABLE "jr_owner_command_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "command_id" TEXT NOT NULL,
  "action_id" UUID NOT NULL,
  "action_key" TEXT NOT NULL,
  "kind" "JrOwnerActionKind" NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "state" "JrOwnerCommandState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "jr_owner_command_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_owner_command_outbox_attempts_check" CHECK ("attempts" >= 0)
);

CREATE UNIQUE INDEX "jr_owner_command_outbox_tenant_command_key"
  ON "jr_owner_command_outbox"("tenant_id", "command_id");
CREATE INDEX "jr_owner_command_outbox_ready_idx"
  ON "jr_owner_command_outbox"("tenant_id", "state", "available_at");

CREATE TABLE "jr_owner_result_inbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "command_id" TEXT NOT NULL,
  "action_key" TEXT NOT NULL,
  "result_kind" "JrOwnerResultKind" NOT NULL,
  "owner_aggregate_ref" TEXT,
  "owner_aggregate_version" INTEGER,
  "result_hash" CHAR(64) NOT NULL,
  "outcome" "JrOwnerResultOutcome" NOT NULL DEFAULT 'APPLIED',
  "correlation_id" TEXT NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "jr_owner_result_inbox_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "jr_owner_result_inbox_tenant_command_key"
  ON "jr_owner_result_inbox"("tenant_id", "command_id");
CREATE INDEX "jr_owner_result_inbox_tenant_action_key_idx"
  ON "jr_owner_result_inbox"("tenant_id", "action_key");

CREATE TABLE "jr_recovery_audit" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "operation" "JrRecoveryOperation" NOT NULL,
  "target_kind" "JrRecoveryTargetKind" NOT NULL,
  "target_ref" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "actor_id" UUID NOT NULL,
  "evidence_ref" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "jr_recovery_audit_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "jr_recovery_audit_tenant_target_idx"
  ON "jr_recovery_audit"("tenant_id", "target_kind", "target_ref", "occurred_at");

ALTER TABLE "jr_outcome_receipts"
  ADD CONSTRAINT "jr_outcome_receipts_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_outcome_heads"
  ADD CONSTRAINT "jr_outcome_heads_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_owner_actions"
  ADD CONSTRAINT "jr_owner_actions_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_owner_command_outbox"
  ADD CONSTRAINT "jr_owner_command_outbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_owner_result_inbox"
  ADD CONSTRAINT "jr_owner_result_inbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_recovery_audit"
  ADD CONSTRAINT "jr_recovery_audit_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_outcome_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_outcome_receipts"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_outcome_heads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_outcome_heads"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_owner_actions" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_owner_actions"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_owner_command_outbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_owner_command_outbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_owner_result_inbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_owner_result_inbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_recovery_audit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_recovery_audit"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- receipt/head/action/command/result มี legitimate state transition ผ่าน app role
GRANT SELECT, INSERT, UPDATE ON
  "jr_outcome_receipts", "jr_outcome_heads", "jr_owner_actions",
  "jr_owner_command_outbox", "jr_owner_result_inbox"
TO dcontact_app;
REVOKE DELETE ON
  "jr_outcome_receipts", "jr_outcome_heads", "jr_owner_actions",
  "jr_owner_command_outbox", "jr_owner_result_inbox"
FROM dcontact_app;

-- recovery audit เป็น append-only เท่านั้น — application role แก้ history โดยตรงไม่ได้
GRANT SELECT, INSERT ON "jr_recovery_audit" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_recovery_audit" FROM dcontact_app;
