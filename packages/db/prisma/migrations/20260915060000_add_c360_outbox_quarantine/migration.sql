-- J3.3 remediation: แยก "ล้มเหลวชั่วคราว" ออกจาก "payload เสียถาวร"
--
-- เดิม relay ยุบทุก error เป็น FAILED แล้ว retry ด้วย exponential backoff รวมถึงกรณีที่
-- payload validate ไม่ผ่านหรือ hash ไม่ตรงกับที่ commit ไว้ ซึ่ง retry ไปกี่ครั้งก็ได้ผลเดิม
-- เพราะข้อมูลในแถวนั้นเสียไปแล้ว ผลคือแถวนั้นวนอยู่ในคิวตลอดไปโดยไม่มีใครรู้ว่าเสีย
--
-- QUARANTINED เป็น terminal: ออกจาก state นี้ไม่ได้ ต้องให้คนเข้ามาดูว่าเกิดอะไรขึ้น
ALTER TYPE "C360SegmentMembershipOutboxState" ADD VALUE 'QUARANTINED';

ALTER TABLE "c360_segment_membership_outbox"
  ADD COLUMN "last_error" TEXT,
  ADD COLUMN "quarantined_at" TIMESTAMP(3);
