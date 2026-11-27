-- #1044 Webchat round one: a visitor chats from an embedded widget with an Agent.
-- The thread and its messages reuse conversations/messages (ADR-023, ADR-024) and the work item is an
-- Interaction with channel WEBCHAT (ADR-001). The tables below hold only what those models do not have.

-- conversations and messages still have their first shape: the Prisma models moved to ADR-023 and
-- ADR-024 but no migration followed, and no code has written to either table. This brings both tables
-- to the models. Existing rows, if any, keep their thread: the Interaction now points at it.
-- message_attachments is left for the work that adds attachments.
CREATE TYPE "ConversationState" AS ENUM ('OPEN', 'IDLE', 'RESOLVED', 'BLOCKED');
CREATE TYPE "MessageDeliveryStatus" AS ENUM
  ('RECEIVED', 'QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'READ', 'FAILED');

UPDATE interactions i SET conversation_id = c.id
  FROM conversations c
  WHERE c.interaction_id = i.id AND c.tenant_id = i.tenant_id AND i.conversation_id IS NULL;

DROP INDEX "conversations_tenant_id_external_thread_id_idx";
ALTER TABLE "conversations" DROP COLUMN "interaction_id",
  ADD COLUMN "blocked_reason" TEXT,
  ADD COLUMN "channel_account_id" TEXT,
  ADD COLUMN "contact_id" UUID,
  ADD COLUMN "last_agent_message_at" TIMESTAMP(3),
  ADD COLUMN "last_customer_message_at" TIMESTAMP(3),
  ADD COLUMN "last_resolved_at" TIMESTAMP(3),
  ADD COLUMN "state" "ConversationState" NOT NULL DEFAULT 'OPEN';
UPDATE "conversations"
  SET "channel_account_id" = 'legacy', "external_thread_id" = COALESCE("external_thread_id", "id"::text);
ALTER TABLE "conversations"
  ALTER COLUMN "channel_account_id" SET NOT NULL,
  ALTER COLUMN "external_thread_id" SET NOT NULL;
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_contact_id_fkey"
  FOREIGN KEY ("contact_id") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "conversations_tenant_id_state_last_customer_message_at_idx"
  ON "conversations"("tenant_id", "state", "last_customer_message_at");
CREATE INDEX "conversations_tenant_id_contact_id_idx" ON "conversations"("tenant_id", "contact_id");
CREATE UNIQUE INDEX "conversations_tenant_id_channel_channel_account_id_external_key"
  ON "conversations"("tenant_id", "channel", "channel_account_id", "external_thread_id");

ALTER TABLE "messages" RENAME COLUMN "external_id" TO "provider_message_id";
ALTER TABLE "messages"
  ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "channel_account_id" TEXT,
  ADD COLUMN "client_token" TEXT,
  ADD COLUMN "delivered_at" TIMESTAMP(3),
  ADD COLUMN "failure_code" TEXT,
  ADD COLUMN "failure_reason" TEXT,
  ADD COLUMN "interaction_id" UUID,
  ADD COLUMN "locked_at" TIMESTAMP(3),
  ADD COLUMN "locked_by" TEXT,
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "read_at" TIMESTAMP(3),
  ADD COLUMN "sent_at" TIMESTAMP(3),
  ADD COLUMN "status" "MessageDeliveryStatus" NOT NULL DEFAULT 'RECEIVED';
UPDATE "messages" m SET "channel_account_id" = c."channel_account_id"
  FROM "conversations" c WHERE c."id" = m."conversation_id";
ALTER TABLE "messages" ALTER COLUMN "channel_account_id" SET NOT NULL;
ALTER TABLE "messages" ADD CONSTRAINT "messages_interaction_id_fkey"
  FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "messages_tenant_id_interaction_id_idx" ON "messages"("tenant_id", "interaction_id");
CREATE INDEX "messages_status_next_attempt_at_idx" ON "messages"("status", "next_attempt_at");
CREATE UNIQUE INDEX "messages_tenant_id_channel_account_id_provider_message_id_key"
  ON "messages"("tenant_id", "channel_account_id", "provider_message_id");
CREATE UNIQUE INDEX "messages_tenant_id_client_token_key" ON "messages"("tenant_id", "client_token");

-- Widget configuration. Round one allows a single widget per tenant; dropping
-- webchat_widgets_one_per_tenant is the only schema change needed to allow several.
CREATE TABLE webchat_widgets (
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  enabled boolean NOT NULL DEFAULT false,
  queue_id uuid,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  greeting_th text NOT NULL DEFAULT '',
  greeting_en text NOT NULL DEFAULT '',
  max_chats_per_agent integer NOT NULL DEFAULT 3,
  idle_timeout_sec integer NOT NULL DEFAULT 600,
  revision integer NOT NULL DEFAULT 1,
  updated_by_user_id uuid,
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  updated_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT webchat_widgets_queue_fkey
    FOREIGN KEY (tenant_id, queue_id) REFERENCES queues(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT webchat_widgets_capacity_check CHECK (max_chats_per_agent BETWEEN 1 AND 10),
  CONSTRAINT webchat_widgets_idle_check CHECK (idle_timeout_sec BETWEEN 60 AND 3600),
  CONSTRAINT webchat_widgets_greeting_check
    CHECK (char_length(greeting_th) <= 500 AND char_length(greeting_en) <= 500),
  CONSTRAINT webchat_widgets_origins_check CHECK (cardinality(allowed_origins) <= 20),
  -- An enabled widget must be able to take work and must name where it may be embedded.
  CONSTRAINT webchat_widgets_enabled_check
    CHECK (NOT enabled OR (queue_id IS NOT NULL AND cardinality(allowed_origins) > 0))
);
CREATE UNIQUE INDEX webchat_widgets_one_per_tenant ON webchat_widgets(tenant_id);

-- Who changed the widget and which settings changed. Append-only for the application role.
CREATE TABLE webchat_widget_audit_events (
  id uuid NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
  widget_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  action text NOT NULL CHECK (action IN ('CREATED', 'UPDATED')),
  changed_keys text[] NOT NULL DEFAULT '{}',
  before jsonb,
  after jsonb NOT NULL,
  correlation_id text NOT NULL,
  occurred_at timestamptz(3) NOT NULL DEFAULT now(),
  CONSTRAINT webchat_widget_audit_events_widget_fkey
    FOREIGN KEY (tenant_id, widget_id) REFERENCES webchat_widgets(tenant_id, id) ON DELETE RESTRICT
);
CREATE INDEX webchat_widget_audit_events_tenant_idx
  ON webchat_widget_audit_events(tenant_id, occurred_at DESC);

-- One anonymous visitor session of a widget = one conversation and at most one Interaction.
-- The visitor proves the session with a secret; only its SHA-256 digest is stored.
CREATE TABLE webchat_sessions (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  widget_id uuid NOT NULL,
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE RESTRICT,
  interaction_id uuid,
  token_hash text NOT NULL,
  origin text NOT NULL,
  visitor_label text NOT NULL,
  locale text NOT NULL DEFAULT 'th' CHECK (locale IN ('th', 'en')),
  end_reason text CHECK (end_reason IN
    ('CUSTOMER_ENDED', 'AGENT_ENDED', 'IDLE_TIMEOUT', 'CUSTOMER_LEFT')),
  ended_at timestamptz(3),
  last_seen_at timestamptz(3) NOT NULL DEFAULT now(),
  created_at timestamptz(3) NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT webchat_sessions_widget_fkey
    FOREIGN KEY (tenant_id, widget_id) REFERENCES webchat_widgets(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT webchat_sessions_interaction_fkey
    FOREIGN KEY (tenant_id, interaction_id) REFERENCES interactions(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT webchat_sessions_end_check CHECK ((end_reason IS NULL) = (ended_at IS NULL))
);
CREATE UNIQUE INDEX webchat_sessions_conversation_key ON webchat_sessions(tenant_id, conversation_id);
CREATE UNIQUE INDEX webchat_sessions_interaction_key ON webchat_sessions(tenant_id, interaction_id);
CREATE INDEX webchat_sessions_widget_idx ON webchat_sessions(tenant_id, widget_id, created_at DESC);

-- Every offer of a chat to an Agent. A chat has at most one pending offer; an Agent who let an
-- offer time out is skipped for that chat for a while (the router reads this table to decide).
CREATE TABLE webchat_offers (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL DEFAULT gen_random_uuid(),
  interaction_id uuid NOT NULL,
  agent_id uuid NOT NULL,
  outcome text NOT NULL DEFAULT 'PENDING'
    CHECK (outcome IN ('PENDING', 'ACCEPTED', 'TIMED_OUT', 'CANCELLED')),
  offered_at timestamptz(3) NOT NULL DEFAULT now(),
  expires_at timestamptz(3) NOT NULL,
  resolved_at timestamptz(3),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT webchat_offers_interaction_fkey
    FOREIGN KEY (tenant_id, interaction_id) REFERENCES interactions(tenant_id, id) ON DELETE CASCADE,
  CONSTRAINT webchat_offers_agent_fkey
    FOREIGN KEY (tenant_id, agent_id) REFERENCES users(tenant_id, id) ON DELETE RESTRICT,
  CONSTRAINT webchat_offers_resolved_check CHECK ((outcome = 'PENDING') = (resolved_at IS NULL))
);
CREATE UNIQUE INDEX webchat_offers_pending_key
  ON webchat_offers(tenant_id, interaction_id) WHERE outcome = 'PENDING';
CREATE INDEX webchat_offers_agent_idx ON webchat_offers(tenant_id, agent_id, outcome);
CREATE INDEX webchat_offers_interaction_idx
  ON webchat_offers(tenant_id, interaction_id, offered_at DESC);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['webchat_widgets', 'webchat_widget_audit_events', 'webchat_sessions',
    'webchat_offers'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t);
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') THEN
    GRANT SELECT, INSERT, UPDATE ON webchat_widgets, webchat_sessions, webchat_offers TO dcontact_app;
    GRANT SELECT, INSERT ON webchat_widget_audit_events TO dcontact_app;
  END IF;
END $$;

-- A chat is closed with the same disposition + note result as a call (#796). The wrap-up policy of an
-- Interaction is stamped at insert: voice follows its queue, and web chat always records a result.
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
  ELSIF NEW.channel = 'WEBCHAT' THEN
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
    IF interaction_row.channel NOT IN ('VOICE', 'WEBCHAT')
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
