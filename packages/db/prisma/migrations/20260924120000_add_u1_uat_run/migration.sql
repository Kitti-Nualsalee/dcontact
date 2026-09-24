-- U1.1 (#429): UAT fixture pack และ run record — expand-only
-- Authority: Phase Contract #374, fixture/reset #376, evidence #379

CREATE TYPE "UatRunLifecycle" AS ENUM ('ACTIVE', 'COMPLETED', 'ABANDONED');
CREATE TYPE "UatStepOutcome" AS ENUM ('PASS', 'FAIL', 'BLOCKED');
CREATE TYPE "UatSeverity" AS ENUM ('S1', 'S2', 'S3', 'S4');
CREATE TYPE "UatStateLabel" AS ENUM ('REAL_STATE', 'SIMULATION_ONLY');

CREATE TABLE "uat_fixture_packs" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "environment" TEXT NOT NULL,
  "pack_version" TEXT NOT NULL,
  "digest" CHAR(64) NOT NULL,
  "build_sha" TEXT NOT NULL,
  "manifest" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "uat_fixture_packs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uat_fixture_packs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "uat_fixture_packs_values_check" CHECK (
    "digest" ~ '^[a-f0-9]{64}$'
    AND "environment" ~ '^[a-z0-9][a-z0-9-]{0,62}$'
    AND "pack_version" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'
    AND "build_sha" ~ '^[a-f0-9]{7,64}$'
  )
);
CREATE UNIQUE INDEX "uat_fixture_packs_tenant_id_id_key" ON "uat_fixture_packs"("tenant_id", "id");
CREATE UNIQUE INDEX "uat_fixture_packs_version_key" ON "uat_fixture_packs"("tenant_id", "environment", "pack_version");

CREATE TABLE "uat_runs" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "fixture_pack_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "journey_id" UUID,
  "lifecycle" "UatRunLifecycle" NOT NULL DEFAULT 'ACTIVE',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "opened_by_ref" TEXT NOT NULL,
  "closed_by_ref" TEXT,
  "opened_at" TIMESTAMP(3) NOT NULL,
  "closed_at" TIMESTAMP(3),
  CONSTRAINT "uat_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uat_runs_pack_fkey" FOREIGN KEY ("tenant_id", "fixture_pack_id") REFERENCES "uat_fixture_packs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "uat_runs_values_check" CHECK (
    "sequence" >= 1 AND "revision" >= 1
    AND (("lifecycle" = 'ACTIVE') = ("closed_at" IS NULL))
    AND (("lifecycle" = 'ACTIVE') = ("closed_by_ref" IS NULL))
  )
);
CREATE UNIQUE INDEX "uat_runs_tenant_id_id_key" ON "uat_runs"("tenant_id", "id");
CREATE UNIQUE INDEX "uat_runs_sequence_key" ON "uat_runs"("tenant_id", "sequence");
CREATE INDEX "uat_runs_journey_idx" ON "uat_runs"("tenant_id", "journey_id");
-- ACTIVE ได้หนึ่งรอบต่อ tenant
CREATE UNIQUE INDEX "uat_runs_one_active_key" ON "uat_runs"("tenant_id") WHERE "lifecycle" = 'ACTIVE';

CREATE TABLE "uat_run_step_results" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "step_id" TEXT NOT NULL,
  "outcome" "UatStepOutcome" NOT NULL,
  "expected" TEXT NOT NULL,
  "actual" TEXT NOT NULL,
  "severity" "UatSeverity",
  "correlation_id" TEXT,
  "state_label" "UatStateLabel" NOT NULL,
  "recorded_by_ref" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "uat_run_step_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uat_run_step_results_run_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "uat_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "uat_run_step_results_values_check" CHECK (
    "step_id" ~ '^[A-Z][A-Z0-9_-]{1,63}$'
    AND char_length("expected") BETWEEN 1 AND 2000
    AND char_length("actual") BETWEEN 1 AND 2000
    AND ("correlation_id" IS NULL OR "correlation_id" ~ '^[A-Za-z0-9._:-]{1,128}$')
    -- FAIL ต้องมี severity; PASS ห้ามมี (#379)
    AND (("outcome" = 'FAIL') = ("severity" IS NOT NULL))
  )
);
CREATE UNIQUE INDEX "uat_run_step_results_tenant_id_id_key" ON "uat_run_step_results"("tenant_id", "id");
CREATE INDEX "uat_run_step_results_run_idx" ON "uat_run_step_results"("tenant_id", "run_id", "recorded_at");

CREATE TABLE "uat_command_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "command_name" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "run_id" UUID,
  "response" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "uat_command_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uat_command_receipts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "uat_command_receipts_tenant_id_id_key" ON "uat_command_receipts"("tenant_id", "id");
CREATE UNIQUE INDEX "uat_command_receipts_idempotency_key" ON "uat_command_receipts"("tenant_id", "idempotency_key");

-- ── Immutability ───────────────────────────────────────────────────────────

CREATE FUNCTION "uat_forbid_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'UAT_APPEND_ONLY: % แก้หรือลบไม่ได้', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "uat_fixture_packs_append_only" BEFORE UPDATE OR DELETE ON "uat_fixture_packs"
  FOR EACH ROW EXECUTE FUNCTION "uat_forbid_mutation"();
CREATE TRIGGER "uat_run_step_results_append_only" BEFORE UPDATE OR DELETE ON "uat_run_step_results"
  FOR EACH ROW EXECUTE FUNCTION "uat_forbid_mutation"();

-- run ที่ปิดแล้วแก้/ลบไม่ได้; run ที่ ACTIVE เปลี่ยนได้เฉพาะ journey_id (null → ค่า), revision และการปิด
CREATE FUNCTION "uat_runs_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'UAT_RUN_IMMUTABLE: ลบ run ไม่ได้';
  END IF;
  IF OLD."lifecycle" <> 'ACTIVE' THEN
    RAISE EXCEPTION 'UAT_RUN_IMMUTABLE: run ที่ปิดแล้วแก้ไม่ได้';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."tenant_id" <> OLD."tenant_id"
     OR NEW."fixture_pack_id" <> OLD."fixture_pack_id" OR NEW."sequence" <> OLD."sequence"
     OR NEW."opened_by_ref" <> OLD."opened_by_ref" OR NEW."opened_at" <> OLD."opened_at"
     OR (OLD."journey_id" IS NOT NULL AND NEW."journey_id" IS DISTINCT FROM OLD."journey_id")
     OR NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'UAT_RUN_IMMUTABLE: field ที่เปลี่ยนไม่ได้ หรือ revision ไม่เดินหน้า';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "uat_runs_guard" BEFORE UPDATE OR DELETE ON "uat_runs"
  FOR EACH ROW EXECUTE FUNCTION "uat_runs_guard"();

-- step result บันทึกได้เฉพาะ run ที่ ACTIVE (#379: หลักฐานของ run ที่ปิดแล้วแก้ไม่ได้)
CREATE FUNCTION "uat_step_result_requires_active_run"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "uat_runs"
    WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."run_id" AND "lifecycle" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'UAT_RUN_CLOSED: บันทึกผลใน run ที่ปิดแล้วไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "uat_run_step_results_active_run" BEFORE INSERT ON "uat_run_step_results"
  FOR EACH ROW EXECUTE FUNCTION "uat_step_result_requires_active_run"();
