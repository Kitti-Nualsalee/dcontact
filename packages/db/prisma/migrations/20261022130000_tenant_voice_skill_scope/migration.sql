BEGIN;

LOCK TABLE users, queues, skills, agent_skills, queue_skills IN ACCESS EXCLUSIVE MODE;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM agent_skills assignment
    LEFT JOIN users parent ON parent.id=assignment.user_id
    LEFT JOIN skills skill ON skill.id=assignment.skill_id
    WHERE parent.id IS NULL OR skill.id IS NULL OR parent.tenant_id<>skill.tenant_id
  ) OR EXISTS (
    SELECT 1 FROM queue_skills assignment
    LEFT JOIN queues parent ON parent.id=assignment.queue_id
    LEFT JOIN skills skill ON skill.id=assignment.skill_id
    WHERE parent.id IS NULL OR skill.id IS NULL OR parent.tenant_id<>skill.tenant_id
  ) THEN
    RAISE EXCEPTION 'SKILL_ASSIGNMENT_TENANT_CONTAMINATION' USING ERRCODE='23514';
  END IF;
END $$;

ALTER TABLE agent_skills ADD COLUMN tenant_id uuid;
ALTER TABLE queue_skills ADD COLUMN tenant_id uuid;
UPDATE agent_skills assignment SET tenant_id=parent.tenant_id FROM users parent WHERE parent.id=assignment.user_id;
UPDATE queue_skills assignment SET tenant_id=parent.tenant_id FROM queues parent WHERE parent.id=assignment.queue_id;

