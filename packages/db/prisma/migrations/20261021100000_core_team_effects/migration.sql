CREATE FUNCTION dc_team_provisioning_writer(p_tenant uuid) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE allowed boolean; BEGIN
  IF NOT pg_has_role(session_user,'dcontact_provisioner','MEMBER') THEN RETURN false; END IF;
  SELECT true INTO allowed FROM public.tenants WHERE id=p_tenant AND lifecycle_status='PROVISIONING' FOR SHARE NOWAIT;
  RETURN coalesce(allowed,false);
END $$;
REVOKE ALL ON FUNCTION dc_team_provisioning_writer(uuid) FROM PUBLIC;

ALTER TABLE teams ADD COLUMN revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),
  ADD COLUMN core_transaction_id bigint, ADD COLUMN core_captured_before jsonb;
CREATE FUNCTION dc_core_team_snapshot(p_tenant uuid,p_team uuid) RETURNS jsonb
LANGUAGE sql STABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_build_object('id',id,'name',name,'isActive',is_active,'revision',revision::text)
  FROM public.teams WHERE tenant_id=p_tenant AND id=p_team
$$;
CREATE FUNCTION dc_core_capture_team_effect() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF TG_OP='UPDATE' AND ROW(NEW.tenant_id,NEW.id) IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id) THEN
    RAISE EXCEPTION 'CORE_TEAM_IDENTITY_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    NEW.revision:=1; NEW.core_transaction_id:=NULL; NEW.core_captured_before:=NULL;
  ELSE
    IF NEW.revision IS DISTINCT FROM OLD.revision OR NEW.core_transaction_id IS DISTINCT FROM OLD.core_transaction_id OR NEW.core_captured_before IS DISTINCT FROM OLD.core_captured_before THEN
      RAISE EXCEPTION 'CORE_TEAM_METADATA_IMMUTABLE' USING ERRCODE='23514'; END IF;
    IF ROW(NEW.name,NEW.is_active) IS NOT DISTINCT FROM ROW(OLD.name,OLD.is_active) THEN RETURN NEW; END IF;
    IF OLD.core_transaction_id=txid_current() THEN RETURN NEW; END IF;
    NEW.revision:=OLD.revision+1;
  END IF;
  -- Owner นำเข้า fixture/legacy; application ไม่มีทางกำหนด metadata หรือข้าม receipt
  IF EXISTS(SELECT 1 FROM pg_catalog.pg_roles WHERE rolname=session_user AND rolsuper)
    OR public.dc_team_provisioning_writer(NEW.tenant_id) THEN
    NEW.core_transaction_id:=NULL; NEW.core_captured_before:=NULL; RETURN NEW; END IF;
  IF nullif(current_setting('app.tenant_id',true),'')::uuid IS DISTINCT FROM NEW.tenant_id
    OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=NEW.tenant_id AND lifecycle_status='ACTIVE') THEN
    RAISE EXCEPTION 'CORE_ACTIVE_TENANT_CONTEXT_REQUIRED' USING ERRCODE='23514'; END IF;
  NEW.core_transaction_id:=txid_current();
  IF TG_OP='UPDATE' THEN
    NEW.core_captured_before:=jsonb_build_object('id',OLD.id,'name',OLD.name,'isActive',OLD.is_active,'revision',OLD.revision::text);
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dc_core_capture_team_effect() FROM PUBLIC;
CREATE TRIGGER core_team_capture_effect BEFORE INSERT OR UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION dc_core_capture_team_effect();
CREATE FUNCTION dc_core_team_effect_receipt() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE row_team public.teams; resource uuid; tid uuid; snapshot jsonb; expected_action text; BEGIN
  IF TG_TABLE_NAME='teams' THEN
    IF TG_OP='UPDATE' THEN
      IF ROW(OLD.name,OLD.is_active) IS NOT DISTINCT FROM ROW(NEW.name,NEW.is_active) THEN RETURN NEW; END IF;
    END IF;
  END IF;
  IF TG_TABLE_NAME='tenant_core_config_audits' THEN
    IF NEW.resource_type<>'TEAM' THEN RETURN NEW; END IF;
    resource:=NEW.resource_id; tid:=NEW.tenant_id;
  ELSE resource:=NEW.id;tid:=NEW.tenant_id; END IF;
  SELECT * INTO row_team FROM public.teams WHERE tenant_id=tid AND id=resource;
  IF row_team.core_transaction_id IS NULL AND TG_TABLE_NAME='teams' THEN RETURN NEW; END IF;
  snapshot:=public.dc_core_team_snapshot(tid,resource);
  expected_action:=CASE WHEN row_team.core_captured_before IS NULL THEN 'TEAM_CREATE'
    WHEN (row_team.core_captured_before->>'isActive')::boolean AND NOT row_team.is_active THEN 'TEAM_DEACTIVATE' ELSE 'TEAM_RENAME' END;
  IF row_team.core_transaction_id IS DISTINCT FROM txid_current() OR NOT EXISTS(
    SELECT 1 FROM public.tenant_core_config_audits a JOIN public.tenant_core_command_receipts r USING(tenant_id,actor_identity_key,command_id)
    WHERE a.tenant_id=tid AND a.resource_type='TEAM' AND a.resource_id=resource AND a.action=expected_action
      AND a.transaction_id=txid_current() AND a.before_values IS NOT DISTINCT FROM row_team.core_captured_before
      AND a.after_values=snapshot AND a.after_revision=row_team.revision
      AND a.before_revision IS NOT DISTINCT FROM (row_team.core_captured_before->>'revision')::bigint
      AND r.outcome='APPLIED' AND r.committed_revision=row_team.revision
  ) THEN RAISE EXCEPTION 'CORE_TEAM_EFFECT_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER core_team_effect_receipt AFTER INSERT OR UPDATE ON teams DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_core_team_effect_receipt();
CREATE CONSTRAINT TRIGGER core_team_audit_effect AFTER INSERT ON tenant_core_config_audits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_core_team_effect_receipt();
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON teams FROM dcontact_app;
GRANT UPDATE(name,is_active) ON teams TO dcontact_app;
