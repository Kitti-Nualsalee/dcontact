-- J3.10 (#221): rollout stage ต่อ tenant และ shadow mismatch report
--
-- rollback ในที่นี้คือหยุด effect ใหม่ (mutation_frozen) ไม่ใช่ย้อน stage หรือลบของที่เกิดไปแล้ว
-- ตาม stop condition ที่ห้าม destructive down migration และห้ามลบ facts/receipts/audit

CREATE TYPE "JrSegmentRolloutStage" AS ENUM (
  'DISABLED',
  'OWNER_BACKFILL',
  'SHADOW_MEMBERSHIP',
  'SHADOW_RECEIPT_REFILTER',
  'SCOPED_INTERNAL_ENABLED'
);

CREATE TABLE "jr_segment_rollout_state" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "stage" "JrSegmentRolloutStage" NOT NULL DEFAULT 'DISABLED',
  "shadow_started_at" TIMESTAMP(3),
  "switched_at" TIMESTAMP(3),
  "mutation_frozen" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_ref" TEXT NOT NULL,
  "evidence_ref" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "jr_segment_rollout_state_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jr_segment_shadow_mismatches" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "membership_revision" INTEGER NOT NULL,
  "mismatch_kind" TEXT NOT NULL,
  "expected_digest" CHAR(64),
  "observed_digest" CHAR(64),
  "detected_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_segment_shadow_mismatches_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "jr_segment_rollout_state_tenant_key"
  ON "jr_segment_rollout_state" ("tenant_id");

-- mismatch เดิมของ revision เดียวกันต้องไม่ถูกบันทึกซ้ำทุกครั้งที่ shadow วนรอบ
CREATE UNIQUE INDEX "jr_segment_shadow_mismatches_key"
  ON "jr_segment_shadow_mismatches"
  ("tenant_id", "contact_id", "segment_id", "membership_revision", "mismatch_kind");
CREATE INDEX "jr_segment_shadow_mismatches_detected_idx"
  ON "jr_segment_shadow_mismatches" ("tenant_id", "detected_at");

ALTER TABLE "jr_segment_rollout_state"
  ADD CONSTRAINT "jr_segment_rollout_state_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_segment_shadow_mismatches"
  ADD CONSTRAINT "jr_segment_shadow_mismatches_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_segment_shadow_mismatches_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- เวลาที่บันทึกต้องสอดคล้องกับ stage ที่ไปถึงจริง ไม่ใช่ตั้งไว้ล่วงหน้า
ALTER TABLE "jr_segment_rollout_state"
  ADD CONSTRAINT "jr_segment_rollout_state_stage_check" CHECK (
    ("stage" = 'DISABLED' AND "shadow_started_at" IS NULL AND "switched_at" IS NULL)
    OR ("stage" = 'OWNER_BACKFILL' AND "switched_at" IS NULL)
    OR ("stage" IN ('SHADOW_MEMBERSHIP', 'SHADOW_RECEIPT_REFILTER')
        AND "shadow_started_at" IS NOT NULL AND "switched_at" IS NULL)
    OR ("stage" = 'SCOPED_INTERNAL_ENABLED'
        AND "shadow_started_at" IS NOT NULL AND "switched_at" IS NOT NULL)
  ),
  ADD CONSTRAINT "jr_segment_rollout_state_version_check" CHECK ("version" >= 1);

-- stage เดินหน้าอย่างเดียว
--
-- ย้อนกลับไป stage ก่อนหน้าเท่ากับปลุก writer ที่ถูกปลดไปแล้วให้กลับมาเขียนทับของใหม่
-- การหยุด effect ทำผ่าน mutation_frozen ซึ่งย้อนได้ ไม่ใช่ผ่านการย้อน stage ซึ่งย้อนไม่ได้
CREATE FUNCTION jr_guard_segment_rollout() RETURNS trigger AS $$
DECLARE
  old_rank INT;
  new_rank INT;
BEGIN
  old_rank := array_position(
    ARRAY['DISABLED','OWNER_BACKFILL','SHADOW_MEMBERSHIP','SHADOW_RECEIPT_REFILTER','SCOPED_INTERNAL_ENABLED'],
    OLD.stage::text);
  new_rank := array_position(
    ARRAY['DISABLED','OWNER_BACKFILL','SHADOW_MEMBERSHIP','SHADOW_RECEIPT_REFILTER','SCOPED_INTERNAL_ENABLED'],
    NEW.stage::text);
  IF new_rank < old_rank THEN
    RAISE EXCEPTION 'jr_segment_rollout_state ย้อน stage ไม่ได้';
  END IF;
  IF OLD.switched_at IS NOT NULL AND NEW.switched_at IS DISTINCT FROM OLD.switched_at THEN
    RAISE EXCEPTION 'switched_at ตั้งได้ครั้งเดียว';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'jr_segment_rollout_state version ต้องเพิ่มขึ้นทุกครั้งที่แก้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_segment_rollout_guard"
BEFORE UPDATE ON "jr_segment_rollout_state"
FOR EACH ROW EXECUTE FUNCTION jr_guard_segment_rollout();

-- shadow mismatch เป็นหลักฐานของ incident — แก้ย้อนหลังไม่ได้
CREATE FUNCTION jr_reject_segment_shadow_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'jr_segment_shadow_mismatches เป็น append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_segment_shadow_mismatches_immutable"
BEFORE UPDATE ON "jr_segment_shadow_mismatches"
FOR EACH ROW EXECUTE FUNCTION jr_reject_segment_shadow_update();

ALTER TABLE "jr_segment_rollout_state" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_segment_rollout_state"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_segment_shadow_mismatches" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_segment_shadow_mismatches"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "jr_segment_rollout_state" TO dcontact_app;
GRANT SELECT, INSERT ON "jr_segment_shadow_mismatches" TO dcontact_app;
