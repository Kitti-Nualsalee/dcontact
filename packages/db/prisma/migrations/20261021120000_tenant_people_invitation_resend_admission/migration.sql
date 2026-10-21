CREATE TABLE tenant_people_invitation_resends (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_operation_id uuid NOT NULL,
  previous_generation integer NOT NULL CHECK(previous_generation>0),
  previous_attempt_ref uuid NOT NULL,
  generation integer NOT NULL CHECK(generation=previous_generation+1),
  provider_attempt_ref uuid NOT NULL,
  expected_revision integer NOT NULL CHECK(expected_revision>0),
  status_revision integer NOT NULL CHECK(status_revision>0),
  reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,command_id),
  UNIQUE(tenant_id,user_id,generation),
  UNIQUE(provider_attempt_ref),
  FOREIGN KEY(tenant_id,command_id) REFERENCES voice_config_commands(tenant_id,command_id),
  FOREIGN KEY(tenant_id,actor_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,source_operation_id,user_id,previous_generation,previous_attempt_ref)
    REFERENCES tenant_people_invitation_intents(tenant_id,operation_id,user_id,generation,provider_attempt_ref)
);
CREATE INDEX invitation_resend_window ON tenant_people_invitation_resends(tenant_id,user_id,created_at);
ALTER TABLE tenant_people_invitation_resends ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_people_invitation_resends FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_people_invitation_resends
  USING(tenant_id=current_setting('app.tenant_id',true)::uuid)
  WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
CREATE POLICY worker_binding_required ON tenant_people_invitation_resends AS RESTRICTIVE TO dcontact_tenant_people_worker
  USING(EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=tenant_people_invitation_resends.tenant_id AND b.database_principal=session_user AND b.enabled));
CREATE TRIGGER invitation_resend_immutable BEFORE UPDATE OR DELETE ON tenant_people_invitation_resends
  FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();

CREATE FUNCTION dc_people_invitation_resend_guard() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE latest record;
BEGIN
  IF NEW.tenant_id::text IS DISTINCT FROM current_setting('app.tenant_id',true)
    THEN RAISE EXCEPTION 'INVITATION_SCOPE_MISMATCH' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=NEW.tenant_id AND id=NEW.user_id FOR UPDATE;
  PERFORM 1 FROM public.tenant_user_lifecycles WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id FOR UPDATE;
  IF NOT EXISTS(SELECT 1 FROM public.users u JOIN public.tenant_user_lifecycles l ON l.tenant_id=u.tenant_id AND l.user_id=u.id
    WHERE u.tenant_id=NEW.tenant_id AND u.id=NEW.user_id AND NOT u.is_active AND u.keycloak_id=l.verified_identity_id
    AND u.config_revision=NEW.expected_revision AND l.revision=NEW.status_revision
    AND l.account_state='PENDING_ACTIVATION' AND l.activation_state='PENDING' AND l.provisioning_state='PROVISIONED')
    THEN RAISE EXCEPTION 'INVITATION_RESEND_NOT_ELIGIBLE' USING ERRCODE='23514'; END IF;
  SELECT * INTO latest FROM public.tenant_people_invitation_intents
    WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id ORDER BY generation DESC LIMIT 1;
  IF latest.operation_id IS DISTINCT FROM NEW.source_operation_id OR latest.generation IS DISTINCT FROM NEW.previous_generation
    OR latest.provider_attempt_ref IS DISTINCT FROM NEW.previous_attempt_ref
    OR NOT EXISTS(SELECT 1 FROM public.tenant_people_invitation_receipts WHERE tenant_id=NEW.tenant_id
      AND provider_attempt_ref=NEW.previous_attempt_ref AND outcome='SENT' AND quiescent)
    THEN RAISE EXCEPTION 'INVITATION_DELIVERY_NOT_QUIESCENT' USING ERRCODE='23514'; END IF;
  IF (SELECT count(*) FROM public.tenant_people_invitation_resends WHERE tenant_id=NEW.tenant_id AND user_id=NEW.user_id
    AND created_at>clock_timestamp()-interval '60 minutes')>=3
    THEN RAISE EXCEPTION 'INVITATION_RESEND_LIMIT' USING ERRCODE='23514'; END IF;
  NEW.created_at=clock_timestamp();
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dc_people_invitation_resend_guard() FROM PUBLIC;
CREATE TRIGGER invitation_resend_admission BEFORE INSERT ON tenant_people_invitation_resends
  FOR EACH ROW EXECUTE FUNCTION dc_people_invitation_resend_guard();
