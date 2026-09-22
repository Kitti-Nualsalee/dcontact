-- S2.2 (#364): ด่านสุดท้ายของ Attempt/Touch semantics ตาม #361 §D และ Phase Contract #362 §8
--
-- Expand ล้วน: เพิ่ม CHECK กับ trigger เท่านั้น ไม่ drop/rename/backfill อะไร
-- ค่า enum 'PROVIDER_ACCEPTED' ถูก commit ไปแล้วใน 20260922160000 จึงอ้างในไฟล์นี้ได้
--
-- เหตุผลที่ต้องมีชั้น DB ทั้งที่ TS ตรวจแล้ว: cg_touches เป็นตารางที่ owner อื่นอาจเผลอเขียน
-- (หรือ script ที่ไม่ผ่าน ContactGovernanceService) — invariant ที่บังคับได้เฉพาะในโค้ดไม่ใช่หลักฐาน
-- trigger RAISE ด้วย machine code ASCII นำหน้า (CG_*) เพราะ Prisma escape ข้อความไทยใน error

-- Touch ที่ผูกกับ acceptance ต้องมีหลักฐาน response เสมอ — ไม่มี time-window inference
ALTER TABLE "cg_touches" ADD CONSTRAINT "cg_touches_provider_accepted_evidence_check" CHECK (
  "outcome" <> 'PROVIDER_ACCEPTED' OR "evidence_kind" IS NOT NULL
);

-- Touch ต้องสะท้อน outcome ของ Attempt ที่มันเกาะอยู่ และ evidence เกาะได้เฉพาะ accepted Attempt
CREATE FUNCTION cg_guard_touch_evidence() RETURNS trigger AS $$
DECLARE
  attempt_outcome "CgFactOutcome";
BEGIN
  SELECT "outcome" INTO attempt_outcome
  FROM "cg_attempts"
  WHERE "tenant_id" = NEW."tenant_id" AND "id" = NEW."attempt_id";

  IF attempt_outcome IS NULL THEN
    RAISE EXCEPTION 'CG_TOUCH_ATTEMPT_NOT_FOUND: cg_touches ต้องผูกกับ cg_attempts ของ tenant เดียวกัน';
  END IF;
  IF NEW."outcome" IS DISTINCT FROM attempt_outcome THEN
    RAISE EXCEPTION 'CG_TOUCH_OUTCOME_MISMATCH: Touch ต้องมี outcome เดียวกับ Attempt ที่ผูกอยู่';
  END IF;
  IF NEW."evidence_kind" IS NOT NULL AND attempt_outcome <> 'PROVIDER_ACCEPTED' THEN
    RAISE EXCEPTION 'CG_TOUCH_EVIDENCE_ATTEMPT_MISMATCH: correlated Touch ผูกได้เฉพาะ Attempt ที่เป็น PROVIDER_ACCEPTED';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "cg_touches_evidence_guard" BEFORE INSERT ON "cg_touches"
  FOR EACH ROW EXECUTE FUNCTION cg_guard_touch_evidence();
