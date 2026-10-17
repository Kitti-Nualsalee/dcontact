-- B1: catalog แยก managed config marker จาก mandatory-note policy ของ A
ALTER TABLE queues ADD COLUMN config_revision integer NOT NULL DEFAULT 1 CHECK (config_revision >= 1),
  ADD COLUMN voice_config_version integer CHECK (voice_config_version = 1);
ALTER TABLE skills ADD COLUMN code text, ADD COLUMN team_id uuid,
  ADD COLUMN revision integer NOT NULL DEFAULT 1 CHECK (revision >= 1),
  ADD COLUMN voice_config_version integer CHECK (voice_config_version = 1),
  ADD COLUMN created_at timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
CREATE INDEX queues_tenant_created_id ON queues(tenant_id,created_at,id);
CREATE UNIQUE INDEX skills_tenant_id_code_key ON skills(tenant_id,code);
CREATE UNIQUE INDEX skills_tenant_id_id_key ON skills(tenant_id,id);
CREATE INDEX skills_tenant_created_id ON skills(tenant_id,created_at,id);
ALTER TABLE skills ADD CONSTRAINT skills_team_tenant_fk FOREIGN KEY (tenant_id,team_id) REFERENCES teams(tenant_id,id),
  ADD CONSTRAINT managed_skill_fields CHECK (voice_config_version IS NULL OR (team_id IS NOT NULL AND code ~ '^[A-Z][A-Z0-9_]{1,39}$'));
