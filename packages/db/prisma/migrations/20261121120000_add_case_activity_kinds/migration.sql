-- #956 ชนิด activity ของเคสที่ Agent ทำเอง แยกไฟล์จาก migration ที่ใช้ค่า enum นี้ตามแนวของ A1.3
ALTER TYPE "CsActivityKind" ADD VALUE IF NOT EXISTS 'NOTE';
ALTER TYPE "CsActivityKind" ADD VALUE IF NOT EXISTS 'ASSIGNED';
ALTER TYPE "CsActivityKind" ADD VALUE IF NOT EXISTS 'STATUS_CHANGED';
