CREATE TABLE tenant_people_invitation_reconciles (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  user_id uuid NOT NULL,
  source_operation_id uuid NOT NULL,
  generation integer NOT NULL CHECK(generation>0),
  provider_attempt_ref uuid NOT NULL,
  expected_revision integer NOT NULL CHECK(expected_revision>0),
  status_revision integer NOT NULL CHECK(status_revision>0),
  reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'),
  reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','SUCCEEDED','ACTION_REQUIRED')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>0),
  lease_token uuid,
  lease_expires_at timestamptz,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,command_id),
  FOREIGN KEY(tenant_id,command_id) REFERENCES voice_config_commands(tenant_id,command_id),
  FOREIGN KEY(tenant_id,actor_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,source_operation_id,user_id,generation,provider_attempt_ref)
    REFERENCES tenant_people_invitation_intents(tenant_id,operation_id,user_id,generation,provider_attempt_ref),
  CHECK((state='RUNNING')=(lease_token IS NOT NULL)),
  CHECK((lease_token IS NULL)=(lease_expires_at IS NULL)),
  CHECK((state='ACTION_REQUIRED')=(error_code IS NOT NULL))
);
CREATE INDEX invitation_reconcile_pending ON tenant_people_invitation_reconciles(tenant_id,state,lease_expires_at,created_at,id);
ALTER TABLE tenant_people_invitation_reconciles ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_people_invitation_reconciles FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_people_invitation_reconciles
  USING(tenant_id=current_setting('app.tenant_id',true)::uuid)
  WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
CREATE POLICY worker_binding_required ON tenant_people_invitation_reconciles AS RESTRICTIVE TO dcontact_tenant_people_worker
  USING(EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=tenant_people_invitation_reconciles.tenant_id AND b.database_principal=session_user AND b.enabled))
  WITH CHECK(EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=tenant_people_invitation_reconciles.tenant_id AND b.database_principal=session_user AND b.enabled));
CREATE FUNCTION dc_people_invitation_reconcile_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'INVITATION_RECONCILE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','revision','lease_token','lease_expires_at','error_code','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','lease_token','lease_expires_at','error_code','updated_at'])
    THEN RAISE EXCEPTION 'INVITATION_RECONCILE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF OLD.state IN ('SUCCEEDED','ACTION_REQUIRED') OR NEW.revision<>OLD.revision+1
    OR NOT ((OLD.state='QUEUED' AND NEW.state='RUNNING') OR (OLD.state='RUNNING' AND NEW.state IN ('RUNNING','SUCCEEDED','ACTION_REQUIRED')))
    THEN RAISE EXCEPTION 'INVITATION_RECONCILE_TRANSITION' USING ERRCODE='23514'; END IF;
  IF OLD.state='RUNNING' AND NEW.state='RUNNING' AND OLD.lease_expires_at>clock_timestamp()
    THEN RAISE EXCEPTION 'INVITATION_RECONCILE_LEASE_BUSY' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER invitation_reconcile_guard BEFORE UPDATE OR DELETE ON tenant_people_invitation_reconciles
  FOR EACH ROW EXECUTE FUNCTION dc_people_invitation_reconcile_guard();

CREATE FUNCTION dc_people_invitation_lock_status(scope uuid,target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF scope::text IS DISTINCT FROM current_setting('app.tenant_id',true)
    THEN RAISE EXCEPTION 'INVITATION_SCOPE_MISMATCH' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.tenant_user_lifecycles WHERE tenant_id=scope AND user_id=target FOR UPDATE NOWAIT;
END $$;
REVOKE ALL ON FUNCTION dc_people_invitation_lock_status(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_invitation_lock_status(uuid,uuid) TO dcontact_app;
