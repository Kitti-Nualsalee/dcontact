ALTER TYPE "QmAuditAction" ADD VALUE IF NOT EXISTS 'AUTO_QM_DRAFT_CREATED';
CREATE TYPE "QmTranscriptSpeaker" AS ENUM ('AGENT', 'CONTACT', 'SYSTEM', 'IVR');
CREATE TYPE "QmEvaluationSource" AS ENUM ('AUTO_DRAFT', 'HUMAN');
CREATE TYPE "QmEvaluationStatus" AS ENUM ('DRAFT', 'PUBLISHED');

CREATE TABLE "qm_transcripts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "interaction_id" UUID NOT NULL,
  "recording_id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "provider_id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "language" TEXT NOT NULL,
  "confidence_avg" DOUBLE PRECISION NOT NULL,
  "baseline" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "qm_transcripts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qm_transcripts_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_transcripts_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_transcripts_recording_id_fkey" FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_transcripts_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "qm_transcription_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "qm_transcripts_job_id_key" ON "qm_transcripts"("job_id");
CREATE UNIQUE INDEX "qm_transcripts_tenant_id_interaction_id_provider_id_model_id_key"
  ON "qm_transcripts"("tenant_id", "interaction_id", "provider_id", "model_id");
CREATE INDEX "qm_transcripts_tenant_id_interaction_id_created_at_idx"
  ON "qm_transcripts"("tenant_id", "interaction_id", "created_at");

CREATE TABLE "qm_transcript_segments" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "transcript_id" UUID NOT NULL,
  "speaker" "QmTranscriptSpeaker" NOT NULL,
  "start_ms" INTEGER NOT NULL,
  "end_ms" INTEGER NOT NULL,
  "text" TEXT NOT NULL,
  "confidence" DOUBLE PRECISION,
  CONSTRAINT "qm_transcript_segments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qm_transcript_segments_transcript_id_fkey" FOREIGN KEY ("transcript_id") REFERENCES "qm_transcripts"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "qm_transcript_segments_tenant_id_transcript_id_start_ms_idx"
  ON "qm_transcript_segments"("tenant_id", "transcript_id", "start_ms");

CREATE TABLE "qm_evaluations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "interaction_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "evaluator_id" UUID,
  "source" "QmEvaluationSource" NOT NULL DEFAULT 'AUTO_DRAFT',
  "status" "QmEvaluationStatus" NOT NULL DEFAULT 'DRAFT',
  "provider_id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "prompt_version" TEXT NOT NULL,
  "answers" JSONB NOT NULL,
  "published_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL,
  CONSTRAINT "qm_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "qm_evaluations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "qm_evaluations_interaction_id_fkey" FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "qm_evaluations_tenant_id_interaction_id_source_key"
  ON "qm_evaluations"("tenant_id", "interaction_id", "source");
CREATE INDEX "qm_evaluations_tenant_id_agent_id_status_idx"
  ON "qm_evaluations"("tenant_id", "agent_id", "status");

ALTER TABLE "qm_transcripts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qm_transcript_segments" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "qm_evaluations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "qm_transcripts"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "qm_transcript_segments"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "qm_evaluations"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "qm_transcripts", "qm_transcript_segments", "qm_evaluations" TO dcontact_app;
