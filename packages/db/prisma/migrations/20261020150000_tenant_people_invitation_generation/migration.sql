ALTER TABLE tenant_people_invitation_intents
  ADD COLUMN generation integer NOT NULL DEFAULT 1 CHECK(generation > 0),
  ADD COLUMN provider_attempt_ref uuid NOT NULL DEFAULT gen_random_uuid(),
  ADD COLUMN delivery_state text NOT NULL DEFAULT 'INTENT' CHECK(delivery_state='INTENT');

CREATE UNIQUE INDEX tenant_people_invitation_generation
  ON tenant_people_invitation_intents(tenant_id,user_id,generation);
CREATE UNIQUE INDEX tenant_people_invitation_attempt
  ON tenant_people_invitation_intents(provider_attempt_ref);