ALTER TABLE agent_skills
  ALTER COLUMN tenant_id SET NOT NULL,
  DROP CONSTRAINT agent_skills_user_id_fkey,
  DROP CONSTRAINT agent_skills_skill_id_fkey,
  ADD CONSTRAINT agent_skills_tenant_id_user_id_fkey FOREIGN KEY (tenant_id,user_id) REFERENCES users(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT agent_skills_tenant_id_skill_id_fkey FOREIGN KEY (tenant_id,skill_id) REFERENCES skills(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT agent_skills_level_check CHECK (level BETWEEN 1 AND 5);
ALTER TABLE queue_skills
  ALTER COLUMN tenant_id SET NOT NULL,
  DROP CONSTRAINT queue_skills_queue_id_fkey,
  DROP CONSTRAINT queue_skills_skill_id_fkey,
  ADD CONSTRAINT queue_skills_tenant_id_queue_id_fkey FOREIGN KEY (tenant_id,queue_id) REFERENCES queues(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT queue_skills_tenant_id_skill_id_fkey FOREIGN KEY (tenant_id,skill_id) REFERENCES skills(tenant_id,id) ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT queue_skills_min_level_check CHECK (min_level BETWEEN 1 AND 5);
CREATE INDEX agent_skills_tenant_id_skill_id_idx ON agent_skills(tenant_id,skill_id);
CREATE INDEX queue_skills_tenant_id_skill_id_idx ON queue_skills(tenant_id,skill_id);

ALTER TABLE voice_destinations
  ADD COLUMN config_revision integer NOT NULL DEFAULT 1 CHECK(config_revision>=1),
  ADD COLUMN voice_config_version integer CHECK(voice_config_version=1);

ALTER TABLE agent_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_skills FORCE ROW LEVEL SECURITY;
ALTER TABLE queue_skills ENABLE ROW LEVEL SECURITY;
ALTER TABLE queue_skills FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_skills
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);
CREATE POLICY tenant_isolation ON queue_skills
  USING (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid)
  WITH CHECK (tenant_id=nullif(current_setting('app.tenant_id',true),'')::uuid);

CREATE FUNCTION dc_voice_skill_assignment_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  assignment record;
  command voice_config_commands;
  resource uuid;
  action_name text;
  resource_team uuid;
  skill_team uuid;
  revision integer;
  managed boolean;
  affected_skills uuid[];
  affected_queues uuid[];
  affected_agents uuid[];
BEGIN
  IF TG_OP='DELETE' THEN assignment:=OLD; ELSE assignment:=NEW; END IF;
  IF TG_OP='UPDATE' AND (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.skill_id IS DISTINCT FROM OLD.skill_id
    OR (to_jsonb(NEW)->>'user_id') IS DISTINCT FROM (to_jsonb(OLD)->>'user_id')
    OR (to_jsonb(NEW)->>'queue_id') IS DISTINCT FROM (to_jsonb(OLD)->>'queue_id')
  ) THEN RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;

  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||assignment.tenant_id::text,0)) THEN
    RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03';
  END IF;
  IF current_user<>'dcontact_app' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  IF TG_TABLE_NAME='agent_skills' THEN
    resource:=assignment.user_id;
    action_name:='AGENT_SKILLS_REPLACE';
    SELECT team_id,config_revision INTO resource_team,revision FROM users WHERE tenant_id=assignment.tenant_id AND id=resource;
  ELSE
    resource:=assignment.queue_id;
    action_name:='QUEUE_REQUIRED_SKILLS_REPLACE';
    SELECT team_id,config_revision INTO resource_team,revision FROM queues WHERE tenant_id=assignment.tenant_id AND id=resource;
  END IF;
  SELECT team_id INTO skill_team FROM skills WHERE tenant_id=assignment.tenant_id AND id=assignment.skill_id;
  managed:=EXISTS(SELECT 1 FROM tenant_voice_provisioning_policies WHERE tenant_id=assignment.tenant_id)
    OR EXISTS(SELECT 1 FROM skills WHERE tenant_id=assignment.tenant_id AND id=assignment.skill_id AND voice_config_version=1)
    OR EXISTS(SELECT 1 FROM queues WHERE tenant_id=assignment.tenant_id AND voice_config_version=1 AND
      (id=resource OR id IN (SELECT queue_id FROM queue_skills WHERE tenant_id=assignment.tenant_id AND skill_id=assignment.skill_id)));
  IF NOT managed THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;

  SELECT * INTO command FROM voice_config_commands
    WHERE tenant_id=assignment.tenant_id AND command_id=nullif(current_setting('app.voice_config_command',true),'')::uuid
      AND resource_id=resource AND action=action_name AND command_kind='CONFIG_UPDATE';
  IF command IS NULL OR assignment.tenant_id IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR EXISTS(SELECT 1 FROM voice_config_command_receipts WHERE tenant_id=assignment.tenant_id AND command_id=command.command_id)
    OR NOT EXISTS(SELECT 1 FROM users WHERE tenant_id=assignment.tenant_id AND id=command.actor_user_id AND role='ADMIN' AND is_active)
  THEN RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
  IF command.expected_revision IS DISTINCT FROM revision THEN
    RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514';
  END IF;
  IF TG_OP<>'DELETE' AND (resource_team IS NULL OR skill_team IS DISTINCT FROM resource_team
    OR (TG_TABLE_NAME='agent_skills' AND NOT EXISTS(SELECT 1 FROM users WHERE tenant_id=assignment.tenant_id AND id=resource AND role='AGENT')))
  THEN RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;

  SELECT array_agg(DISTINCT skill_id) INTO affected_skills FROM (
    SELECT assignment.skill_id AS skill_id
    UNION ALL SELECT skill_id FROM agent_skills WHERE tenant_id=assignment.tenant_id AND user_id=resource
    UNION ALL SELECT skill_id FROM queue_skills WHERE tenant_id=assignment.tenant_id AND queue_id=resource
  ) skill_refs;
  SELECT array_agg(id ORDER BY id) INTO affected_queues FROM queues WHERE tenant_id=assignment.tenant_id AND (
    id=resource OR id IN (SELECT queue_id FROM queue_skills WHERE tenant_id=assignment.tenant_id AND skill_id=ANY(affected_skills))
    OR (TG_TABLE_NAME='agent_skills' AND NOT EXISTS(SELECT 1 FROM queue_skills WHERE tenant_id=assignment.tenant_id AND queue_id=queues.id))
  );
  SELECT array_agg(id ORDER BY id) INTO affected_agents FROM users WHERE tenant_id=assignment.tenant_id AND (
    id=resource OR (TG_TABLE_NAME='queue_skills' AND role='AGENT' AND (team_id=resource_team OR id IN (
      SELECT user_id FROM agent_skills WHERE tenant_id=assignment.tenant_id AND skill_id=ANY(affected_skills)
    )))
  );
  PERFORM id FROM users WHERE tenant_id=assignment.tenant_id AND (id=ANY(affected_agents) OR id=command.actor_user_id) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM queues WHERE tenant_id=assignment.tenant_id AND id=ANY(affected_queues) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM skills WHERE tenant_id=assignment.tenant_id AND id=ANY(affected_skills) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM dc_team_reference_lock(assignment.tenant_id,ARRAY[resource_team,skill_team],false);
  PERFORM id FROM teams WHERE tenant_id=assignment.tenant_id AND id IN (resource_team,skill_team) ORDER BY id FOR UPDATE NOWAIT;
  IF TG_OP<>'DELETE' AND NOT EXISTS(SELECT 1 FROM teams WHERE tenant_id=assignment.tenant_id AND id=resource_team AND is_active) THEN
    RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM interactions WHERE tenant_id=assignment.tenant_id AND channel='VOICE'
    AND state IN ('QUEUED','ASSIGNED','ACTIVE','WRAPUP') AND (queue_id=ANY(affected_queues) OR agent_id=ANY(affected_agents)
      OR metadata->>'targetAgentId'=ANY(affected_agents::text[]) OR metadata->>'target_agent_id'=ANY(affected_agents::text[]))) THEN
    RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03';
  END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;

