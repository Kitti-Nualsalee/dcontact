-- #1067 Journey round one: the Interaction owner emits `interaction.outcome_recorded` (J2 contract)
-- The row is written in the same transaction as the wrap-up result; a relay publishes it to
-- dc.interaction.events at-least-once. `id` is the Kafka eventId.
BEGIN;

CREATE TABLE interaction_outcome_outbox (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  interaction_id uuid NOT NULL,
  outcome_type text NOT NULL,
  outcome_id uuid NOT NULL,
  outcome_version integer NOT NULL CHECK (outcome_version >= 1),
  payload jsonb NOT NULL,
  correlation_id text NOT NULL,
  state text NOT NULL DEFAULT 'PENDING' CHECK (state IN ('PENDING', 'SENT')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  available_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  sent_at timestamptz(3),
  last_error text,
  created_at timestamptz(3) NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT interaction_outcome_outbox_interaction_fk
    FOREIGN KEY (tenant_id, interaction_id) REFERENCES interactions(tenant_id, id),
  CONSTRAINT interaction_outcome_outbox_sent_at CHECK ((state = 'SENT') = (sent_at IS NOT NULL))
);
CREATE UNIQUE INDEX interaction_outcome_outbox_outcome_key
  ON interaction_outcome_outbox (tenant_id, outcome_type, outcome_id, outcome_version);
CREATE INDEX interaction_outcome_outbox_pending_idx
  ON interaction_outcome_outbox (tenant_id, state, available_at);

ALTER TABLE interaction_outcome_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE interaction_outcome_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON interaction_outcome_outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
DO $$ BEGIN
  IF EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') THEN
    GRANT SELECT, INSERT, UPDATE ON interaction_outcome_outbox TO dcontact_app;
    REVOKE DELETE ON interaction_outcome_outbox FROM dcontact_app;
  END IF;
END $$;

-- The results page of a journey lists its enrollments newest first
CREATE INDEX jr_enrollments_tenant_journey_created_idx
  ON jr_enrollments (tenant_id, journey_id, created_at DESC, id DESC);

COMMIT;
