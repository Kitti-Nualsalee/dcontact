ALTER TABLE "queues"
  ADD COLUMN "recording_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recording_announcement" TEXT,
  ADD COLUMN "recording_announcement_language" TEXT,
  ADD COLUMN "recording_pause_resume_enabled" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recording_agent_self_access" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recording_download_allowed" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "recording_retention_days" INTEGER;
