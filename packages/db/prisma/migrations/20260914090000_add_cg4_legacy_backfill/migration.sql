-- CG4.10 (#193) PR-A: expand สำหรับ backfill CG3 → CG4 (#179 §6 ขั้น expand/backfill)
--
-- expand-only: เพิ่ม enum value, enum ใหม่, nullable/defaulted column และ guard trigger
-- ไม่แก้หรือลบประวัติ CG3 ใด ๆ และไม่สร้าง historic event ย้อนหลัง

-- 1. approval ที่ย้ายมาจาก CG3 (maker/checker/approvalRef เดิม) เป็นหลักฐานของ baseline เท่านั้น
ALTER TYPE "Cg4CapabilitySource" ADD VALUE IF NOT EXISTS 'LEGACY_MIGRATED';

-- 2. ที่มาของ policy version: CG4 writer หรือ backfill จาก cg_policies ของ CG3
CREATE TYPE "Cg4PolicyOrigin" AS ENUM ('CG4', 'LEGACY_CG3');

ALTER TABLE "cg_policy"
  ADD COLUMN "origin" "Cg4PolicyOrigin" NOT NULL DEFAULT 'CG4',
  ADD COLUMN "legacy_source_row_id" UUID;

ALTER TABLE "cg_policy" ADD CONSTRAINT "cg_policy_legacy_source_origin_check"
  CHECK (("origin" = 'LEGACY_CG3') = ("legacy_source_row_id" IS NOT NULL));

-- CG3 row หนึ่งแถว map ได้ครั้งเดียว: rerun ของ backfill ชนตรงนี้แทนการสร้างซ้ำ
CREATE UNIQUE INDEX "cg_policy_legacy_source_row_key"
  ON "cg_policy"("tenant_id", "legacy_source_row_id")
  WHERE "legacy_source_row_id" IS NOT NULL;

-- 3. ที่มาเป็นข้อเท็จจริงถาวร: ห้ามเปลี่ยน row ของ CG4 ให้ดูเหมือนมาจาก CG3 หรือกลับกัน
CREATE FUNCTION cg4_reject_policy_origin_update() RETURNS trigger AS $$
BEGIN
  IF NEW.origin IS DISTINCT FROM OLD.origin
     OR NEW.legacy_source_row_id IS DISTINCT FROM OLD.legacy_source_row_id THEN
    RAISE EXCEPTION 'cg_policy origin is immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cg4_policy_origin_immutable
  BEFORE UPDATE ON "cg_policy"
  FOR EACH ROW EXECUTE FUNCTION cg4_reject_policy_origin_update();

-- 4. LEGACY_MIGRATED ใช้ได้เฉพาะกับ version ที่มาจาก CG3 จึงนับเป็น quorum ของ version ใหม่
--    ของ CG4 ไม่ได้ (#179 §6 "ใช้อนุมัติ version ใหม่ไม่ได้")
CREATE FUNCTION cg4_reject_misplaced_legacy_approval() RETURNS trigger AS $$
BEGIN
  IF NEW.capability_source::text = 'LEGACY_MIGRATED' AND NOT EXISTS (
    SELECT 1 FROM "cg_policy" p
    WHERE p.tenant_id = NEW.tenant_id
      AND p.policy_id = NEW.policy_id
      AND p.version = NEW.policy_version
      AND p.origin = 'LEGACY_CG3'
  ) THEN
    RAISE EXCEPTION 'LEGACY_MIGRATED approval requires a LEGACY_CG3 policy version';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cg4_policy_approval_legacy_guard
  BEFORE INSERT ON "cg_policy_approval"
  FOR EACH ROW EXECUTE FUNCTION cg4_reject_misplaced_legacy_approval();

-- 5. capability ของ approval ที่ย้ายมาเป็นค่าเฉพาะที่ไม่อยู่ใน capability matrix: ห้ามจับคู่
--    LEGACY_MIGRATED กับ capability จริง และห้ามใช้ capability ของ legacy กับ source อื่น
ALTER TABLE "cg_policy_approval" DROP CONSTRAINT "cg_policy_approval_capability_check";
ALTER TABLE "cg_policy_approval" ADD CONSTRAINT "cg_policy_approval_capability_check"
  CHECK (
    ("capability_source"::text = 'LEGACY_MIGRATED' AND "capability" = 'cg.legacy.migrated')
    OR (
      "capability_source"::text <> 'LEGACY_MIGRATED'
      AND "capability" IN ('cg.policy.publish', 'cg.policy.publish.relaxation')
    )
  );
