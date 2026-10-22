CREATE TABLE tenant_people_activation_attempts (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  operation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  database_principal name NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  config_revision integer NOT NULL CHECK(config_revision>=1),
  status_revision integer NOT NULL CHECK(status_revision>=1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '30 seconds',
  PRIMARY KEY(tenant_id,id),
  FOREIGN KEY(tenant_id,operation_id,user_id) REFERENCES tenant_people_operations(tenant_id,id,target_user_id)
);
CREATE TABLE tenant_people_activation_receipts (
  tenant_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  probe_ref uuid NOT NULL,
  server_epoch bigint NOT NULL CHECK(server_epoch BETWEEN 1 AND 253402041599),
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,attempt_id),
  UNIQUE(tenant_id,probe_ref),
  FOREIGN KEY(tenant_id,attempt_id) REFERENCES tenant_people_activation_attempts(tenant_id,id)
);
DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_people_activation_attempts','tenant_people_activation_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',table_name);
    EXECUTE format('CREATE POLICY worker_binding_required ON %I AS RESTRICTIVE TO dcontact_tenant_people_worker USING (EXISTS(SELECT 1 FROM tenant_people_worker_bindings binding WHERE binding.tenant_id=%I.tenant_id AND binding.database_principal=session_user AND binding.enabled)) WITH CHECK (EXISTS(SELECT 1 FROM tenant_people_worker_bindings binding WHERE binding.tenant_id=%I.tenant_id AND binding.database_principal=session_user AND binding.enabled))',table_name,table_name,table_name);
    EXECUTE format('CREATE TRIGGER people_activation_immutable BEFORE UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable()',table_name);
  END LOOP;
END $$;

CREATE FUNCTION dc_people_activation_authorize(scope uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  IF scope IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR NOT pg_has_role(session_user,'dcontact_tenant_people_worker','MEMBER')
    OR pg_has_role(session_user,'dcontact_app','MEMBER')
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls))
    OR NOT EXISTS(SELECT 1 FROM public.tenant_people_worker_bindings binding WHERE binding.tenant_id=scope AND binding.database_principal=session_user AND binding.enabled)
    THEN RAISE EXCEPTION 'PEOPLE_ACTIVATION_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.tenant_people_worker_bindings WHERE tenant_id=scope AND database_principal=session_user AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PEOPLE_ACTIVATION_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION dc_people_activation_authorize(uuid) FROM PUBLIC;

CREATE FUNCTION dc_people_claim_activation(scope uuid,operation uuid,attempt uuid)
RETURNS SETOF tenant_people_activation_attempts
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid; config integer; status integer; payload text;
BEGIN
  PERFORM public.dc_people_activation_authorize(scope);
  PERFORM pg_advisory_xact_lock(hashtextextended('dc:v1:tenant-account:'||scope::text,0));
  PERFORM 1 FROM public.tenants WHERE id=scope AND lifecycle_status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RETURN; END IF;
  SELECT target_user_id INTO target FROM public.tenant_people_operations WHERE tenant_id=scope AND id=operation;
  IF NOT FOUND THEN RETURN; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=scope AND id=target FOR UPDATE;
  PERFORM 1 FROM public.tenant_user_lifecycles WHERE tenant_id=scope AND user_id=target FOR UPDATE;
  SELECT person.config_revision,lifecycle.revision,provisioning.payload_digest INTO config,status,payload
    FROM public.users person JOIN public.teams team ON team.tenant_id=person.tenant_id AND team.id=person.team_id
    JOIN public.tenant_user_lifecycles lifecycle ON lifecycle.tenant_id=person.tenant_id AND lifecycle.user_id=person.id
    JOIN public.tenant_people_operations provisioning ON provisioning.tenant_id=lifecycle.tenant_id AND provisioning.id=lifecycle.operation_id AND provisioning.target_user_id=lifecycle.user_id
    WHERE person.tenant_id=scope AND person.id=target AND provisioning.id=operation AND provisioning.state='SUCCEEDED' AND provisioning.step='VERIFY_PROVISIONED'
      AND NOT person.is_active AND team.is_active AND person.password_hash='!keycloak-managed' AND person.keycloak_id=lifecycle.verified_identity_id
      AND person.keycloak_id=person.id AND person.email=provisioning.request_payload->>'email' AND person.display_name=provisioning.request_payload->>'displayName'
      AND person.role::text=provisioning.request_payload->>'role' AND person.team_id::text=provisioning.request_payload->>'teamId'
      AND person.extension IS NOT DISTINCT FROM provisioning.request_payload->>'extension'
      AND lifecycle.account_state='PENDING_ACTIVATION' AND lifecycle.provisioning_state='PROVISIONED' AND lifecycle.activation_state='PENDING';
  IF NOT FOUND THEN RETURN; END IF;
  RETURN QUERY INSERT INTO public.tenant_people_activation_attempts(tenant_id,id,operation_id,user_id,database_principal,payload_digest,config_revision,status_revision)
    VALUES(scope,attempt,operation,target,session_user,payload,config,status) RETURNING *;
