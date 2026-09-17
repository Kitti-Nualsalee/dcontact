-- J2.8 (#136): the frozen J2.1 owner contract requires CANCEL_x/SUPERSEDE_x to
-- reuse the positive effect's actionKey with a new commandId. A receipt per
-- actionKey made every contract-conformant cancel collide with its original as
-- IDEMPOTENCY_CONFLICT, so receipt identity moves to (tenant, command_id).
DROP INDEX "ob_dialer_command_inbox_tenant_action_key";
DROP INDEX "ob_dialer_command_inbox_tenant_command_idx";
CREATE UNIQUE INDEX "ob_dialer_command_inbox_tenant_command_key"
  ON "ob_dialer_command_inbox"("tenant_id", "command_id");
CREATE INDEX "ob_dialer_command_inbox_tenant_action_idx"
  ON "ob_dialer_command_inbox"("tenant_id", "action_key", "command_type");

-- Campaign targets become cancellable/supersedable before the originate barrier.
ALTER TYPE "ObCampaignTargetState" ADD VALUE IF NOT EXISTS 'CANCELLED';
ALTER TYPE "ObCampaignTargetState" ADD VALUE IF NOT EXISTS 'SUPERSEDED';
ALTER TABLE "ob_campaign_targets"
  ADD COLUMN "cancelled_at" TIMESTAMP(3),
  ADD COLUMN "cancel_reason_code" TEXT,
  ADD COLUMN "superseded_at" TIMESTAMP(3),
  ADD COLUMN "superseding_outcome_type" TEXT,
  ADD COLUMN "superseding_outcome_id" UUID,
  ADD COLUMN "superseding_outcome_version" INTEGER;
