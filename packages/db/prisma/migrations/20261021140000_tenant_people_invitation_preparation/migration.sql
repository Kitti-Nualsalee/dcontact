ALTER TABLE tenant_people_invitation_resends ADD CONSTRAINT invitation_resend_descriptor
  UNIQUE(tenant_id,id,source_operation_id,user_id,generation,provider_attempt_ref);
CREATE TABLE tenant_people_invitation_preparations (
  tenant_id uuid NOT NULL,
  resend_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  generation integer NOT NULL CHECK(generation>1),
  provider_attempt_ref uuid NOT NULL,
  fencing_token bigint NOT NULL CHECK(fencing_token>=generation),
  lease_owner text NOT NULL CHECK(lease_owner ~ '^[A-Za-z0-9_.:-]{1,128}$'),
  lease_expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,resend_id),
  UNIQUE(tenant_id,provider_attempt_ref),
  FOREIGN KEY(tenant_id,resend_id,operation_id,user_id,generation,provider_attempt_ref)
    REFERENCES tenant_people_invitation_resends(tenant_id,id,source_operation_id,user_id,generation,provider_attempt_ref)
);
CREATE TABLE tenant_people_invitation_preparation_proofs (
  tenant_id uuid NOT NULL,
  provider_attempt_ref uuid NOT NULL,
  intent_ref text NOT NULL CHECK(intent_ref ~ '^[a-f0-9]{64}$'),
  not_before_epoch bigint NOT NULL CHECK(not_before_epoch>0),
  server_epoch bigint NOT NULL CHECK(server_epoch>=not_before_epoch AND server_epoch<=253402041599),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,provider_attempt_ref),
  FOREIGN KEY(tenant_id,provider_attempt_ref) REFERENCES tenant_people_invitation_preparations(tenant_id,provider_attempt_ref)
);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_people_invitation_preparations','tenant_people_invitation_preparation_proofs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',table_name);
    EXECUTE format('CREATE POLICY worker_binding_required ON %I AS RESTRICTIVE TO dcontact_tenant_people_worker USING (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled)) WITH CHECK (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled))',table_name,table_name,table_name);
    EXECUTE format('CREATE TRIGGER invitation_preparation_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable()',table_name);
  END LOOP;
END $$;
CREATE FUNCTION dc_people_invitation_lock_preparation(scope uuid,target uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF scope::text IS DISTINCT FROM current_setting('app.tenant_id',true)
    THEN RAISE EXCEPTION 'INVITATION_SCOPE_MISMATCH' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=scope AND id=target FOR UPDATE;
  PERFORM 1 FROM public.tenant_user_lifecycles WHERE tenant_id=scope AND user_id=target FOR UPDATE;
END $$;
REVOKE ALL ON FUNCTION dc_people_invitation_lock_preparation(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_invitation_lock_preparation(uuid,uuid) TO dcontact_tenant_people_worker;
