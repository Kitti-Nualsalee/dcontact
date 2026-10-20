ALTER TABLE tenant_people_step_receipts ADD COLUMN verified_identity_id uuid;

CREATE TABLE tenant_people_invitation_intents (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  user_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,operation_id),
  FOREIGN KEY(tenant_id,operation_id,user_id) REFERENCES tenant_people_operations(tenant_id,id,target_user_id)
);
ALTER TABLE tenant_people_invitation_intents ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_people_invitation_intents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_people_invitation_intents
  USING(tenant_id=current_setting('app.tenant_id',true)::uuid)
  WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
CREATE POLICY worker_binding_required ON tenant_people_invitation_intents AS RESTRICTIVE TO dcontact_tenant_people_worker
  USING(EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=tenant_people_invitation_intents.tenant_id AND b.database_principal=session_user AND b.enabled))
  WITH CHECK(EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=tenant_people_invitation_intents.tenant_id AND b.database_principal=session_user AND b.enabled));
CREATE TRIGGER tenant_people_invitation_intent_immutable BEFORE UPDATE OR DELETE ON tenant_people_invitation_intents
  FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();

CREATE FUNCTION dc_tenant_people_apply_identity_proof(scope uuid, operation uuid, fence bigint, proof_identity uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.tenant_people_operations%ROWTYPE;
BEGIN
  IF scope IS DISTINCT FROM current_setting('app.tenant_id',true)::uuid
    OR NOT pg_has_role(session_user,'dcontact_tenant_people_worker','MEMBER')
    OR NOT EXISTS(SELECT 1 FROM public.tenant_people_worker_bindings b WHERE b.tenant_id=scope AND b.database_principal=session_user AND b.enabled)
    THEN RAISE EXCEPTION 'PEOPLE_WORKER_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO accepted FROM public.tenant_people_operations
    WHERE tenant_id=scope AND id=operation FOR UPDATE;
  IF NOT FOUND OR accepted.fencing_token<>fence OR accepted.target_user_id IS DISTINCT FROM proof_identity
    OR accepted.step NOT IN ('VERIFY_MAPPING','VERIFY_PROVISIONED')
    OR accepted.state NOT IN ('RUNNING','WAITING_EXTERNAL') OR accepted.lease_expires_at<=clock_timestamp()
    OR accepted.lease_owner IS NULL
    OR NOT EXISTS(SELECT 1 FROM public.tenant_people_step_receipts r WHERE r.tenant_id=scope AND r.operation_id=operation
      AND r.step=accepted.step AND r.fencing_token=fence AND r.payload_digest=accepted.payload_digest
      AND r.outcome='SUCCEEDED' AND r.verified_identity_id=proof_identity)
    THEN RAISE EXCEPTION 'PEOPLE_IDENTITY_NOT_VERIFIED' USING ERRCODE='23514'; END IF;
  PERFORM u.id FROM public.users u JOIN public.teams t ON t.tenant_id=u.tenant_id AND t.id=u.team_id
    WHERE u.tenant_id=scope AND u.id=accepted.target_user_id AND NOT u.is_active AND t.is_active
      AND u.password_hash='!keycloak-managed' AND (u.keycloak_id IS NULL OR u.keycloak_id=proof_identity)
      AND u.email=accepted.request_payload->>'email' AND u.display_name=accepted.request_payload->>'displayName'
      AND u.role::text=accepted.request_payload->>'role' AND u.team_id::text=accepted.request_payload->>'teamId'
      AND u.extension IS NOT DISTINCT FROM accepted.request_payload->>'extension' FOR UPDATE OF u;
  IF NOT FOUND THEN RAISE EXCEPTION 'PEOPLE_DOMAIN_MAPPING_CONFLICT' USING ERRCODE='23514'; END IF;
  IF accepted.step='VERIFY_MAPPING' THEN
    UPDATE public.users SET keycloak_id=proof_identity WHERE tenant_id=scope AND id=accepted.target_user_id;
    UPDATE public.tenant_user_lifecycles SET revision=revision+1,verified_identity_id=proof_identity,verified_at=clock_timestamp()
      WHERE tenant_id=scope AND user_id=accepted.target_user_id AND operation_id=operation
        AND account_state='PROVISIONING' AND activation_state='PENDING';
    IF NOT FOUND THEN RAISE EXCEPTION 'PEOPLE_LIFECYCLE_CONFLICT' USING ERRCODE='23514'; END IF;
  ELSE
    IF NOT EXISTS(SELECT 1 FROM public.tenant_people_invitation_intents i WHERE i.tenant_id=scope AND i.operation_id=operation AND i.user_id=accepted.target_user_id)
      THEN RAISE EXCEPTION 'PEOPLE_INVITATION_INTENT_REQUIRED' USING ERRCODE='23514'; END IF;
    UPDATE public.tenant_user_lifecycles SET revision=revision+1,provisioning_state='PROVISIONED',account_state='PENDING_ACTIVATION',verified_at=clock_timestamp()
      WHERE tenant_id=scope AND user_id=accepted.target_user_id AND operation_id=operation AND activation_state='PENDING'
        AND account_state='PROVISIONING' AND verified_identity_id=proof_identity;
    IF NOT FOUND THEN RAISE EXCEPTION 'PEOPLE_LIFECYCLE_CONFLICT' USING ERRCODE='23514'; END IF;
  END IF;
END $$;
REVOKE ALL ON FUNCTION dc_tenant_people_apply_identity_proof(uuid,uuid,bigint,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_tenant_people_apply_identity_proof(uuid,uuid,bigint,uuid) TO dcontact_tenant_people_worker;
