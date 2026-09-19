-- CreateEnum
CREATE TYPE "Cg5Granularity" AS ENUM ('FIVE_MIN', 'HOUR', 'DAY');

-- CreateEnum
CREATE TYPE "Cg5AlertStatus" AS ENUM ('OPEN', 'ACKED', 'RESOLVED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "Cg5ExportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED', 'REVOKED');

-- CreateTable
CREATE TABLE "cg5_metric_bucket" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "metric_key" TEXT NOT NULL,
    "granularity" "Cg5Granularity" NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "channel" TEXT,
    "purpose" TEXT,
    "decision" TEXT,
    "gate" TEXT,
    "reason_code" TEXT,
    "team_id" UUID,
    "dimension_key" CHAR(64) NOT NULL,
    "value" DECIMAL(30,8) NOT NULL,
    "sample_count" BIGINT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cg5_metric_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cg5_policy_impact_bucket" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "granularity" "Cg5Granularity" NOT NULL,
    "bucket_start" TIMESTAMP(3) NOT NULL,
    "policy_version" INTEGER NOT NULL,
    "decision" TEXT NOT NULL,
    "value" BIGINT NOT NULL,

    CONSTRAINT "cg5_policy_impact_bucket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cg5_projection_cursor" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "source_key" TEXT NOT NULL,
    "last_processed_at" TIMESTAMP(3),
    "last_processed_id" TEXT,
    "state" TEXT NOT NULL,
    "last_run_at" TIMESTAMP(3),

    CONSTRAINT "cg5_projection_cursor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cg5_alert_state" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "rule_code" TEXT NOT NULL,
    "scope_key" CHAR(64) NOT NULL,
    "channel" TEXT,
    "purpose" TEXT,
    "team_id" UUID,
    "severity" TEXT NOT NULL,
    "state" "Cg5AlertStatus" NOT NULL,
    "value" DECIMAL(30,8) NOT NULL,
    "threshold" DECIMAL(30,8) NOT NULL,
    "baseline_ref" TEXT,
    "consecutive_hits" INTEGER NOT NULL,
    "opened_at" TIMESTAMP(3),
    "acked_at" TIMESTAMP(3),
    "acked_by_ref" TEXT,
    "resolved_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cg5_alert_state_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cg5_alert_transition" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "alert_id" UUID NOT NULL,
    "from_state" "Cg5AlertStatus",
    "to_state" "Cg5AlertStatus" NOT NULL,
    "from_version" INTEGER NOT NULL,
    "to_version" INTEGER NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "state_digest" CHAR(64) NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cg5_alert_transition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cg5_export_job" (
    "export_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "datasets" TEXT[] NOT NULL,
    "range_from" TIMESTAMP(3) NOT NULL,
    "range_to" TIMESTAMP(3) NOT NULL,
    "filters" JSONB NOT NULL,
    "evidence_level" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requested_by_ref" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "state" "Cg5ExportStatus" NOT NULL DEFAULT 'QUEUED',
    "manifest_digest" CHAR(64),
    "rowCounts" JSONB,
    "storage_prefix" TEXT,
    "expires_at" TIMESTAMP(3),
    "version" INTEGER NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cg5_export_job_pkey" PRIMARY KEY ("export_id")
);

-- CreateTable
CREATE TABLE "cg5_tenant_config" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "config" JSONB NOT NULL,
    "version" INTEGER NOT NULL,
    "updated_by_ref" TEXT NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cg5_tenant_config_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cg5_tenant_config_audit" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "expected_version" INTEGER NOT NULL,
    "actual_version" INTEGER NOT NULL,
    "resulting_version" INTEGER NOT NULL,
    "before_digest" CHAR(64) NOT NULL,
    "requested_digest" CHAR(64) NOT NULL,
    "after_digest" CHAR(64) NOT NULL,
    "actor_ref" TEXT NOT NULL,
    "evidence_ref" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cg5_tenant_config_audit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "cg5_metric_bucket_query_idx" ON "cg5_metric_bucket"("tenant_id", "metric_key", "granularity", "bucket_start");

