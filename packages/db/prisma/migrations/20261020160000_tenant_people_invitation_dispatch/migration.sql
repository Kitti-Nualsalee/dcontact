ALTER TABLE tenant_people_invitation_intents ADD CONSTRAINT tenant_people_invitation_descriptor
  UNIQUE(tenant_id,operation_id,user_id,generation,provider_attempt_ref);

CREATE TABLE tenant_people_invitation_dispatches (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  generation integer NOT NULL,
  provider_attempt_ref uuid NOT NULL,
  fencing_token bigint NOT NULL DEFAULT 1 CHECK(fencing_token=1),
  lease_owner text NOT NULL CHECK(lease_owner ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
  PRIMARY KEY(tenant_id,provider_attempt_ref),
  FOREIGN KEY(tenant_id,operation_id,user_id,generation,provider_attempt_ref)
    REFERENCES tenant_people_invitation_intents(tenant_id,operation_id,user_id,generation,provider_attempt_ref)
);

CREATE TABLE tenant_people_invitation_ambiguities (
  tenant_id uuid NOT NULL,
  provider_attempt_ref uuid NOT NULL,
  observed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,provider_attempt_ref),
  FOREIGN KEY(tenant_id,provider_attempt_ref)
    REFERENCES tenant_people_invitation_dispatches(tenant_id,provider_attempt_ref)
);

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_people_invitation_dispatches','tenant_people_invitation_ambiguities'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',table_name);
    EXECUTE format('CREATE POLICY worker_binding_required ON %I AS RESTRICTIVE TO dcontact_tenant_people_worker USING (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled)) WITH CHECK (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled))',table_name,table_name,table_name);
    EXECUTE format('CREATE TRIGGER invitation_dispatch_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable()',table_name);
  END LOOP;
END $$;
