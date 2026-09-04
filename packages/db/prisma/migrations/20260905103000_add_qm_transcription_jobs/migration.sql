CREATE TYPE "QueueTranscriptionMode" AS ENUM ('OFF', 'AUTOMATIC', 'MANUAL');
CREATE TYPE "QmTranscriptionStatus" AS ENUM ('PENDING', 'PROCESSING', 'READY', 'FAILED');
CREATE TYPE "QmTranscriptionTrigger" AS ENUM ('AUTOMATIC', 'MANUAL');
CREATE TYPE "QmAuditAction" AS ENUM ('TRANSCRIPTION_REQUESTED');

ALTER TABLE "queues"
  ADD COLUMN "transcription_mode" "QueueTranscriptionMode" NOT NULL DEFAULT 'OFF',
  ADD COLUMN "transcription_language" TEXT NOT NULL DEFAULT 'th-TH',
  ADD COLUMN "transcription_max_attempts" INTEGER NOT NULL DEFAULT 3,
  ADD COLUMN "auto_qm_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "qm_transcription_jobs" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "interaction_id" UUID NOT NULL,
  "recording_id" UUID NOT NULL,
  "source_event_id" UUID,
  "status" "QmTranscriptionStatus" NOT NULL DEFAULT 'PENDING',
  "trigger" "QmTranscriptionTrigger" NOT NULL,
  "language_hint" TEXT NOT NULL,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "max_attempts" INTEGER NOT NULL,
  "next_attempt_at" TIMESTAMPTZ,
  "dispatched_at" TIMESTAMPTZ,
  "failure_code" TEXT,
  "failure_reason" TEXT,
  "provider_id" TEXT,
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "qm_transcription_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qm_transcription_jobs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_transcription_jobs_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_transcription_jobs_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "qm_transcription_jobs_tenant_id_interaction_id_key"
  ON "qm_transcription_jobs"("tenant_id", "interaction_id");
CREATE INDEX "qm_transcription_jobs_status_next_attempt_at_created_at_idx"
  ON "qm_transcription_jobs"("status", "next_attempt_at", "created_at");
CREATE INDEX "qm_transcription_jobs_tenant_id_status_created_at_idx"
  ON "qm_transcription_jobs"("tenant_id", "status", "created_at");

CREATE TABLE "qm_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "action" "QmAuditAction" NOT NULL,
  "resource_type" TEXT NOT NULL,
  "resource_id" UUID NOT NULL,
  "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qm_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qm_audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "qm_audit_events_tenant_id_resource_type_resource_id_created_at_idx"
  ON "qm_audit_events"("tenant_id", "resource_type", "resource_id", "created_at");

ALTER TABLE "qm_transcription_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qm_audit_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "qm_transcription_jobs"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "qm_audit_events"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "qm_transcription_jobs", "qm_audit_events" TO dcontact_app;
REVOKE UPDATE, DELETE ON "qm_audit_events" FROM dcontact_app;
