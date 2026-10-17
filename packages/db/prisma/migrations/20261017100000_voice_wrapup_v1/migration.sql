ALTER TABLE queues ADD COLUMN voice_wrapup_policy TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE queues ADD CONSTRAINT queues_voice_wrapup_policy_check
  CHECK (voice_wrapup_policy IN ('LEGACY', 'VOICE_NOTE_V1'));
ALTER TABLE interactions ADD COLUMN voice_wrapup_policy TEXT NOT NULL DEFAULT 'LEGACY';
ALTER TABLE interactions ADD CONSTRAINT interactions_voice_wrapup_policy_check
  CHECK (voice_wrapup_policy IN ('LEGACY', 'VOICE_NOTE_V1'));
CREATE UNIQUE INDEX interactions_tenant_id_id_agent_id_key ON interactions(tenant_id, id, agent_id);
ALTER TABLE command_receipts ADD COLUMN payload_digest TEXT;

CREATE TABLE interaction_wrapup_results (
  interaction_id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL,
  owner_agent_id UUID NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1 CHECK (policy_version = 1),
  disposition TEXT NOT NULL CHECK (disposition IN ('CUSTOMER_ASSISTED', 'FOLLOW_UP_REQUIRED')),
  note TEXT NOT NULL CHECK (char_length(note) BETWEEN 1 AND 2000),
  recorded_at TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  command_id UUID NOT NULL,
  CONSTRAINT interaction_wrapup_results_owner_fkey
    FOREIGN KEY (tenant_id, interaction_id, owner_agent_id)
    REFERENCES interactions(tenant_id, id, agent_id) ON DELETE NO ACTION ON UPDATE NO ACTION
);
CREATE INDEX interaction_wrapup_results_tenant_id_owner_agent_id_recorded_idx
  ON interaction_wrapup_results(tenant_id, owner_agent_id, recorded_at DESC, interaction_id DESC);
ALTER TABLE interaction_wrapup_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_wrapup_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON interaction_wrapup_results
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION stamp_voice_wrapup_policy() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE queue_policy TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.voice_wrapup_policy IS DISTINCT FROM OLD.voice_wrapup_policy THEN
      RAISE EXCEPTION 'WRAPUP_POLICY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.channel = 'VOICE' AND NEW.direction = 'INBOUND' AND NEW.queue_id IS NOT NULL THEN
    SELECT voice_wrapup_policy INTO queue_policy FROM queues
      WHERE tenant_id = NEW.tenant_id AND id = NEW.queue_id FOR SHARE;
    IF queue_policy = 'VOICE_NOTE_V1' THEN
      NEW.voice_wrapup_policy := 'VOICE_NOTE_V1';
    ELSE
      NEW.voice_wrapup_policy := 'LEGACY';
    END IF;
  ELSE
    NEW.voice_wrapup_policy := 'LEGACY';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER interactions_voice_wrapup_policy
  BEFORE INSERT OR UPDATE ON interactions FOR EACH ROW EXECUTE FUNCTION stamp_voice_wrapup_policy();

CREATE FUNCTION check_voice_wrapup_result() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE target_id UUID;
DECLARE target_tenant UUID;
DECLARE interaction_row interactions%ROWTYPE;
DECLARE result_row interaction_wrapup_results%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME = 'interactions' THEN
    target_id := NEW.id;
    target_tenant := NEW.tenant_id;
  ELSE
    target_id := NEW.interaction_id;
    target_tenant := NEW.tenant_id;
  END IF;
  SELECT * INTO interaction_row FROM interactions WHERE id = target_id AND tenant_id = target_tenant;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT * INTO result_row FROM interaction_wrapup_results
    WHERE interaction_id = target_id AND tenant_id = target_tenant;
  IF FOUND THEN
    IF interaction_row.channel <> 'VOICE' OR interaction_row.voice_wrapup_policy <> 'VOICE_NOTE_V1'
      OR interaction_row.state <> 'COMPLETED'
      OR interaction_row.agent_id IS DISTINCT FROM result_row.owner_agent_id
      OR interaction_row.wrap_up_code IS DISTINCT FROM result_row.disposition THEN
      RAISE EXCEPTION 'WRAPUP_RESULT_MISMATCH' USING ERRCODE = '23514';
    END IF;
  ELSIF interaction_row.voice_wrapup_policy = 'VOICE_NOTE_V1' AND interaction_row.state = 'COMPLETED' THEN
    RAISE EXCEPTION 'WRAPUP_V1_REQUIRED' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER interactions_wrapup_result_guard AFTER INSERT OR UPDATE ON interactions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_voice_wrapup_result();
CREATE CONSTRAINT TRIGGER wrapup_result_interaction_guard AFTER INSERT OR UPDATE ON interaction_wrapup_results
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_voice_wrapup_result();

DO $$
BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') THEN
    GRANT SELECT, INSERT ON interaction_wrapup_results TO dcontact_app;
    REVOKE UPDATE, DELETE ON interaction_wrapup_results FROM dcontact_app;
  END IF;
END $$;