-- CreateIndex
CREATE INDEX "cg5_metric_bucket_retention_idx" ON "cg5_metric_bucket"("tenant_id", "granularity", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "cg5_metric_bucket_dimensions_key" ON "cg5_metric_bucket"("tenant_id", "metric_key", "granularity", "bucket_start", "dimension_key");

-- CreateIndex
CREATE INDEX "cg5_policy_impact_bucket_retention_idx" ON "cg5_policy_impact_bucket"("tenant_id", "granularity", "bucket_start");

-- CreateIndex
CREATE UNIQUE INDEX "cg5_policy_impact_bucket_dimensions_key" ON "cg5_policy_impact_bucket"("tenant_id", "granularity", "bucket_start", "policy_version", "decision");

-- CreateIndex
CREATE UNIQUE INDEX "cg5_projection_cursor_tenant_id_source_key_key" ON "cg5_projection_cursor"("tenant_id", "source_key");

-- CreateIndex
CREATE INDEX "cg5_alert_state_query_idx" ON "cg5_alert_state"("tenant_id", "state", "severity", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "cg5_alert_state_tenant_id_id_key" ON "cg5_alert_state"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "cg5_alert_state_tenant_id_rule_code_scope_key_key" ON "cg5_alert_state"("tenant_id", "rule_code", "scope_key");

-- CreateIndex
CREATE INDEX "cg5_alert_transition_tenant_id_occurred_at_idx" ON "cg5_alert_transition"("tenant_id", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "cg5_alert_transition_tenant_id_alert_id_to_version_key" ON "cg5_alert_transition"("tenant_id", "alert_id", "to_version");

-- CreateIndex
CREATE INDEX "cg5_export_job_tenant_id_created_at_idx" ON "cg5_export_job"("tenant_id", "created_at");

-- CreateIndex
CREATE INDEX "cg5_export_job_tenant_id_state_expires_at_idx" ON "cg5_export_job"("tenant_id", "state", "expires_at");

-- CreateIndex
CREATE UNIQUE INDEX "cg5_export_job_tenant_id_idempotency_key_key" ON "cg5_export_job"("tenant_id", "idempotency_key");

-- CreateIndex
CREATE UNIQUE INDEX "cg5_tenant_config_tenant_id_key" ON "cg5_tenant_config"("tenant_id");

-- CreateIndex
CREATE INDEX "cg5_tenant_config_audit_tenant_id_occurred_at_idx" ON "cg5_tenant_config_audit"("tenant_id", "occurred_at");


ALTER TABLE "cg5_metric_bucket" ADD CONSTRAINT "cg5_metric_bucket_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_metric_bucket" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg5_metric_bucket" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cg5_metric_bucket" TO dcontact_app;

ALTER TABLE "cg5_policy_impact_bucket" ADD CONSTRAINT "cg5_policy_impact_bucket_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_policy_impact_bucket" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg5_policy_impact_bucket" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cg5_policy_impact_bucket" TO dcontact_app;

ALTER TABLE "cg5_projection_cursor" ADD CONSTRAINT "cg5_projection_cursor_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_projection_cursor" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg5_projection_cursor" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cg5_projection_cursor" TO dcontact_app;

ALTER TABLE "cg5_alert_state" ADD CONSTRAINT "cg5_alert_state_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_alert_state" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg5_alert_state" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cg5_alert_state" TO dcontact_app;

ALTER TABLE "cg5_alert_transition" ADD CONSTRAINT "cg5_alert_transition_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_alert_transition" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg5_alert_transition" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cg5_alert_transition" TO dcontact_app;

ALTER TABLE "cg5_export_job" ADD CONSTRAINT "cg5_export_job_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_export_job" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg5_export_job" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cg5_export_job" TO dcontact_app;

ALTER TABLE "cg5_tenant_config" ADD CONSTRAINT "cg5_tenant_config_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_tenant_config" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg5_tenant_config" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cg5_tenant_config" TO dcontact_app;

ALTER TABLE "cg5_tenant_config_audit" ADD CONSTRAINT "cg5_tenant_config_audit_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_tenant_config_audit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg5_tenant_config_audit" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "cg5_tenant_config_audit" TO dcontact_app;

-- ประวัติ CG5 ให้ application role เพิ่มแถวได้เท่านั้น
REVOKE UPDATE, DELETE ON "cg5_alert_transition", "cg5_tenant_config_audit" FROM dcontact_app;
REVOKE DELETE ON "cg5_tenant_config" FROM dcontact_app;
ALTER TABLE "cg5_alert_transition" ADD CONSTRAINT "cg5_alert_transition_alert_fkey" FOREIGN KEY ("tenant_id", "alert_id") REFERENCES "cg5_alert_state"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg5_metric_bucket" ADD CONSTRAINT "cg5_metric_bucket_values_check" CHECK (sample_count >= 0 AND dimension_key ~ '^[a-f0-9]{64}$' AND metric_key IN ('cg.decision','cg.restriction','cg.frequency','cg.exception','cg.consent','cg.policy.health','cg.audit','cg.reservation'));
ALTER TABLE "cg5_policy_impact_bucket" ADD CONSTRAINT "cg5_policy_impact_bucket_values_check" CHECK (value >= 0 AND decision IN ('ALLOW','BLOCK','DEFER','REVIEW'));
ALTER TABLE "cg5_alert_state" ADD CONSTRAINT "cg5_alert_state_values_check" CHECK (version > 0 AND consecutive_hits >= 0 AND severity IN ('WARNING','CRITICAL') AND scope_key ~ '^[a-f0-9]{64}$');
ALTER TABLE "cg5_alert_transition" ADD CONSTRAINT "cg5_alert_transition_version_check" CHECK (from_version >= 0 AND to_version = from_version + 1 AND state_digest ~ '^[a-f0-9]{64}$');
ALTER TABLE "cg5_export_job" ADD CONSTRAINT "cg5_export_job_values_check" CHECK (version > 0 AND range_to > range_from AND length(trim(reason)) > 0 AND evidence_level IN ('SUMMARY','EVIDENCE') AND cardinality(datasets) > 0 AND datasets <@ ARRAY['DECISION_TRACE','AUDIT_LOG','RESTRICTION_CONSENT','EXCEPTION_APPROVAL']::text[]);
ALTER TABLE "cg5_tenant_config_audit" ADD CONSTRAINT "cg5_tenant_config_audit_action_check" CHECK (action IN ('CREATED','UPDATED','VERSION_CONFLICT'));

ALTER TABLE "cg5_tenant_config" ADD CONSTRAINT "cg5_tenant_config_bounds_check" CHECK ((
  jsonb_typeof(config) = 'object'
  AND config->'contractVersion' = '1'::jsonb
  AND version > 0
  AND length(trim(updated_by_ref)) > 0
  AND length(trim(evidence_ref)) > 0
  AND jsonb_typeof(config->'refreshIntervalSeconds') = 'number'
  AND (config->>'refreshIntervalSeconds')::numeric BETWEEN 60 AND 300
  AND jsonb_typeof(config->'lagSloSeconds') = 'number'
  AND (config->>'lagSloSeconds')::numeric BETWEEN 60 AND 900
  AND jsonb_typeof(config->'retentionFiveMinuteDays') = 'number'
  AND (config->>'retentionFiveMinuteDays')::numeric BETWEEN 1 AND 14
  AND jsonb_typeof(config->'retentionHourlyDays') = 'number'
  AND (config->>'retentionHourlyDays')::numeric BETWEEN 7 AND 90
  AND jsonb_typeof(config->'retentionDailyMonths') = 'number'
  AND (config->>'retentionDailyMonths')::numeric BETWEEN 1 AND 13
  AND jsonb_typeof(config->'anomalyMinimumVolume') = 'number'
  AND (config->>'anomalyMinimumVolume')::numeric BETWEEN 10 AND 10000
  AND jsonb_typeof(config->'anomalyConsecutiveHitsToOpen') = 'number'
  AND (config->>'anomalyConsecutiveHitsToOpen')::numeric BETWEEN 2 AND 12
  AND jsonb_typeof(config->'anomalyConsecutiveHitsToResolve') = 'number'
  AND (config->>'anomalyConsecutiveHitsToResolve')::numeric BETWEEN 2 AND 12
  AND jsonb_typeof(config->'anomalyBaselineWeeks') = 'number'
  AND (config->>'anomalyBaselineWeeks')::numeric BETWEEN 4 AND 4
  AND jsonb_typeof(config->'apiRateLimitPerMinute') = 'number'
  AND (config->>'apiRateLimitPerMinute')::numeric BETWEEN 10 AND 6000
  AND jsonb_typeof(config->'exportMaxRangeDays') = 'number'
  AND (config->>'exportMaxRangeDays')::numeric BETWEEN 1 AND 92
  AND jsonb_typeof(config->'exportMaxPerDay') = 'number'
  AND (config->>'exportMaxPerDay')::numeric BETWEEN 1 AND 50
) IS TRUE);

ALTER TABLE "cg5_tenant_config" ADD CONSTRAINT "cg5_tenant_config_fields_check" CHECK (config - ARRAY['contractVersion','refreshIntervalSeconds','lagSloSeconds','retentionFiveMinuteDays','retentionHourlyDays','retentionDailyMonths','anomalyMinimumVolume','anomalyConsecutiveHitsToOpen','anomalyConsecutiveHitsToResolve','anomalyBaselineWeeks','apiRateLimitPerMinute','exportMaxRangeDays','exportMaxPerDay']::text[] = '{}'::jsonb);
