-- S1.7: งาน Dialer ที่ยัง QUEUED อาจยังไม่มี reservation; เมื่อรับ CG3 event
-- จะ fail closed เป็น HELD จน worker ขอ authorize/reserve ใหม่ก่อน originate.

ALTER TABLE "ob_attempts" ALTER COLUMN "reservation_id" DROP NOT NULL;
