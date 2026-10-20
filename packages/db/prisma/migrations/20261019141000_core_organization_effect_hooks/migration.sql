-- Metadata เดิมไม่ถูก backfill ด้วยหลักฐานที่แต่งขึ้น; จับ before เฉพาะ effect ใหม่
ALTER TABLE tenant_core_profile_revisions ADD COLUMN transaction_id bigint, ADD COLUMN captured_before jsonb;
CREATE FUNCTION dc_core_organization_snapshot(p_tenant uuid) RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',t.id,'displayName',t.name,'defaults',
    CASE WHEN s.tenant_id IS NULL THEN NULL ELSE jsonb_build_object('locale',s.locale,'timeZone',s.timezone,'initializationSource',s.initialization_source) END,
    'revision',coalesce(r.revision,0)::text)
  FROM public.tenants t LEFT JOIN public.tenant_settings s ON s.tenant_id=t.id LEFT JOIN public.tenant_core_profile_revisions r ON r.tenant_id=t.id WHERE t.id=p_tenant
$$;
-- ยกระดับเฉพาะการเพิ่ม revision จาก trigger ของ covered fields; ไม่มี arguments/SQL จาก client
CREATE FUNCTION dc_core_capture_organization_effect() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE tid uuid; lifecycle text; prior public.tenant_core_profile_revisions; before_value jsonb; BEGIN
  IF TG_TABLE_NAME='tenants' THEN tid:=NEW.id; ELSE tid:=NEW.tenant_id; END IF;
  -- รองรับ owner นำเข้าข้อมูลเก่าที่มี bootstrap fields ครบ; app ใช้ช่องนี้ไม่ได้
  IF TG_TABLE_NAME='tenant_settings' THEN
    IF TG_OP='INSERT' AND NEW.initialization_source='PROVISIONING' AND EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolsuper) THEN RETURN NEW; END IF;
  END IF;
  SELECT lifecycle_status::text INTO lifecycle FROM public.tenants WHERE id=tid;
  IF lifecycle='PROVISIONING' THEN
    IF TG_TABLE_NAME='tenant_settings' THEN
      IF NEW.initialization_source<>'PROVISIONING' THEN RAISE EXCEPTION 'CORE_PROVISIONING_ONLY' USING ERRCODE='23514'; END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF lifecycle IS DISTINCT FROM 'ACTIVE' OR nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM tid THEN
    RAISE EXCEPTION 'CORE_ACTIVE_TENANT_CONTEXT_REQUIRED' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='tenant_settings' THEN
    IF TG_OP='INSERT' AND NEW.initialization_source<>'CORE_ADMIN' THEN RAISE EXCEPTION 'CORE_ADMIN_ORIGIN_REQUIRED' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('core-profile:'||tid::text,0)) THEN
    RAISE EXCEPTION 'CORE_PROFILE_BUSY' USING ERRCODE='55P03'; END IF;
  SELECT * INTO prior FROM public.tenant_core_profile_revisions WHERE tenant_id=tid FOR UPDATE NOWAIT;
  IF prior.transaction_id=txid_current() THEN RETURN NEW; END IF;
  SELECT public.dc_core_organization_snapshot(tid) INTO before_value;
  INSERT INTO public.tenant_core_profile_revisions(tenant_id,revision,transaction_id,captured_before)
    VALUES(tid,1,txid_current(),before_value)
    ON CONFLICT(tenant_id) DO UPDATE SET revision=public.tenant_core_profile_revisions.revision+1,transaction_id=txid_current(),captured_before=before_value;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dc_core_capture_organization_effect() FROM PUBLIC;
CREATE TRIGGER core_tenant_name_effect BEFORE UPDATE OF name ON tenants FOR EACH ROW WHEN(OLD.name IS DISTINCT FROM NEW.name) EXECUTE FUNCTION dc_core_capture_organization_effect();
CREATE TRIGGER core_settings_insert_effect BEFORE INSERT ON tenant_settings FOR EACH ROW EXECUTE FUNCTION dc_core_capture_organization_effect();
CREATE TRIGGER core_settings_update_effect BEFORE UPDATE OF locale,timezone ON tenant_settings FOR EACH ROW WHEN(ROW(OLD.locale,OLD.timezone) IS DISTINCT FROM ROW(NEW.locale,NEW.timezone)) EXECUTE FUNCTION dc_core_capture_organization_effect();
-- ทั้ง revision และ audit ต้องมี effect ที่ before/after ตรงข้อมูลจริง ไม่รับคำรับรองลอย ๆ
CREATE OR REPLACE FUNCTION dc_core_profile_effect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p public.tenant_core_profile_revisions; current_value jsonb; BEGIN
  IF TG_TABLE_NAME='tenant_core_config_audits' THEN
    IF NEW.resource_type<>'ORGANIZATION' THEN RETURN NEW; END IF;
  END IF;
  SELECT * INTO p FROM public.tenant_core_profile_revisions WHERE tenant_id=NEW.tenant_id;
  SELECT public.dc_core_organization_snapshot(NEW.tenant_id) INTO current_value;
  IF p.transaction_id IS DISTINCT FROM txid_current() OR p.captured_before IS NULL OR p.captured_before=current_value OR NOT EXISTS (
    SELECT 1 FROM public.tenant_core_config_audits a JOIN public.tenant_core_command_receipts r USING(tenant_id,actor_identity_key,command_id)
    WHERE a.tenant_id=NEW.tenant_id AND a.resource_type='ORGANIZATION' AND a.resource_id=NEW.tenant_id AND a.action='ORGANIZATION_UPDATE'
      AND a.transaction_id=txid_current() AND a.before_values=p.captured_before AND a.after_values=current_value
      AND a.before_revision=(p.captured_before->>'revision')::bigint AND a.after_revision=p.revision
      AND r.outcome='APPLIED' AND r.committed_revision=p.revision
  ) THEN RAISE EXCEPTION 'CORE_PROFILE_EFFECT_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER core_organization_audit_effect AFTER INSERT ON tenant_core_config_audits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_core_profile_effect_receipt();
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON tenant_core_profile_revisions FROM dcontact_app;
REVOKE TRIGGER ON tenants,tenant_settings,tenant_core_config_audits FROM dcontact_app;
