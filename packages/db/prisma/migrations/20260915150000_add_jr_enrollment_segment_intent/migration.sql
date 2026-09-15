-- J3.7 (#218): ต่อสาย SEGMENT_ENTRY enrollment intent เข้ากับ enrollment จริง
--
-- ผูกกับ intent ไม่ใช่ receipt เหมือน outcome_receipt_id เพราะ segment หนึ่ง revision fan-out
-- ไปได้หลาย journey พร้อมกัน ส่วน intent เป็นหนึ่งใบต่อ (journey, version, entry) อยู่แล้ว
-- ความสัมพันธ์จึงเป็น 1:1 จริงและบังคับด้วย unique ได้ตรงไปตรงมา
--
-- ไม่มีสายนี้ การยกเลิกงานฝั่ง owner ตอน re-filter ตัดสินว่า CANCELLED จะไม่มีอะไรให้ยกเลิก

ALTER TABLE "jr_segment_enrollment_intents"
  ADD CONSTRAINT "jr_segment_enrollment_intents_tenant_id_key" UNIQUE ("tenant_id", "id");

ALTER TABLE "jr_enrollments" ADD COLUMN "segment_intent_id" UUID;

CREATE UNIQUE INDEX "jr_enrollments_tenant_segment_intent_key"
  ON "jr_enrollments" ("tenant_id", "segment_intent_id");

ALTER TABLE "jr_enrollments"
  ADD CONSTRAINT "jr_enrollments_segment_intent_fkey"
  FOREIGN KEY ("tenant_id", "segment_intent_id")
  REFERENCES "jr_segment_enrollment_intents"("tenant_id", "id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

-- enrollment หนึ่งใบมี trigger source ได้แบบเดียวเท่านั้น — เดิมกติกานี้อยู่แค่ในโค้ด
-- พอมี source ที่สี่ก็ถึงเวลาบังคับที่ฐานข้อมูล ไม่งั้นแถวที่อ้างสองแหล่งพร้อมกันจะตอบไม่ได้ว่า
-- จริง ๆ แล้วอะไรเป็นตัว trigger และ audit ก็เชื่อถือไม่ได้
ALTER TABLE "jr_enrollments"
  ADD CONSTRAINT "jr_enrollments_single_trigger_source_check" CHECK (
    (
      ("event_inbox_id" IS NOT NULL)::int
      + ("occurrence_id" IS NOT NULL)::int
      + ("outcome_receipt_id" IS NOT NULL)::int
      + ("segment_intent_id" IS NOT NULL)::int
    ) <= 1
  );
