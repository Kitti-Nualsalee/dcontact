-- A1.5 (#410): การแก้ field ที่ไม่ใช่ identity ของ request ลง Action history
-- แยกไฟล์จาก migration ที่ใช้ค่า enum นี้ตามแนวของ A1.3
ALTER TYPE "PfActionKind" ADD VALUE IF NOT EXISTS 'REQUEST_EDITED' AFTER 'SECURITY_DENIED';