END $$;
REVOKE ALL ON FUNCTION dc_people_claim_activation(uuid,uuid,uuid) FROM PUBLIC;

CREATE FUNCTION dc_people_apply_activation(scope uuid,attempt uuid,probe uuid,provider_epoch bigint)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE claim public.tenant_people_activation_attempts%ROWTYPE; accepted public.tenant_people_operations%ROWTYPE;
BEGIN
  PERFORM public.dc_people_activation_authorize(scope);
  PERFORM pg_advisory_xact_lock(hashtextextended('dc:v1:tenant-account:'||scope::text,0));
  PERFORM 1 FROM public.tenants WHERE id=scope AND lifecycle_status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  SELECT * INTO claim FROM public.tenant_people_activation_attempts WHERE tenant_id=scope AND id=attempt;
  IF NOT FOUND OR claim.database_principal<>session_user OR claim.expires_at<=clock_timestamp() THEN RETURN false; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=scope AND id=claim.user_id FOR UPDATE;
  PERFORM 1 FROM public.tenant_user_lifecycles WHERE tenant_id=scope AND user_id=claim.user_id FOR UPDATE;
  SELECT * INTO accepted FROM public.tenant_people_operations WHERE tenant_id=scope AND id=claim.operation_id;
  IF NOT FOUND OR accepted.state<>'SUCCEEDED' OR accepted.step<>'VERIFY_PROVISIONED' OR accepted.payload_digest<>claim.payload_digest THEN RETURN false; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.users person JOIN public.teams team ON team.tenant_id=person.tenant_id AND team.id=person.team_id
    JOIN public.tenant_user_lifecycles lifecycle ON lifecycle.tenant_id=person.tenant_id AND lifecycle.user_id=person.id
    WHERE person.tenant_id=scope AND person.id=claim.user_id AND NOT person.is_active AND team.is_active AND person.password_hash='!keycloak-managed'
      AND person.config_revision=claim.config_revision AND lifecycle.revision=claim.status_revision
      AND lifecycle.operation_id=claim.operation_id AND person.keycloak_id=lifecycle.verified_identity_id AND person.keycloak_id=person.id
      AND person.email=accepted.request_payload->>'email' AND person.display_name=accepted.request_payload->>'displayName'
      AND person.role::text=accepted.request_payload->>'role' AND person.team_id::text=accepted.request_payload->>'teamId'
      AND person.extension IS NOT DISTINCT FROM accepted.request_payload->>'extension'
      AND lifecycle.account_state='PENDING_ACTIVATION' AND lifecycle.provisioning_state='PROVISIONED' AND lifecycle.activation_state='PENDING') THEN RETURN false; END IF;
  IF claim.expires_at<=clock_timestamp() THEN RETURN false; END IF;
  INSERT INTO public.tenant_people_activation_receipts(tenant_id,attempt_id,probe_ref,server_epoch) VALUES(scope,attempt,probe,provider_epoch);
  UPDATE public.users SET is_active=true WHERE tenant_id=scope AND id=claim.user_id;
  UPDATE public.tenant_user_lifecycles SET revision=revision+1,account_state='ACTIVE',activation_state='ACTIVATED',verified_at=clock_timestamp()
    WHERE tenant_id=scope AND user_id=claim.user_id;
  INSERT INTO public.voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id)
    VALUES(probe,scope,claim.user_id,claim.user_id,NULL,'ACTIVATE_TENANT_USER','SUCCEEDED',claim.status_revision,claim.status_revision+1,
      ARRAY['accountState','activationState','isActive'],'IDENTITY_ACTIVATION_VERIFIED',attempt::text);
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION dc_people_apply_activation(uuid,uuid,uuid,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_claim_activation(uuid,uuid,uuid),dc_people_apply_activation(uuid,uuid,uuid,bigint) TO dcontact_tenant_people_worker;
