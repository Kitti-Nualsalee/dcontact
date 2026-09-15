-- ผ่อน guard ให้ PENDING/FAILED เข้า QUARANTINED ได้ แต่ห้ามออกจาก QUARANTINED
-- (แยก migration จากตัวเพิ่ม enum เพราะ Postgres ใช้ค่า enum ใหม่ใน transaction เดียวกับ
-- ที่ ADD VALUE ไม่ได้)
CREATE OR REPLACE FUNCTION c360_guard_membership_outbox_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.change_id IS DISTINCT FROM OLD.change_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.segment_id IS DISTINCT FROM OLD.segment_id
     OR NEW.membership_revision IS DISTINCT FROM OLD.membership_revision
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.attempts < OLD.attempts
     OR OLD.state = 'PUBLISHED'
     OR OLD.state = 'QUARANTINED'
     OR (OLD.state = 'PENDING' AND NEW.state NOT IN ('PUBLISHED', 'FAILED', 'QUARANTINED'))
     OR (OLD.state = 'FAILED' AND NEW.state NOT IN ('PUBLISHED', 'FAILED', 'QUARANTINED')) THEN
    RAISE EXCEPTION 'invalid c360 membership outbox update';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- state_check เดิมรู้จักแค่ PENDING/FAILED/PUBLISHED — ต้องรับ QUARANTINED ด้วย
-- และบังคับว่า quarantined_at ต้องมีค่าคู่กันเสมอ แบบเดียวกับที่ PUBLISHED บังคับ published_at
ALTER TABLE "c360_segment_membership_outbox"
  DROP CONSTRAINT "c360_membership_outbox_state_check";
ALTER TABLE "c360_segment_membership_outbox"
  ADD CONSTRAINT "c360_membership_outbox_state_check" CHECK (
    ("state" IN ('PENDING', 'FAILED') AND "published_at" IS NULL AND "quarantined_at" IS NULL)
    OR ("state" = 'PUBLISHED' AND "published_at" IS NOT NULL AND "quarantined_at" IS NULL)
    OR ("state" = 'QUARANTINED' AND "published_at" IS NULL AND "quarantined_at" IS NOT NULL)
  );
