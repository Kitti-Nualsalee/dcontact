-- E1.10 (#484): runtime ใหม่ไม่อ่าน static SIP password แล้ว แต่คง column ไว้ตลอดช่วง rollback
-- เพราะ release ก่อนหน้ายังอ่านค่านี้ การลบจริงต้องทำหลังหมด rollback window
SELECT 1;
