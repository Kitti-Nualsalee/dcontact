-- #936 รายการเหตุผล Not Ready ต่อ tenant (docs/agent-readiness-setup.md, คำตัดสิน owner ข้อ 4)
-- Admin แก้ทั้งรายการผ่าน Core Settings command เดียว (NOT_READY_REASONS_UPDATE) ทุกครั้งเพิ่ม revision หนึ่ง
-- เหตุผลที่ถูกใช้แล้ว (first_used_at — #937 เป็นผู้ตั้ง) ลบไม่ได้ ปิดได้เท่านั้น
-- ลบ tenant = ลบรายการตามกัน (ทุก tenant ได้รายการจาก trigger จึงต้องไม่ขวางการลบ tenant ที่ยังไม่เคยใช้เหตุผล)
CREATE TABLE tenant_not_ready_reasons (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL CHECK (code ~ '^[A-Z][A-Z0-9_]{1,31}$'),
  label_th text NOT NULL CHECK (char_length(label_th) BETWEEN 1 AND 40 AND label_th = btrim(label_th)),
  label_en text NOT NULL CHECK (char_length(label_en) BETWEEN 1 AND 40 AND label_en = btrim(label_en)),
  is_active boolean NOT NULL DEFAULT true,
  position integer NOT NULL CHECK (position >= 0),
  first_used_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, code),
  CONSTRAINT tenant_not_ready_reasons_position UNIQUE (tenant_id, position) DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE tenant_not_ready_reason_revisions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  revision bigint NOT NULL CHECK (revision > 0)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_not_ready_reasons','tenant_not_ready_reason_revisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)', t);
  END LOOP;
END $$;

-- เหตุผลที่ถูกใช้แล้วลบไม่ได้ และ code/tenant/first_used_at ย้อนกลับไม่ได้
CREATE FUNCTION dc_not_ready_reason_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' THEN
    -- ลบตาม tenant (ON DELETE CASCADE) ได้เสมอ: ตอนนี้แถว tenant ถูกลบไปแล้วใน statement เดียวกัน
    IF OLD.first_used_at IS NOT NULL AND EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN
      RAISE EXCEPTION 'NOT_READY_REASON_IN_USE' USING ERRCODE = '23514'; END IF;
    RETURN OLD;
  END IF;
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.code <> OLD.code
    OR (OLD.first_used_at IS NOT NULL AND NEW.first_used_at IS DISTINCT FROM OLD.first_used_at) THEN
    RAISE EXCEPTION 'NOT_READY_REASON_IMMUTABLE' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER not_ready_reason_guard BEFORE UPDATE OR DELETE ON tenant_not_ready_reasons
  FOR EACH ROW EXECUTE FUNCTION dc_not_ready_reason_guard();

CREATE FUNCTION dc_not_ready_reason_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP = 'DELETE' AND NOT EXISTS (SELECT 1 FROM tenants WHERE id = OLD.tenant_id) THEN RETURN OLD; END IF;
  IF TG_OP = 'DELETE' OR (TG_OP = 'UPDATE' AND (NEW.tenant_id <> OLD.tenant_id OR NEW.revision <> OLD.revision + 1))
    OR (TG_OP = 'INSERT' AND NEW.revision <> 1) THEN
    RAISE EXCEPTION 'CORE_REVISION_CONFLICT' USING ERRCODE = '23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER not_ready_reason_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON tenant_not_ready_reason_revisions
  FOR EACH ROW EXECUTE FUNCTION dc_not_ready_reason_revision_guard();

-- 7 เหตุผลตั้งต้น ใส่ให้ทุก tenant ตอนสร้าง (ทุกเส้นทาง: provisioning, seed) และ backfill tenant เดิม
CREATE FUNCTION dc_seed_not_ready_reasons(p_tenant uuid) RETURNS void LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$
DECLARE previous text := current_setting('app.tenant_id', true); BEGIN
  PERFORM set_config('app.tenant_id', p_tenant::text, true);
  INSERT INTO tenant_not_ready_reasons(tenant_id, code, label_th, label_en, position) VALUES
    (p_tenant, 'BREAK', 'พักสั้น', 'Break', 0),
    (p_tenant, 'LUNCH', 'พักเที่ยง', 'Lunch', 1),
    (p_tenant, 'MEETING', 'ประชุม', 'Meeting', 2),
    (p_tenant, 'TRAINING', 'อบรม', 'Training', 3),
    (p_tenant, 'COACHING', 'โค้ช/ประเมิน', 'Coaching', 4),
    (p_tenant, 'BACK_OFFICE', 'งานหลังบ้าน', 'Back office', 5),
    (p_tenant, 'PERSONAL', 'ธุระส่วนตัว', 'Personal', 6)
  ON CONFLICT (tenant_id, code) DO NOTHING;
  INSERT INTO tenant_not_ready_reason_revisions(tenant_id, revision) VALUES (p_tenant, 1) ON CONFLICT (tenant_id) DO NOTHING;
  PERFORM set_config('app.tenant_id', coalesce(previous, ''), true);
END $$;
REVOKE ALL ON FUNCTION dc_seed_not_ready_reasons(uuid) FROM PUBLIC;
CREATE FUNCTION dc_seed_not_ready_reasons_on_tenant() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public AS $$ BEGIN
  PERFORM dc_seed_not_ready_reasons(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_seed_not_ready_reasons AFTER INSERT ON tenants
  FOR EACH ROW EXECUTE FUNCTION dc_seed_not_ready_reasons_on_tenant();
DO $$ DECLARE t uuid; BEGIN
  FOR t IN SELECT id FROM tenants LOOP PERFORM dc_seed_not_ready_reasons(t); END LOOP;
END $$;

-- Core Settings command: แก้ทั้งรายการเป็น resource เดียวต่อ tenant (resource_id = tenant_id เหมือน ORGANIZATION)
ALTER TABLE tenant_core_commands DROP CONSTRAINT tenant_core_commands_check;
ALTER TABLE tenant_core_commands ADD CONSTRAINT tenant_core_commands_check CHECK (
  (is_tombstone AND action IS NULL AND resource_type IS NULL AND resource_id IS NULL AND payload_digest IS NULL AND expected_revision IS NULL)
  OR (NOT is_tombstone AND action IS NOT NULL AND resource_type IS NOT NULL AND resource_id IS NOT NULL AND payload_digest IS NOT NULL
    AND payload_digest ~ '^[a-f0-9]{64}$' AND (
      (action = 'ORGANIZATION_UPDATE' AND resource_type = 'ORGANIZATION' AND resource_id = tenant_id AND expected_revision IS NOT NULL AND expected_revision >= 0)
      OR (action = 'TEAM_CREATE' AND resource_type = 'TEAM' AND expected_revision IS NULL)
      OR (action IN ('TEAM_RENAME','TEAM_DEACTIVATE') AND resource_type = 'TEAM' AND expected_revision IS NOT NULL AND expected_revision >= 1)
      OR (action = 'NOT_READY_REASONS_UPDATE' AND resource_type = 'NOT_READY_REASONS' AND resource_id = tenant_id AND expected_revision IS NOT NULL AND expected_revision >= 0))));