CREATE TRIGGER voice_agent_skill_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON agent_skills
  FOR EACH ROW EXECUTE FUNCTION dc_voice_skill_assignment_guard();
CREATE TRIGGER voice_queue_skill_assignment_guard BEFORE INSERT OR UPDATE OR DELETE ON queue_skills
  FOR EACH ROW EXECUTE FUNCTION dc_voice_skill_assignment_guard();

CREATE FUNCTION dc_voice_routing_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  previous jsonb;
  following jsonb;
  scope uuid;
  resource uuid;
  command voice_config_commands;
  affected_queues uuid[];
  affected_agents uuid[];
  affected_skills uuid[];
  affected_teams uuid[];
  managed boolean;
BEGIN
  IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN following:=to_jsonb(NEW); END IF;
  scope:=(coalesce(following,previous)->>'tenant_id')::uuid;
  resource:=(coalesce(following,previous)->>'id')::uuid;
  IF current_user<>'dcontact_app' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||scope::text,0)) THEN
    RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03';
  END IF;
  managed:=previous->>'voice_config_version' IS NOT NULL OR following->>'voice_config_version' IS NOT NULL
    OR (EXISTS(SELECT 1 FROM tenant_voice_provisioning_policies WHERE tenant_id=scope)
      AND (TG_TABLE_NAME='voice_destinations' OR coalesce(following,previous)->'channels' ? 'VOICE'))
    OR (TG_TABLE_NAME='voice_destinations' AND EXISTS(SELECT 1 FROM queues WHERE tenant_id=scope
      AND voice_config_version=1 AND id IN ((previous->>'queue_id')::uuid,(following->>'queue_id')::uuid)));
  IF NOT managed THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||scope::text,0)) THEN
    RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03';
  END IF;
  SELECT * INTO command FROM voice_config_commands WHERE tenant_id=scope
    AND command_id=nullif(current_setting('app.voice_config_command',true),'')::uuid
    AND resource_id=resource AND command_kind='CONFIG_UPDATE'
    AND action=ANY(CASE WHEN TG_TABLE_NAME='queues' THEN ARRAY['QUEUE_UPDATE','QUEUE_REQUIRED_SKILLS_REPLACE'] ELSE ARRAY['DESTINATION_BINDING_UPDATE'] END);
  IF TG_OP<>'UPDATE' OR command IS NULL OR scope IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR NOT EXISTS(SELECT 1 FROM users WHERE tenant_id=scope AND id=command.actor_user_id AND role='ADMIN' AND is_active)
    OR EXISTS(SELECT 1 FROM voice_config_command_receipts WHERE tenant_id=scope AND command_id=command.command_id)
    OR following->>'tenant_id' IS DISTINCT FROM previous->>'tenant_id'
    OR following->>'id' IS DISTINCT FROM previous->>'id'
    OR previous->>'voice_config_version' IS DISTINCT FROM '1'
    OR following->>'voice_config_version' IS DISTINCT FROM '1'
  THEN RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
  IF command.expected_revision IS DISTINCT FROM (previous->>'config_revision')::integer
    OR (following->>'config_revision')::integer<>(previous->>'config_revision')::integer+1 THEN
    RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514';
  END IF;
  IF (following->>'is_active')::boolean THEN RAISE EXCEPTION 'CAPABILITY_NOT_READY' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='queues' THEN
    IF (following - CASE WHEN command.action='QUEUE_UPDATE' THEN ARRAY['name','is_active','config_revision'] ELSE ARRAY['config_revision'] END)
      IS DISTINCT FROM (previous - CASE WHEN command.action='QUEUE_UPDATE' THEN ARRAY['name','is_active','config_revision'] ELSE ARRAY['config_revision'] END)
    THEN RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
    affected_queues:=ARRAY[resource];
  ELSE
    IF (following-ARRAY['queue_id','entry_mode','is_active','config_revision','updated_at'])
      IS DISTINCT FROM (previous-ARRAY['queue_id','entry_mode','is_active','config_revision','updated_at'])
      OR following->>'entry_mode'<>'DIRECT_QUEUE' THEN
      RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
    affected_queues:=ARRAY[(previous->>'queue_id')::uuid,(following->>'queue_id')::uuid];
    IF NOT EXISTS(SELECT 1 FROM tenant_voice_provisioning_policies WHERE tenant_id=scope
      AND destination_pool @> jsonb_build_array(jsonb_build_object('destinationId',resource::text))) THEN
      RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  END IF;
  SELECT array_agg(DISTINCT skill_id) INTO affected_skills FROM queue_skills WHERE tenant_id=scope AND queue_id=ANY(affected_queues);
  SELECT array_agg(DISTINCT team_id) INTO affected_teams FROM queues WHERE tenant_id=scope AND id=ANY(affected_queues);
  SELECT array_agg(id ORDER BY id) INTO affected_agents FROM users WHERE tenant_id=scope AND role='AGENT' AND
    (team_id=ANY(affected_teams) OR id IN(SELECT user_id FROM agent_skills WHERE tenant_id=scope AND skill_id=ANY(affected_skills)));
  PERFORM id FROM users WHERE tenant_id=scope AND (id=command.actor_user_id OR id=ANY(affected_agents)) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM queues WHERE tenant_id=scope AND id=ANY(affected_queues) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM id FROM skills WHERE tenant_id=scope AND id=ANY(affected_skills) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM dc_team_reference_lock(scope,affected_teams,false);
  PERFORM id FROM teams WHERE tenant_id=scope AND id=ANY(affected_teams) ORDER BY id FOR UPDATE NOWAIT;
  IF TG_TABLE_NAME='voice_destinations' AND NOT EXISTS(SELECT 1 FROM queues WHERE tenant_id=scope
    AND id=(following->>'queue_id')::uuid AND voice_config_version=1 AND 'VOICE'=ANY(channels)) THEN
    RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM interactions WHERE tenant_id=scope AND channel='VOICE' AND state IN ('QUEUED','ASSIGNED','ACTIVE','WRAPUP')
    AND (queue_id=ANY(affected_queues) OR agent_id=ANY(affected_agents)
      OR metadata->>'targetAgentId'=ANY(affected_agents::text[]) OR metadata->>'target_agent_id'=ANY(affected_agents::text[]))) THEN
    RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  RETURN NEW;
END $$;

DROP TRIGGER voice_queue_config_guard ON queues;
CREATE TRIGGER voice_queue_config_guard BEFORE INSERT ON queues FOR EACH ROW EXECUTE FUNCTION dc_voice_catalog_guard();
CREATE TRIGGER voice_queue_update_guard BEFORE UPDATE OR DELETE ON queues FOR EACH ROW EXECUTE FUNCTION dc_voice_routing_update_guard();
CREATE TRIGGER voice_destination_update_guard BEFORE INSERT OR UPDATE OR DELETE ON voice_destinations FOR EACH ROW EXECUTE FUNCTION dc_voice_routing_update_guard();

COMMIT;
