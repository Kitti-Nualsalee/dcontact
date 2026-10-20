DO $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dcontact_tenant_people_worker') THEN
    CREATE ROLE dcontact_tenant_people_worker NOLOGIN NOBYPASSRLS;
  END IF;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dcontact_tenant_people_worker' AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'PEOPLE_WORKER_ROLE_TOO_PRIVILEGED';
  END IF;
END $$;

CREATE TABLE tenant_people_worker_bindings (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  database_principal name NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  approval_ref text NOT NULL CHECK(length(btrim(approval_ref)) BETWEEN 1 AND 200),
  approved_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,database_principal)
);
ALTER TABLE tenant_people_worker_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_people_worker_bindings FORCE ROW LEVEL SECURITY;
CREATE POLICY own_worker_binding ON tenant_people_worker_bindings FOR SELECT TO dcontact_tenant_people_worker
  USING(database_principal=session_user AND enabled);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_people_operations','tenant_identity_reservations','tenant_user_lifecycles','tenant_people_step_receipts','users'] LOOP
    EXECUTE format('CREATE POLICY worker_binding_required ON %I AS RESTRICTIVE TO dcontact_tenant_people_worker USING (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled)) WITH CHECK (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled))',table_name,table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION dc_tenant_people_receipt_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM tenant_people_operations o WHERE o.tenant_id=NEW.tenant_id AND o.id=NEW.operation_id
    AND o.fencing_token=NEW.fencing_token AND o.step=NEW.step AND o.payload_digest=NEW.payload_digest
    AND o.state IN ('RUNNING','WAITING_EXTERNAL') AND o.lease_owner IS NOT NULL AND o.lease_expires_at>clock_timestamp())
    THEN RAISE EXCEPTION 'PEOPLE_WORKER_STALE_FENCE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_people_receipt_fence BEFORE INSERT ON tenant_people_step_receipts
  FOR EACH ROW EXECUTE FUNCTION dc_tenant_people_receipt_fence();
