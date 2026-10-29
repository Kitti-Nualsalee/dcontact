BEGIN;

CREATE TABLE voice_managed_runtime_readiness (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  telephony_node_id text NOT NULL CHECK(length(btrim(telephony_node_id))>0),
  version integer NOT NULL DEFAULT 1 CHECK(version=1),
  direct_wired boolean NOT NULL,
  expires_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,telephony_node_id)
);

CREATE FUNCTION dc_voice_managed_runtime_ready(tid uuid,node_id text DEFAULT NULL) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT tid=nullif(current_setting('app.tenant_id',true),'')::uuid AND EXISTS(
    SELECT 1 FROM voice_managed_runtime_readiness
    WHERE tenant_id=tid AND (node_id IS NULL OR telephony_node_id=node_id)
      AND version=1 AND direct_wired AND expires_at>statement_timestamp()
  )
$$;

CREATE TABLE voice_managed_calls (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  interaction_id uuid NOT NULL,
  telephony_node_id text NOT NULL,
  call_uuid text NOT NULL,
  first_queue_entered_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  preanswer_deadline timestamptz NOT NULL,
  current_offer_id uuid,
  terminal_reason text CHECK(terminal_reason IN ('PREANSWER_DEADLINE_EXCEEDED','CALLER_CANCELLED','AGENT_HANGUP')),
  PRIMARY KEY(tenant_id,interaction_id),
  UNIQUE(tenant_id,telephony_node_id,call_uuid),
  CHECK(preanswer_deadline=first_queue_entered_at+interval '60 seconds')
);
CREATE UNIQUE INDEX interactions_tenant_managed_id ON interactions(tenant_id,id);
ALTER TABLE voice_managed_calls ADD FOREIGN KEY(tenant_id,interaction_id) REFERENCES interactions(tenant_id,id);

CREATE TABLE voice_managed_offers (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  interaction_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  agent_extension text NOT NULL,
  bleg_uuid uuid NOT NULL UNIQUE,
  assigned_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('PENDING','ANSWERED','TIMED_OUT','CANCELLED','ENDED')),
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,interaction_id) REFERENCES voice_managed_calls(tenant_id,interaction_id),
  FOREIGN KEY(tenant_id,agent_id) REFERENCES users(tenant_id,id),
  CHECK(expires_at>assigned_at AND expires_at<=assigned_at+interval '20 seconds')
);
CREATE UNIQUE INDEX voice_managed_one_pending_offer ON voice_managed_offers(tenant_id,interaction_id) WHERE outcome='PENDING';
ALTER TABLE voice_managed_calls ADD FOREIGN KEY(tenant_id,current_offer_id) REFERENCES voice_managed_offers(tenant_id,id);

CREATE TABLE voice_managed_commands (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  interaction_id uuid NOT NULL,
  telephony_node_id text NOT NULL,
  call_uuid text NOT NULL,
  offer_id uuid,
  command_type text NOT NULL CHECK(command_type IN ('offer.create','call.bridge','call.hangup','offer.cancel')),
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','CONFIRMED','OBSOLETE')),
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,interaction_id) REFERENCES voice_managed_calls(tenant_id,interaction_id),
  FOREIGN KEY(tenant_id,offer_id) REFERENCES voice_managed_offers(tenant_id,id)
);
CREATE INDEX voice_managed_pending_commands ON voice_managed_commands(tenant_id,telephony_node_id,created_at,id) WHERE status='PENDING';

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['voice_managed_runtime_readiness','voice_managed_calls','voice_managed_offers','voice_managed_commands'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  END LOOP;
END $$;

CREATE FUNCTION dc_voice_managed_activation_check(scope uuid,following jsonb,table_name text) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE qid uuid; node_id text; BEGIN
  qid:=CASE WHEN table_name='queues' THEN (following->>'id')::uuid ELSE (following->>'queue_id')::uuid END;
  IF table_name='voice_destinations' THEN
    SELECT item->>'telephonyNodeId' INTO node_id
    FROM tenant_voice_provisioning_policies p CROSS JOIN LATERAL jsonb_array_elements(p.destination_pool) item
    WHERE p.tenant_id=scope AND item->>'destinationId'=following->>'id';
    IF node_id IS NULL OR length(btrim(node_id))=0 OR NOT EXISTS(
      SELECT 1 FROM queues WHERE tenant_id=scope AND id=qid AND is_active AND voice_config_version=1
    ) THEN RAISE EXCEPTION 'CAPABILITY_NOT_READY' USING ERRCODE='23514'; END IF;
  END IF;
  IF NOT dc_voice_managed_runtime_ready(scope,node_id) THEN
    RAISE EXCEPTION 'CAPABILITY_NOT_READY' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM queues WHERE tenant_id=scope AND id=qid AND voice_config_version=1
    AND NOT recording_enabled AND NOT auto_qm_enabled AND transcription_mode='OFF' AND routing_strategy='LONGEST_AVAILABLE_IDLE') THEN
    RAISE EXCEPTION 'RESOURCE_POLICY_NOT_READY' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM voice_managed_queue_policies WHERE tenant_id=scope AND queue_id=qid
      AND version=1 AND offer_timeout_sec=20 AND max_total_preanswer_sec=60 AND terminal_action='HANGUP' AND skip_timed_out_agent)
    OR NOT EXISTS(SELECT 1 FROM queue_skills WHERE tenant_id=scope AND queue_id=qid)
    OR EXISTS(SELECT 1 FROM queue_skills qs JOIN queues q ON q.tenant_id=qs.tenant_id AND q.id=qs.queue_id
      JOIN skills s ON s.tenant_id=qs.tenant_id AND s.id=qs.skill_id
      WHERE qs.tenant_id=scope AND qs.queue_id=qid AND (s.team_id IS DISTINCT FROM q.team_id OR qs.min_level NOT BETWEEN 1 AND 5))
  THEN RAISE EXCEPTION 'RESOURCE_POLICY_NOT_READY' USING ERRCODE='23514'; END IF;