ALTER TABLE queues ADD CONSTRAINT managed_queue_fields CHECK (voice_config_version IS NULL OR (team_id IS NOT NULL AND voice_wrapup_policy='VOICE_NOTE_V1'));
CREATE TABLE voice_managed_queue_policies (
  tenant_id uuid NOT NULL, queue_id uuid NOT NULL, version integer NOT NULL DEFAULT 1 CHECK(version=1),
  offer_timeout_sec integer NOT NULL DEFAULT 20 CHECK(offer_timeout_sec=20),
  max_total_preanswer_sec integer NOT NULL DEFAULT 60 CHECK(max_total_preanswer_sec=60),
  terminal_action text NOT NULL DEFAULT 'HANGUP' CHECK(terminal_action='HANGUP'),
  skip_timed_out_agent boolean NOT NULL DEFAULT true CHECK(skip_timed_out_agent),
  PRIMARY KEY(tenant_id,queue_id), FOREIGN KEY(tenant_id,queue_id) REFERENCES queues(tenant_id,id)
);
CREATE TABLE tenant_voice_provisioning_policies (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id), revision integer NOT NULL CHECK(revision>=1),
  source_kind text NOT NULL CHECK(source_kind IN ('PLAN_SNAPSHOT','UAT_EXPLICIT')),
  source_plan_digest text, accounts_limit integer NOT NULL CHECK(accounts_limit BETWEEN 0 AND 1000000),
  agents_limit integer NOT NULL CHECK(agents_limit BETWEEN 0 AND 1000000),
  voice_queues_limit integer NOT NULL CHECK(voice_queues_limit BETWEEN 0 AND 1000000),
  skills_limit integer NOT NULL CHECK(skills_limit BETWEEN 0 AND 1000000),
  approved_by_operator_subject text NOT NULL CHECK(length(btrim(approved_by_operator_subject))>0),
  approved_at timestamptz NOT NULL, approval_ref text NOT NULL CHECK(length(btrim(approval_ref))>0),
  reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 1 AND 500),
  extension_pool jsonb NOT NULL DEFAULT '[]', destination_pool jsonb NOT NULL DEFAULT '[]',
  CHECK((source_kind='PLAN_SNAPSHOT' AND source_plan_digest IS NOT NULL AND source_plan_digest ~ '^[a-f0-9]{64}$') OR (source_kind='UAT_EXPLICIT' AND source_plan_digest IS NULL))
);
CREATE TABLE voice_config_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id), command_id uuid NOT NULL, actor_user_id uuid NOT NULL,
  action text NOT NULL, resource_id uuid NOT NULL, payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  expected_revision integer, command_kind text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,command_id)
);
CREATE TABLE voice_config_command_receipts (
  tenant_id uuid NOT NULL, command_id uuid NOT NULL, result_summary jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,command_id),
  FOREIGN KEY(tenant_id,command_id) REFERENCES voice_config_commands(tenant_id,command_id)
);
CREATE TABLE voice_config_audit (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor_user_id uuid NOT NULL,
  resource_id uuid, command_id uuid, action text NOT NULL, outcome text NOT NULL,
  before_revision integer, after_revision integer, changed_keys text[] NOT NULL DEFAULT '{}',
  reason_code text NOT NULL, correlation_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX voice_config_audit_resource ON voice_config_audit(tenant_id,resource_id,created_at,id);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['voice_managed_queue_policies','tenant_voice_provisioning_policies','voice_config_commands','voice_config_command_receipts','voice_config_audit'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',t);
  END LOOP;
END $$;
CREATE FUNCTION dc_voice_config_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'VOICE_CONFIG_APPEND_ONLY' USING ERRCODE='23514'; END $$;
CREATE TRIGGER voice_command_immutable BEFORE UPDATE OR DELETE ON voice_config_commands FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();
CREATE TRIGGER voice_receipt_immutable BEFORE UPDATE OR DELETE ON voice_config_command_receipts FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();
CREATE TRIGGER voice_audit_immutable BEFORE UPDATE OR DELETE ON voice_config_audit FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();
CREATE FUNCTION dc_voice_receipt_required() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM voice_config_command_receipts WHERE tenant_id=NEW.tenant_id AND command_id=NEW.command_id)
    THEN RAISE EXCEPTION 'VOICE_CONFIG_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER voice_receipt_required AFTER INSERT ON voice_config_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_voice_receipt_required();
-- runtime ได้ shared fence แม้เป็น writer รุ่นเดิม; config ไม่รอ reference row ที่ runtime ถืออยู่
CREATE FUNCTION dc_voice_runtime_fence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid; BEGIN
  IF TG_OP='DELETE' THEN tid:=OLD.tenant_id; ELSE tid:=NEW.tenant_id; END IF;
  IF TG_TABLE_NAME='interactions' THEN
    IF TG_OP='DELETE' THEN IF OLD.channel<>'VOICE' THEN RETURN OLD; END IF;
    ELSE IF NEW.channel<>'VOICE' THEN RETURN NEW; END IF; END IF;
  END IF;
  -- ทุก runtime writer รับ shared fence ก่อน policy ถูกสร้าง เพื่อครอบ in-flight writer รุ่นเดิม
  PERFORM pg_advisory_xact_lock_shared(hashtextextended('dc:v1:voice-config:'||tid::text,0));
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
CREATE TRIGGER voice_runtime_interaction_fence BEFORE INSERT OR UPDATE OR DELETE ON interactions FOR EACH ROW EXECUTE FUNCTION dc_voice_runtime_fence();
CREATE TRIGGER voice_runtime_user_fence BEFORE UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION dc_voice_runtime_fence();
CREATE TRIGGER voice_runtime_state_fence BEFORE INSERT OR UPDATE OR DELETE ON agent_state_logs FOR EACH ROW EXECUTE FUNCTION dc_voice_runtime_fence();
CREATE FUNCTION dc_voice_catalog_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; c voice_config_commands; cid uuid; managed boolean; BEGIN
  IF current_user <> 'dcontact_app' THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  IF TG_OP='DELETE' THEN r:=OLD; ELSE r:=NEW; END IF;
  managed:=r.voice_config_version IS NOT NULL;
  IF TG_OP='UPDATE' AND OLD.voice_config_version IS NOT NULL THEN managed:=true; END IF;
  IF NOT managed AND TG_TABLE_NAME='queues' THEN
    managed:=EXISTS(SELECT 1 FROM tenant_voice_provisioning_policies WHERE tenant_id=r.tenant_id) AND 'VOICE'=ANY(ARRAY(SELECT jsonb_array_elements_text(to_jsonb(r)->'channels')));
  END IF;
  IF NOT managed THEN IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF; END IF;
  cid:=nullif(current_setting('app.voice_config_command',true),'')::uuid;
  SELECT * INTO c FROM voice_config_commands WHERE tenant_id=r.tenant_id AND command_id=cid AND resource_id=r.id;
  IF c IS NULL OR c.action <> (CASE WHEN TG_TABLE_NAME='queues' THEN 'QUEUE_CREATE' ELSE 'SKILL_CREATE' END) OR TG_OP<>'INSERT'
    OR NOT EXISTS(SELECT 1 FROM users WHERE tenant_id=r.tenant_id AND id=c.actor_user_id AND role='ADMIN' AND is_active)
    OR r.voice_config_version IS DISTINCT FROM 1
    OR NOT EXISTS(SELECT 1 FROM teams WHERE tenant_id=r.tenant_id AND id=r.team_id AND is_active)
    THEN RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
  -- try-lock เป็น idempotent เมื่อ application ถืออยู่แล้ว; ไม่ยอม legacy writer แทรก
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||r.tenant_id::text,0)) THEN
    RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  IF TG_TABLE_NAME='queues' AND ((to_jsonb(r)->>'is_active')::boolean OR (to_jsonb(r)->>'recording_enabled')::boolean OR (to_jsonb(r)->>'auto_qm_enabled')::boolean OR to_jsonb(r)->>'transcription_mode'<>'OFF') THEN
    RAISE EXCEPTION 'CAPABILITY_NOT_READY' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voice_queue_config_guard BEFORE INSERT OR UPDATE OR DELETE ON queues FOR EACH ROW EXECUTE FUNCTION dc_voice_catalog_guard();
