-- #998 1A: Admin ย้ายทีมของบัญชีใน Tenant People
-- ทำทุกขั้นใน function เดียวแบบเดียวกับ dc_people_accept_disable: ตรวจ scope, positive proof, fence, สถานะ,
-- idle และ revision แล้วแก้ users พร้อม ledger append-only ที่บอกว่าใครย้ายใครจากทีมไหนไปทีมไหนเพราะอะไร
-- ไม่แตะ Keycloak, TenantUserLifecycle (creation_team_id คงเดิม) หรือ tenant_identity_reservations
-- ทักษะ v1 ของทีมเดิมใช้กับคิวของทีมใหม่ไม่ได้ (skill ผูกทีม) จึงถอดออกพร้อมการย้ายทีม

CREATE TABLE tenant_people_team_changes (
  tenant_id uuid NOT NULL,
  command_id uuid NOT NULL,
  user_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  from_team_id uuid,
  to_team_id uuid NOT NULL,
  before_revision integer NOT NULL CHECK(before_revision>=1),
  removed_skill_ids uuid[] NOT NULL DEFAULT ARRAY[]::uuid[],
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,command_id),
  FOREIGN KEY(tenant_id,command_id) REFERENCES voice_config_commands(tenant_id,command_id),
  FOREIGN KEY(user_id) REFERENCES users(id),
  CHECK(from_team_id IS DISTINCT FROM to_team_id)
);
CREATE INDEX tenant_people_team_changes_user ON tenant_people_team_changes(tenant_id,user_id,created_at);
CREATE TRIGGER tenant_people_team_change_immutable BEFORE UPDATE OR DELETE ON tenant_people_team_changes
  FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();
ALTER TABLE tenant_people_team_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_people_team_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_people_team_changes
  USING (tenant_id=current_setting('app.tenant_id',true)::uuid)
  WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid);
REVOKE ALL ON tenant_people_team_changes FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dcontact_app') THEN
    REVOKE ALL ON tenant_people_team_changes FROM dcontact_app;
    GRANT SELECT ON tenant_people_team_changes TO dcontact_app;
  END IF;
END $$;