END $$;

DO $$ DECLARE definition text; original text; BEGIN
  SELECT pg_get_functiondef('dc_voice_routing_update_guard()'::regprocedure) INTO original;
  definition:=replace(original,
    'IF (following->>''is_active'')::boolean THEN RAISE EXCEPTION ''CAPABILITY_NOT_READY'' USING ERRCODE=''23514''; END IF;',
    'IF (following->>''is_active'')::boolean THEN PERFORM dc_voice_managed_activation_check(scope,following,TG_TABLE_NAME); END IF;');
  IF definition=original THEN RAISE EXCEPTION 'MANAGED_ACTIVATION_GUARD_BASELINE_MISMATCH'; END IF;
  EXECUTE definition;
END $$;

CREATE FUNCTION dc_voice_managed_interaction_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user<>'dcontact_app' THEN
    IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.channel='VOICE' AND EXISTS(SELECT 1 FROM queues WHERE tenant_id=NEW.tenant_id AND id=NEW.queue_id AND voice_config_version=1)
      AND current_setting('app.voice_managed_runtime',true) IS DISTINCT FROM '1'
    THEN RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
  ELSIF EXISTS(SELECT 1 FROM voice_managed_calls WHERE tenant_id=OLD.tenant_id AND interaction_id=OLD.id) THEN
    IF TG_OP='DELETE' THEN RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
    IF (NEW.state IS DISTINCT FROM OLD.state AND NOT (OLD.state='WRAPUP' AND NEW.state='COMPLETED'))
      OR NEW.agent_id IS DISTINCT FROM OLD.agent_id OR NEW.queue_id IS DISTINCT FROM OLD.queue_id
      OR NEW.offer_expires_at IS DISTINCT FROM OLD.offer_expires_at OR NEW.external_id IS DISTINCT FROM OLD.external_id
    THEN
      IF current_setting('app.voice_managed_runtime',true) IS DISTINCT FROM '1' THEN
        RAISE EXCEPTION 'VOICE_CONFIG_V1_REQUIRED' USING ERRCODE='23514'; END IF;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voice_managed_interaction_guard BEFORE INSERT OR UPDATE OR DELETE ON interactions
FOR EACH ROW EXECUTE FUNCTION dc_voice_managed_interaction_guard();

CREATE FUNCTION dc_voice_managed_requirements_final() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tid uuid; qid uuid; BEGIN
  IF current_user<>'dcontact_app' THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' THEN tid:=OLD.tenant_id; qid:=OLD.queue_id;
  ELSE tid:=NEW.tenant_id; qid:=NEW.queue_id; END IF;
  IF EXISTS(SELECT 1 FROM queues WHERE tenant_id=tid AND id=qid AND voice_config_version=1 AND is_active)
    AND NOT EXISTS(SELECT 1 FROM queue_skills WHERE tenant_id=tid AND queue_id=qid)
  THEN RAISE EXCEPTION 'RESOURCE_POLICY_NOT_READY' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER voice_managed_requirements_final AFTER INSERT OR UPDATE OR DELETE ON queue_skills
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_voice_managed_requirements_final();

CREATE FUNCTION dc_voice_managed_durable_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME='voice_managed_calls' THEN
  IF (
    NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.interaction_id IS DISTINCT FROM OLD.interaction_id
    OR NEW.telephony_node_id IS DISTINCT FROM OLD.telephony_node_id OR NEW.call_uuid IS DISTINCT FROM OLD.call_uuid
    OR NEW.first_queue_entered_at IS DISTINCT FROM OLD.first_queue_entered_at OR NEW.preanswer_deadline IS DISTINCT FROM OLD.preanswer_deadline
    OR (OLD.terminal_reason IS NOT NULL AND NEW.terminal_reason IS DISTINCT FROM OLD.terminal_reason)
  ) THEN RAISE EXCEPTION 'MANAGED_RUNTIME_IMMUTABLE' USING ERRCODE='23514'; END IF;
  END IF;
  IF TG_TABLE_NAME='voice_managed_commands' AND
    (to_jsonb(NEW)-ARRAY['status','attempts','last_error','confirmed_at']) IS DISTINCT FROM
    (to_jsonb(OLD)-ARRAY['status','attempts','last_error','confirmed_at'])
  THEN RAISE EXCEPTION 'MANAGED_RUNTIME_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER voice_managed_calls_durable_guard BEFORE UPDATE ON voice_managed_calls
FOR EACH ROW EXECUTE FUNCTION dc_voice_managed_durable_guard();
CREATE TRIGGER voice_managed_commands_durable_guard BEFORE UPDATE ON voice_managed_commands
FOR EACH ROW EXECUTE FUNCTION dc_voice_managed_durable_guard();

COMMIT;
