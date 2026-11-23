-- #998 1A: Admin ย้ายทีมของบัญชีใน Tenant People
-- ทำทุกขั้นใน function เดียวแบบเดียวกับ dc_people_accept_disable: ตรวจ scope, fence, idle, revision แล้วแก้ users
-- ไม่แตะ Keycloak, TenantUserLifecycle (creation_team_id คงเดิม) หรือ tenant_identity_reservations
-- ทักษะ v1 ของทีมเดิมใช้กับคิวของทีมใหม่ไม่ได้ (skill ผูกทีม) จึงถอดออกพร้อมการย้ายทีม

CREATE FUNCTION dc_people_apply_team_change(scope uuid, command uuid, new_team uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.voice_config_commands%ROWTYPE; target public.users%ROWTYPE; lifecycle_state text; closure record;
BEGIN
  IF scope IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR NOT pg_has_role(session_user,'dcontact_app','MEMBER')
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls))
    THEN RAISE EXCEPTION 'PEOPLE_UPDATE_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||scope::text,0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:tenant-account:'||scope::text,0))
    THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  SELECT * INTO accepted FROM public.voice_config_commands WHERE tenant_id=scope AND command_id=command
    AND action='PEOPLE_TEAM_CHANGE' AND command_kind='PEOPLE_UPDATE';
  IF NOT FOUND
    OR EXISTS(SELECT 1 FROM public.voice_config_command_receipts WHERE tenant_id=scope AND command_id=command)
    OR NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=scope AND lifecycle_status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE tenant_id=scope AND id=accepted.actor_user_id AND role='ADMIN' AND is_active)
    THEN RAISE EXCEPTION 'PEOPLE_UPDATE_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO target FROM public.users WHERE tenant_id=scope AND id=accepted.resource_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR target.role NOT IN ('AGENT','SUPERVISOR','ADMIN') THEN
    RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF target.config_revision IS DISTINCT FROM accepted.expected_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  IF target.team_id IS NOT DISTINCT FROM new_team
    OR NOT EXISTS(SELECT 1 FROM public.teams WHERE tenant_id=scope AND id=new_team AND is_active) THEN
    RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  -- บัญชีที่กำลังจัดเตรียมหรือปิดอยู่ไม่ย้ายทีม (worker ใช้ snapshot เดิม)
  SELECT account_state INTO lifecycle_state FROM public.tenant_user_lifecycles WHERE tenant_id=scope AND user_id=target.id;
  IF lifecycle_state IN ('PROVISIONING','DISABLING','DISABLED','ATTENTION_REQUIRED')
    OR EXISTS(SELECT 1 FROM public.tenant_people_disables WHERE tenant_id=scope AND user_id=target.id
      AND state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED'))
    OR EXISTS(SELECT 1 FROM public.tenant_people_operations WHERE tenant_id=scope AND target_user_id=target.id
      AND state NOT IN ('SUCCEEDED','REJECTED'))
    THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  SELECT * INTO closure FROM public.dc_people_disable_closure(scope,target.id);
  IF NOT public.dc_people_disable_idle(scope,target.id)
    OR public.dc_people_disable_pending(scope,closure.queue_ids,closure.user_ids)
    OR EXISTS(SELECT 1 FROM public.interactions WHERE tenant_id=scope AND state IN ('QUEUED','ASSIGNED','ACTIVE','WRAPUP')
      AND (agent_id=target.id OR metadata->>'targetAgentId'=target.id::text OR metadata->>'target_agent_id'=target.id::text))
    THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  PERFORM 1 FROM public.queues WHERE tenant_id=scope AND id=ANY(closure.queue_ids) ORDER BY id FOR UPDATE NOWAIT;
  DELETE FROM public.agent_skills a USING public.skills s
    WHERE a.tenant_id=scope AND a.user_id=target.id AND s.tenant_id=a.tenant_id AND s.id=a.skill_id
      AND s.voice_config_version=1 AND s.team_id IS DISTINCT FROM new_team;
  UPDATE public.users SET team_id=new_team,config_revision=config_revision+1
    WHERE tenant_id=scope AND id=target.id AND config_revision=accepted.expected_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN accepted.expected_revision+1;
END $$;

REVOKE ALL ON FUNCTION dc_people_apply_team_change(uuid,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_apply_team_change(uuid,uuid,uuid) TO dcontact_app;