CREATE TRIGGER voice_skill_config_guard BEFORE INSERT OR UPDATE OR DELETE ON skills FOR EACH ROW EXECUTE FUNCTION dc_voice_catalog_guard();
-- SELECT FOR UPDATE ต้องการ UPDATE grant; narrow lock function ไม่ให้ app แก้ operator policy
CREATE FUNCTION dc_voice_lock_policy_refs(tid uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF tid IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='42501'; END IF;
  PERFORM tenant_id FROM public.tenant_voice_provisioning_policies WHERE tenant_id=tid FOR UPDATE NOWAIT;
  PERFORM tenant_id FROM public.tenant_plan_bindings WHERE tenant_id=tid FOR UPDATE NOWAIT;
END $$;
REVOKE ALL ON FUNCTION dc_voice_lock_policy_refs(uuid) FROM PUBLIC;
-- policy เป็น operator configuration ที่ revisioned/audited; app ไม่เขียนตารางนี้
CREATE TABLE tenant_voice_policy_audit (
  tenant_id uuid NOT NULL REFERENCES tenants(id), revision integer NOT NULL,
  source_kind text NOT NULL, source_plan_digest text, approved_by_operator_subject text NOT NULL,
  approved_at timestamptz NOT NULL, approval_ref text NOT NULL, reason text NOT NULL,
  caps jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,revision)
);
ALTER TABLE tenant_voice_policy_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_voice_policy_audit USING (tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true)::uuid);
CREATE TRIGGER voice_policy_audit_immutable BEFORE UPDATE OR DELETE ON tenant_voice_policy_audit FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();
CREATE FUNCTION dc_voice_policy_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'VOICE_POLICY_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||NEW.tenant_id::text,0)) THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  ELSIF NEW.revision<>1 THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM interactions WHERE tenant_id=NEW.tenant_id AND channel='VOICE' AND state IN ('QUEUED','ASSIGNED','ACTIVE','WRAPUP')) THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  INSERT INTO tenant_voice_policy_audit(tenant_id,revision,source_kind,source_plan_digest,approved_by_operator_subject,approved_at,approval_ref,reason,caps)
    VALUES(NEW.tenant_id,NEW.revision,NEW.source_kind,NEW.source_plan_digest,NEW.approved_by_operator_subject,NEW.approved_at,NEW.approval_ref,NEW.reason,jsonb_build_object('accounts',NEW.accounts_limit,'agents',NEW.agents_limit,'voiceQueues',NEW.voice_queues_limit,'skills',NEW.skills_limit));
  RETURN NEW;
END $$;
CREATE TRIGGER voice_policy_change BEFORE INSERT OR UPDATE OR DELETE ON tenant_voice_provisioning_policies FOR EACH ROW EXECUTE FUNCTION dc_voice_policy_change();