CREATE FUNCTION dc_people_apply_team_change(scope uuid, command uuid, new_team uuid, reason_text text,
  caller_issuer text, caller_client text, caller_slug text) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.voice_config_commands%ROWTYPE; target public.users%ROWTYPE; lifecycle_state text;
  closure record; removed uuid[];
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
  IF reason_text IS NULL OR char_length(btrim(reason_text)) NOT BETWEEN 1 AND 500 THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  -- positive proof เดียวกับ directory/disable ตรวจซ้ำใต้ lock ไม่เชื่อ snapshot ที่ caller อ่านก่อนหน้า
  IF public.dc_people_disable_snapshot(scope,accepted.resource_id,caller_issuer,caller_client,caller_slug) IS NULL THEN
    RAISE EXCEPTION 'PEOPLE_UPDATE_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO target FROM public.users WHERE tenant_id=scope AND id=accepted.resource_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR target.role NOT IN ('AGENT','SUPERVISOR','ADMIN') THEN
    RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF target.config_revision IS DISTINCT FROM accepted.expected_revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  IF target.team_id IS NOT DISTINCT FROM new_team
    OR NOT EXISTS(SELECT 1 FROM public.teams WHERE tenant_id=scope AND id=new_team AND is_active) THEN
    RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  -- ย้ายได้เฉพาะบัญชีที่ใช้งานได้ หรือ B2 ที่จัดเตรียมแล้วและรอเปิดใช้งาน; บัญชีปิดแล้ว (รวม legacy) ไม่ย้าย
  SELECT account_state INTO lifecycle_state FROM public.tenant_user_lifecycles WHERE tenant_id=scope AND user_id=target.id;
  IF lifecycle_state IN ('PROVISIONING','DISABLING','DISABLED','ATTENTION_REQUIRED')
    OR (NOT target.is_active AND lifecycle_state IS DISTINCT FROM 'PENDING_ACTIVATION')
    OR EXISTS(SELECT 1 FROM public.tenant_people_disables WHERE tenant_id=scope AND user_id=target.id
      AND state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED'))
    OR EXISTS(SELECT 1 FROM public.tenant_people_operations WHERE tenant_id=scope AND target_user_id=target.id
      AND state NOT IN ('SUCCEEDED','REJECTED'))
    THEN RAISE EXCEPTION 'ACCOUNT_STATE_CONFLICT' USING ERRCODE='23514'; END IF;
  -- Agent ที่ยังเปิด Workspace (work session lease ยังไม่หมด) ต้องออกก่อน เพื่อไม่ให้รับสายทีมใหม่โดยหน้าจอไม่รู้ตัว
  IF target.role='AGENT' AND EXISTS(SELECT 1 FROM public.agent_work_session_leases WHERE tenant_id=scope
      AND user_id=target.id AND released_at IS NULL AND expires_at > (clock_timestamp() AT TIME ZONE 'UTC'))
    THEN RAISE EXCEPTION 'AGENT_SESSION_ACTIVE' USING ERRCODE='23514'; END IF;
  SELECT * INTO closure FROM public.dc_people_disable_closure(scope,target.id);
  IF NOT public.dc_people_disable_idle(scope,target.id)
    OR public.dc_people_disable_pending(scope,closure.queue_ids,closure.user_ids)
    OR EXISTS(SELECT 1 FROM public.interactions WHERE tenant_id=scope AND state IN ('QUEUED','ASSIGNED','ACTIVE','WRAPUP')
      AND (agent_id=target.id OR metadata->>'targetAgentId'=target.id::text OR metadata->>'target_agent_id'=target.id::text))
    THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  PERFORM 1 FROM public.queues WHERE tenant_id=scope AND id=ANY(closure.queue_ids) ORDER BY id FOR UPDATE NOWAIT;
  WITH gone AS (
    DELETE FROM public.agent_skills a USING public.skills s
      WHERE a.tenant_id=scope AND a.user_id=target.id AND s.tenant_id=a.tenant_id AND s.id=a.skill_id
        AND s.voice_config_version=1 AND s.team_id IS DISTINCT FROM new_team
      RETURNING a.skill_id)
  SELECT coalesce(array_agg(skill_id ORDER BY skill_id),ARRAY[]::uuid[]) INTO removed FROM gone;
  UPDATE public.users SET team_id=new_team,config_revision=config_revision+1
    WHERE tenant_id=scope AND id=target.id AND config_revision=accepted.expected_revision;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  INSERT INTO public.tenant_people_team_changes(tenant_id,command_id,user_id,actor_user_id,from_team_id,to_team_id,
    before_revision,removed_skill_ids,reason)
    VALUES(scope,command,target.id,accepted.actor_user_id,target.team_id,new_team,accepted.expected_revision,removed,btrim(reason_text));
  RETURN accepted.expected_revision+1;
END $$;

REVOKE ALL ON FUNCTION dc_people_apply_team_change(uuid,uuid,uuid,text,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_apply_team_change(uuid,uuid,uuid,text,text,text,text) TO dcontact_app;

-- หลักฐานปลายทาง: คำสั่ง PEOPLE_UPDATE ที่ commit ต้องมี ledger, audit SUCCEEDED และ revision ที่ตรงกัน
CREATE FUNCTION dc_people_update_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command_kind<>'PEOPLE_UPDATE' THEN RETURN NULL; END IF;
  IF NEW.action<>'PEOPLE_TEAM_CHANGE'
    OR NOT EXISTS(SELECT 1 FROM tenant_people_team_changes c JOIN users u ON u.tenant_id=c.tenant_id AND u.id=c.user_id
      WHERE c.tenant_id=NEW.tenant_id AND c.command_id=NEW.command_id AND c.user_id=NEW.resource_id
        AND c.actor_user_id=NEW.actor_user_id AND c.before_revision=NEW.expected_revision
        AND u.config_revision>=NEW.expected_revision+1)
    OR NOT EXISTS(SELECT 1 FROM voice_config_audit WHERE tenant_id=NEW.tenant_id AND command_id=NEW.command_id
      AND actor_user_id=NEW.actor_user_id AND resource_id=NEW.resource_id AND action=NEW.action AND outcome='SUCCEEDED'
      AND before_revision=NEW.expected_revision AND after_revision=NEW.expected_revision+1)
    THEN RAISE EXCEPTION 'PEOPLE_UPDATE_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER people_update_final AFTER INSERT ON voice_config_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_people_update_final();
