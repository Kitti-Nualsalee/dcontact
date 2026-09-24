-- A1.3 (#408): transient failure ของ step ถูกบันทึกใน Action history ว่านัด retry แล้ว
-- (ไม่ใช่ receipt เพราะ receipt มีเฉพาะผลที่จบ attempt: SUCCEEDED/ACTION_REQUIRED)
-- แยกไฟล์จาก migration ที่ใช้ค่า enum นี้ตามแนวของ S2.1
ALTER TYPE "PfActionKind" ADD VALUE IF NOT EXISTS 'STEP_RETRY_SCHEDULED' AFTER 'STEP_ACTION_REQUIRED';
