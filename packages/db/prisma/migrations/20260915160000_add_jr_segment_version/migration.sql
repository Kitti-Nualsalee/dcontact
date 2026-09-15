-- J3.8 (#219): optimistic-concurrency token ของ segment receipt กับ re-filter cursor
--
-- แยกจาก attempts โดยตั้งใจ: attempts ขยับเฉพาะตอน retry ไม่ขยับตอน state เปลี่ยนด้วยเหตุอื่น
-- ใช้เป็น token แล้ว operator จะเห็นค่าเดิมทั้งที่ของเปลี่ยนไปแล้ว ซึ่งคือ blind retry ที่
-- acceptance ของ #219 สั่งให้ปฏิเสธพอดี

ALTER TABLE "jr_segment_receipts" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "jr_segment_refilter_cursors" ADD COLUMN "version" INTEGER NOT NULL DEFAULT 1;

-- token ที่ถอยหลังได้ก็ไม่ใช่ token — บังคับที่ฐานข้อมูลไม่ใช่แค่ในโค้ด
ALTER TABLE "jr_segment_receipts"
  ADD CONSTRAINT "jr_segment_receipts_version_check" CHECK ("version" >= 1);
ALTER TABLE "jr_segment_refilter_cursors"
  ADD CONSTRAINT "jr_segment_refilter_cursors_version_check" CHECK ("version" >= 1);
