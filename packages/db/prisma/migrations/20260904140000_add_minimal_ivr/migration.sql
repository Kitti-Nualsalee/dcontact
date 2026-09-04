ALTER TYPE "VoiceDestinationEntryMode" ADD VALUE 'IVR';

CREATE TYPE "IvrInputStage" AS ENUM ('VOICE', 'DTMF');

ALTER TABLE "voice_destinations"
  ADD COLUMN "ivr_config" JSONB;

ALTER TABLE "interactions"
  ADD COLUMN "ivr_destination_id" UUID,
  ADD COLUMN "ivr_stage" "IvrInputStage",
  ADD COLUMN "ivr_attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "ivr_input_expires_at" TIMESTAMP(3);

CREATE INDEX "interactions_tenant_id_ivr_input_expires_at_idx"
  ON "interactions"("tenant_id", "ivr_input_expires_at");
