-- S2.1 (#365): ค่าใหม่ของ enum เดิมตาม Phase Contract #362 §3 — expand-only
--
-- แยกจาก migration ที่สร้างตารางเพราะ Postgres ห้ามใช้ค่า enum ที่เพิ่งเพิ่มใน transaction เดียวกัน
-- แถว TEST_ADAPTER เดิมไม่ถูก backfill และ default ของ dl_outbox_entries.adapter ยังเป็น TEST_ADAPTER
ALTER TYPE "DlDeliveryAdapter" ADD VALUE IF NOT EXISTS 'LINE_MESSAGING_API';

-- LINE 2xx/409 = provider รับ request แล้วเท่านั้น ไม่ใช่ DELIVERED (#361)
ALTER TYPE "CgFactOutcome" ADD VALUE IF NOT EXISTS 'PROVIDER_ACCEPTED';
