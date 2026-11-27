-- #1061 agent-scheduled callbacks, round one
-- An Agent schedules a callback from the work they hold; the Agent (or the team after 15 minutes offline) dials it
-- from Workspace through managed telephony. Dialer stays the only writer of ob_callbacks (ADR-011).
BEGIN;

-- Callbacks from Journey (J2) keep origin JOURNEY; agent callbacks carry the work, number and author
ALTER TABLE ob_callbacks
  ADD COLUMN origin text NOT NULL DEFAULT 'JOURNEY' CHECK (origin IN ('JOURNEY', 'AGENT')),
  ADD COLUMN source_interaction_id uuid,
  ADD COLUMN identity_id uuid,
  ADD COLUMN note text CHECK (note IS NULL OR char_length(note) <= 500),
  ADD COLUMN created_by_user_id uuid,
  ADD COLUMN escalated_at timestamptz,
  ADD COLUMN last_reason_code text,
  ADD COLUMN attempt_interaction_id uuid,
  ADD COLUMN attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0);

ALTER TABLE ob_callbacks ADD CONSTRAINT ob_callbacks_agent_fields CHECK (
  origin <> 'AGENT'
  OR (source_interaction_id IS NOT NULL AND identity_id IS NOT NULL AND created_by_user_id IS NOT NULL)
);
ALTER TABLE ob_callbacks ADD CONSTRAINT ob_callbacks_identity_fk
  FOREIGN KEY (tenant_id, identity_id) REFERENCES contact_identities(tenant_id, id);
ALTER TABLE ob_callbacks ADD CONSTRAINT ob_callbacks_creator_fk
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES users(tenant_id, id);
ALTER TABLE ob_callbacks ADD CONSTRAINT ob_callbacks_source_interaction_fk
  FOREIGN KEY (tenant_id, source_interaction_id) REFERENCES interactions(tenant_id, id);
ALTER TABLE ob_callbacks ADD CONSTRAINT ob_callbacks_attempt_interaction_fk
  FOREIGN KEY (tenant_id, attempt_interaction_id) REFERENCES interactions(tenant_id, id);

-- One open agent callback per customer
CREATE UNIQUE INDEX ob_callbacks_agent_open_per_contact ON ob_callbacks (tenant_id, contact_id)
  WHERE origin = 'AGENT' AND state IN ('SCHEDULED', 'ORIGINATING');
CREATE INDEX ob_callbacks_agent_due_idx ON ob_callbacks (tenant_id, state, requested_for)
  WHERE origin = 'AGENT';

-- Timeline of an agent callback: no phone number and no note text
CREATE TABLE ob_callback_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  callback_id uuid NOT NULL REFERENCES ob_callbacks(id),
  kind text NOT NULL CHECK (kind IN (
    'SCHEDULED', 'RESCHEDULED', 'CANCELLED', 'ESCALATED', 'EXPIRED',
    'DIAL_STARTED', 'DEFERRED', 'BLOCKED', 'REVIEW', 'CONNECTED', 'NOT_CONNECTED'
  )),
  actor_user_id uuid,
  reason_code text,
  requested_for timestamptz,
  interaction_id uuid,
  decision_id text,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX ob_callback_events_callback_idx ON ob_callback_events (tenant_id, callback_id, occurred_at, id);

ALTER TABLE ob_callback_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE ob_callback_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ob_callback_events
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') THEN
    GRANT SELECT, INSERT ON ob_callback_events TO dcontact_app;
    REVOKE UPDATE, DELETE ON ob_callback_events FROM dcontact_app;
  END IF;
END $$;

-- A callback call runs on the managed voice runtime with the legs reversed: the Agent leg is the offer leg and
-- FreeSWITCH bridges it to the customer's internal number once the Agent answers
ALTER TABLE voice_managed_calls
  ADD COLUMN kind text NOT NULL DEFAULT 'INBOUND' CHECK (kind IN ('INBOUND', 'CALLBACK')),
  ADD COLUMN destination text;
ALTER TABLE voice_managed_calls ADD CONSTRAINT voice_managed_calls_callback_destination CHECK (
  (kind = 'INBOUND' AND destination IS NULL) OR (kind = 'CALLBACK' AND destination ~ '^1[0-9]{3}$')
);
ALTER TABLE voice_managed_calls DROP CONSTRAINT voice_managed_calls_terminal_reason_check;
ALTER TABLE voice_managed_calls ADD CONSTRAINT voice_managed_calls_terminal_reason_check CHECK (
  terminal_reason IN ('PREANSWER_DEADLINE_EXCEEDED', 'CALLER_CANCELLED', 'AGENT_HANGUP', 'CALLER_HANGUP', 'CALLBACK_NOT_ANSWERED')
);
ALTER TABLE voice_managed_commands DROP CONSTRAINT voice_managed_commands_command_type_check;
ALTER TABLE voice_managed_commands ADD CONSTRAINT voice_managed_commands_command_type_check CHECK (
  command_type IN ('offer.create', 'call.bridge', 'call.hangup', 'offer.cancel', 'callback.originate')
);

-- A callback call records its result like an inbound call of the same queue (VOICE_NOTE_V1 when the queue uses it)
CREATE OR REPLACE FUNCTION stamp_voice_wrapup_policy() RETURNS TRIGGER LANGUAGE plpgsql AS $$
DECLARE queue_policy TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.voice_wrapup_policy IS DISTINCT FROM OLD.voice_wrapup_policy THEN
      RAISE EXCEPTION 'WRAPUP_POLICY_IMMUTABLE' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.channel = 'VOICE' AND NEW.queue_id IS NOT NULL
     AND (NEW.direction = 'INBOUND' OR NEW.metadata->>'source' = 'AGENT_CALLBACK') THEN
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

COMMIT;
