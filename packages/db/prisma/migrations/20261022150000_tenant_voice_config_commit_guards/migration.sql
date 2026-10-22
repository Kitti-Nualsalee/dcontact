CREATE FUNCTION dc_voice_user_config_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE command voice_config_commands;
BEGIN
  IF current_user<>'dcontact_app' OR NEW.config_revision IS NOT DISTINCT FROM OLD.config_revision THEN RETURN NEW; END IF;
  SELECT * INTO command FROM voice_config_commands WHERE tenant_id=OLD.tenant_id
    AND command_id=nullif(current_setting('app.voice_config_command',true),'')::uuid
    AND resource_id=OLD.id AND action='AGENT_SKILLS_REPLACE' AND command_kind='CONFIG_UPDATE';
  IF command IS NULL OR OLD.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR (to_jsonb(NEW)-'config_revision') IS DISTINCT FROM (to_jsonb(OLD)-'config_revision')
    OR NOT EXISTS(SELECT 1 FROM users WHERE tenant_id=OLD.tenant_id AND id=command.actor_user_id AND role='ADMIN' AND is_active)
    OR EXISTS(SELECT 1 FROM voice_config_command_receipts WHERE tenant_id=OLD.tenant_id AND command_id=command.command_id)
  THEN RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
  IF command.expected_revision IS DISTINCT FROM OLD.config_revision OR NEW.config_revision<>OLD.config_revision+1 THEN
    RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||OLD.tenant_id::text,0)) THEN
    RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER voice_user_config_revision_guard BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION dc_voice_user_config_revision_guard();

CREATE FUNCTION dc_voice_config_update_final() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE final_revision integer;
BEGIN
  IF NEW.command_kind<>'CONFIG_UPDATE' OR NEW.action NOT IN
    ('QUEUE_UPDATE','QUEUE_REQUIRED_SKILLS_REPLACE','AGENT_SKILLS_REPLACE','DESTINATION_BINDING_UPDATE') THEN RETURN NULL; END IF;
  IF NEW.action='AGENT_SKILLS_REPLACE' THEN
    SELECT config_revision INTO final_revision FROM users WHERE tenant_id=NEW.tenant_id AND id=NEW.resource_id;
  ELSIF NEW.action='DESTINATION_BINDING_UPDATE' THEN
    SELECT config_revision INTO final_revision FROM voice_destinations WHERE tenant_id=NEW.tenant_id AND id=NEW.resource_id;
  ELSE
    SELECT config_revision INTO final_revision FROM queues WHERE tenant_id=NEW.tenant_id AND id=NEW.resource_id;
  END IF;
  IF NEW.expected_revision IS NULL OR NEW.expected_revision<1 OR final_revision IS NULL
    OR final_revision<>NEW.expected_revision+1 THEN
    RAISE EXCEPTION 'VOICE_CONFIG_FINAL_REVISION_REQUIRED' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM voice_config_audit WHERE tenant_id=NEW.tenant_id AND command_id=NEW.command_id
    AND actor_user_id=NEW.actor_user_id AND resource_id=NEW.resource_id AND action=NEW.action AND outcome='SUCCEEDED'
    AND before_revision=NEW.expected_revision AND after_revision=NEW.expected_revision+1)
    OR NOT EXISTS(SELECT 1 FROM voice_config_command_receipts WHERE tenant_id=NEW.tenant_id AND command_id=NEW.command_id) THEN
    RAISE EXCEPTION 'VOICE_CONFIG_FINAL_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER voice_config_update_final AFTER INSERT ON voice_config_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_voice_config_update_final();
