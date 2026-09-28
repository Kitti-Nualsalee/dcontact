-- U1.5 (#433): หลักฐานภาพหน้าจอและผล negative scan ของ UAT run — expand-only
-- Authority: Phase Contract #374, evidence/defect #379
-- byte ของภาพอยู่ใน object storage ส่วนตัวของ UAT stack (retention 90 วัน) — ตารางนี้เก็บแค่ metadata + sha256

CREATE TYPE "UatScanStatus" AS ENUM ('PASSED', 'FAILED');

CREATE TABLE "uat_run_evidence" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "step_id" TEXT NOT NULL,
  "content_type" TEXT NOT NULL,
  "size_bytes" INTEGER NOT NULL,
  "sha256" CHAR(64) NOT NULL,
  "storage_key" TEXT NOT NULL,
  "recorded_by_ref" TEXT NOT NULL,
  "recorded_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "uat_run_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uat_run_evidence_run_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "uat_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "uat_run_evidence_values_check" CHECK (
    "step_id" ~ '^[A-Z][A-Z0-9_-]{1,63}$'
    -- ภาพหน้าจอเท่านั้น: trace/HAR/network log ไม่มีทางเป็นหลักฐาน (#379)
    AND "content_type" IN ('image/png', 'image/jpeg')
    AND "size_bytes" BETWEEN 1 AND 5242880
    AND "sha256" ~ '^[a-f0-9]{64}$'
    -- key ผูกกับ tenant/run/id ของแถวเสมอ — ชี้ข้าม tenant ไม่ได้
    AND "storage_key" = 'uat-evidence/' || "tenant_id"::text || '/' || "run_id"::text || '/' || "id"::text
  )
);
CREATE UNIQUE INDEX "uat_run_evidence_tenant_id_id_key" ON "uat_run_evidence"("tenant_id", "id");
CREATE INDEX "uat_run_evidence_run_idx" ON "uat_run_evidence"("tenant_id", "run_id", "recorded_at");

CREATE TABLE "uat_run_scans" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "run_id" UUID NOT NULL,
  "scanner_version" TEXT NOT NULL,
  "input_digest" CHAR(64) NOT NULL,
  "status" "UatScanStatus" NOT NULL,
  "severity" "UatSeverity",
  "findings" JSONB NOT NULL,
  "scanned_by_ref" TEXT NOT NULL,
  "scanned_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "uat_run_scans_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "uat_run_scans_run_fkey" FOREIGN KEY ("tenant_id", "run_id") REFERENCES "uat_runs"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "uat_run_scans_values_check" CHECK (
    "input_digest" ~ '^[a-f0-9]{64}$'
    AND "scanner_version" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    AND jsonb_typeof("findings") = 'array'
    -- พบอะไร = S1 และ FAILED เสมอ; ไม่พบ = PASSED ไม่มี severity (#379)
    AND (("status" = 'FAILED') = (jsonb_array_length("findings") > 0))
    AND (("status" = 'FAILED') = ("severity" IS NOT NULL))
    AND ("severity" IS NULL OR "severity" = 'S1')
  )
);
CREATE UNIQUE INDEX "uat_run_scans_tenant_id_id_key" ON "uat_run_scans"("tenant_id", "id");
CREATE UNIQUE INDEX "uat_run_scans_input_key" ON "uat_run_scans"("tenant_id", "run_id", "input_digest");

-- ── Immutability ───────────────────────────────────────────────────────────

CREATE TRIGGER "uat_run_evidence_append_only" BEFORE UPDATE OR DELETE ON "uat_run_evidence"
  FOR EACH ROW EXECUTE FUNCTION "uat_forbid_mutation"();
CREATE TRIGGER "uat_run_scans_append_only" BEFORE UPDATE OR DELETE ON "uat_run_scans"
  FOR EACH ROW EXECUTE FUNCTION "uat_forbid_mutation"();

-- หลักฐานเพิ่มได้เฉพาะ run ที่ ACTIVE เหมือน step result (#379: หลักฐานของ run ที่ปิดแล้วแก้ไม่ได้)
-- ผล scan ไม่ถูกจำกัด: scan ไม่เปลี่ยนหลักฐาน และ bundle ของ run ที่ปิดแล้วยังต้อง scan ได้
CREATE TRIGGER "uat_run_evidence_active_run" BEFORE INSERT ON "uat_run_evidence"
  FOR EACH ROW EXECUTE FUNCTION "uat_step_result_requires_active_run"();
