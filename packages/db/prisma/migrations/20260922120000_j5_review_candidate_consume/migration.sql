-- J5.2 (#340): publish ต้อง supersede review candidate ที่ใช้ไปแล้วใน transaction เดียวกัน (Phase Spec §5)
--
-- guard ของ J5.1 ยอมให้เปลี่ยนสถานะได้เฉพาะตอน IN_REVIEW ซึ่งทำให้ candidate ที่ APPROVED แล้ว
-- ถูก "ใช้" ไม่ได้ และ approval เดิมจะถูกนำไป publish ซ้ำได้ — แก้ให้ APPROVED เดินไป SUPERSEDED
-- ได้ทางเดียว ส่วน binding ที่ pin ไว้ยังแก้ไม่ได้เหมือนเดิม และสถานะปิดอื่นยังแก้ไม่ได้

CREATE OR REPLACE FUNCTION jr_authoring_guard_review_candidate() RETURNS trigger AS $$
BEGIN
  IF NOT (
    OLD.state = 'IN_REVIEW'
    OR (OLD.state = 'APPROVED' AND NEW.state = 'SUPERSEDED')
  ) THEN
    RAISE EXCEPTION 'jr_review_candidates ที่ปิดแล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.resource_kind, NEW.resource_id, NEW.draft_revision,
      NEW.draft_digest, NEW.compile_digest, NEW.runtime_hash, NEW.base_head_version,
      NEW.base_head_digest, NEW.reference_digest, NEW.capability_digest, NEW.maker_subject_id,
      NEW.maker_authorization_epoch, NEW.maker_scope_version, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.resource_kind, OLD.resource_id, OLD.draft_revision,
      OLD.draft_digest, OLD.compile_digest, OLD.runtime_hash, OLD.base_head_version,
      OLD.base_head_digest, OLD.reference_digest, OLD.capability_digest, OLD.maker_subject_id,
      OLD.maker_authorization_epoch, OLD.maker_scope_version, OLD.created_at) THEN
    RAISE EXCEPTION 'jr_review_candidates แก้ binding ที่ pin ไว้ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
