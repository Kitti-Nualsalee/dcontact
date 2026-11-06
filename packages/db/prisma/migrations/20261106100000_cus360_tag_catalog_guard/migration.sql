-- M1-A: อนุญาต rename ของ ACTIVE tag โดยคง identity และ provenance; ห้ามแก้ RETIRED
CREATE OR REPLACE FUNCTION c360_tags_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.actor_identity_key IS DISTINCT FROM OLD.actor_identity_key
     OR NEW.command_id IS DISTINCT FROM OLD.command_id
     OR NEW.evidence_ref IS DISTINCT FROM OLD.evidence_ref THEN
    RAISE EXCEPTION 'C360_TAG_IMMUTABLE: tag identity is immutable';
  END IF;
  IF OLD.state = 'RETIRED' THEN
    RAISE EXCEPTION 'C360_TAG_RETIRED: retired tag cannot change';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'C360_TAG_REVISION: tag revision must advance by one';
  END IF;
  IF NEW.state = 'ACTIVE' THEN
    IF NEW.name IS NOT DISTINCT FROM OLD.name AND NEW.name_key IS NOT DISTINCT FROM OLD.name_key THEN
      RAISE EXCEPTION 'C360_TAG_NO_OP: unchanged tag must not be updated';
    END IF;
  ELSIF NEW.state = 'RETIRED' THEN
    IF NEW.name IS DISTINCT FROM OLD.name OR NEW.name_key IS DISTINCT FROM OLD.name_key THEN
      RAISE EXCEPTION 'C360_TAG_RETIRE_RENAME: retire and rename require separate commands';
    END IF;
  ELSE
    RAISE EXCEPTION 'C360_TAG_STATE: invalid tag transition';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- keyset ของ catalog และ Activity ไม่ต้อง sort ทั้ง tenant เมื่อข้อมูลเติบโต
CREATE INDEX c360_tags_catalog_page_idx ON c360_tags (tenant_id, name_key COLLATE "C", id);
CREATE INDEX c360_profile_audits_activity_page_idx ON c360_profile_audits (tenant_id, created_at DESC, id DESC);
