-- #1054 LINE chat round one: a tenant's LINE Official Account reaches Agents through the same Router as
-- web chat. One LINE user of one channel is one long-lived conversation (ADR-023); every piece of work
-- in it is its own Interaction. Messages stay the outbox (ADR-024).

CREATE TABLE line_channels (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  queue_id uuid,
  -- the Channel ID shown in LINE Developers; for the Admin's reference only
  line_channel_id text NOT NULL DEFAULT '',
  -- the bot's user id from LINE; a webhook names it as `destination`
  bot_user_id text,
  bot_name text NOT NULL DEFAULT '',
  -- AES-256-GCM sealed with the account secret key, bound to the tenant and channel
  channel_secret_sealed text,
  access_token_sealed text,
  -- last characters, so the Admin can tell which secret is stored without reading it back
  channel_secret_hint text,
  access_token_hint text,
  credentials_verified_at timestamptz(3),
  auto_reply_text text NOT NULL DEFAULT '',
  idle_timeout_sec integer NOT NULL DEFAULT 1800,
  revision integer NOT NULL DEFAULT 1,
  updated_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT line_channels_queue_fkey
    FOREIGN KEY (tenant_id, queue_id) REFERENCES queues(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT line_channels_idle_check CHECK (idle_timeout_sec BETWEEN 60 AND 86400),
  CONSTRAINT line_channels_auto_reply_check CHECK (char_length(auto_reply_text) <= 500),
  CONSTRAINT line_channels_channel_id_check CHECK (char_length(line_channel_id) <= 32),
  -- An enabled channel must be able to take work and to verify and answer LINE.
  CONSTRAINT line_channels_enabled_check CHECK (NOT enabled OR (queue_id IS NOT NULL
    AND channel_secret_sealed IS NOT NULL AND access_token_sealed IS NOT NULL))
);
CREATE UNIQUE INDEX line_channels_one_per_tenant ON line_channels(tenant_id);

CREATE TABLE line_channel_audit_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  channel_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('CREATED', 'UPDATED')),
  changed_keys text[] NOT NULL DEFAULT '{}',
  -- never the secret or the token: only whether they are set and their hints
  before jsonb,
  after jsonb NOT NULL,
  correlation_id text NOT NULL,
  occurred_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT line_channel_audit_events_channel_fkey
    FOREIGN KEY (tenant_id, channel_id) REFERENCES line_channels(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX line_channel_audit_events_tenant_idx
  ON line_channel_audit_events(tenant_id, occurred_at DESC);

-- A LINE user of a channel, with the conversation that holds everything they wrote to it.
CREATE TABLE line_chat_users (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  channel_id uuid NOT NULL,
  line_user_id text NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  display_name text NOT NULL DEFAULT '',
  profile_fetched_at timestamptz(3),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT line_chat_users_channel_fkey
    FOREIGN KEY (tenant_id, channel_id) REFERENCES line_channels(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT line_chat_users_user_check CHECK (char_length(line_user_id) BETWEEN 1 AND 64),
  CONSTRAINT line_chat_users_name_check CHECK (char_length(display_name) <= 100)
);
CREATE UNIQUE INDEX line_chat_users_user_key ON line_chat_users(tenant_id, channel_id, line_user_id);
CREATE UNIQUE INDEX line_chat_users_conversation_key ON line_chat_users(tenant_id, conversation_id);

-- the outbox scan of LINE messages waiting to be sent, per tenant
CREATE INDEX messages_outbox_due_idx ON messages(tenant_id, next_attempt_at)
  WHERE status IN ('QUEUED', 'SENDING');

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['line_channels', 'line_channel_audit_events', 'line_chat_users'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') THEN
    GRANT SELECT, INSERT, UPDATE ON line_channels, line_chat_users TO dcontact_app;
    GRANT SELECT, INSERT ON line_channel_audit_events TO dcontact_app;
  END IF;
END $$;

-- A LINE chat records its result the same way as a web chat (VOICE_NOTE_V1).
CREATE OR REPLACE FUNCTION stamp_voice_wrapup_policy() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
  ELSIF NEW.channel IN ('WEBCHAT', 'LINE') THEN
    NEW.voice_wrapup_policy := 'VOICE_NOTE_V1';
  ELSE
    NEW.voice_wrapup_policy := 'LEGACY';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION check_voice_wrapup_result() RETURNS TRIGGER LANGUAGE plpgsql AS $$
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
    IF interaction_row.channel NOT IN ('VOICE', 'WEBCHAT', 'LINE')
      OR interaction_row.voice_wrapup_policy <> 'VOICE_NOTE_V1'
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
