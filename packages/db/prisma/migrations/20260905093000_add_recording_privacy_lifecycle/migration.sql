CREATE TYPE "RecordingChannelLayout" AS ENUM ('PER_LEG', 'STEREO');
CREATE TYPE "RecordingAuditAction" AS ENUM (
  'PAUSED', 'RESUMED', 'PLAYBACK_URL_ISSUED', 'PLAYBACK_ACCESSED', 'DOWNLOAD_DENIED',
  'RETENTION_DELETED', 'LEGAL_HOLD_PLACED', 'LEGAL_HOLD_RELEASED'
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') THEN
    CREATE ROLE dcontact_app LOGIN PASSWORD 'dcontact_app' NOBYPASSRLS;
  END IF;
END $$;

ALTER TABLE "recordings"
  ADD COLUMN "telephony_path" TEXT NOT NULL DEFAULT '',
  ADD COLUMN "channel_layout" "RecordingChannelLayout" NOT NULL DEFAULT 'STEREO',
  ADD COLUMN "pause_intervals" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN "deleted_at" TIMESTAMPTZ;

CREATE INDEX "recordings_tenant_id_deleted_at_idx" ON "recordings"("tenant_id", "deleted_at");

CREATE TABLE "recording_audit_events" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "recording_id" UUID NOT NULL,
  "actor_user_id" UUID,
  "action" "RecordingAuditAction" NOT NULL,
  "reason" TEXT,
  "details" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recording_audit_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recording_audit_events_recording_id_fkey"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "recording_audit_events_tenant_id_recording_id_created_at_idx"
  ON "recording_audit_events"("tenant_id", "recording_id", "created_at");

CREATE TABLE "recording_legal_holds" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "recording_id" UUID NOT NULL,
  "reason" TEXT NOT NULL,
  "placed_by_user_id" UUID NOT NULL,
  "placed_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "released_by_user_id" UUID,
  "released_at" TIMESTAMPTZ,
  CONSTRAINT "recording_legal_holds_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recording_legal_holds_recording_id_fkey"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "recording_legal_holds_tenant_id_recording_id_released_at_idx"
  ON "recording_legal_holds"("tenant_id", "recording_id", "released_at");

ALTER TABLE "recording_audit_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "recording_legal_holds" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "recording_audit_events"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "recording_legal_holds"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "recording_audit_events", "recording_legal_holds" TO dcontact_app;
REVOKE UPDATE, DELETE ON "recording_audit_events" FROM dcontact_app;
