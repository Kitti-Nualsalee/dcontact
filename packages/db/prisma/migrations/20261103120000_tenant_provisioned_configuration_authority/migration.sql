BEGIN;

CREATE FUNCTION dc_people_configuration_authority(scope uuid,target uuid,issuer_value text,client_value text,slug_value text)
RETURNS TABLE(status_revision integer,operation_id uuid,activation_probe_ref uuid)
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT lifecycle.revision,operation.id,activation.probe_ref
  FROM public.users person
  JOIN public.tenants tenant ON tenant.id=person.tenant_id
  JOIN public.tenant_user_lifecycles lifecycle ON lifecycle.tenant_id=person.tenant_id AND lifecycle.user_id=person.id
  JOIN public.tenant_people_operations operation ON operation.tenant_id=lifecycle.tenant_id
    AND operation.id=lifecycle.operation_id AND operation.target_user_id=person.id
  JOIN public.tenant_people_step_receipts provisioning ON provisioning.tenant_id=operation.tenant_id
    AND provisioning.operation_id=operation.id AND provisioning.step='VERIFY_PROVISIONED'
    AND provisioning.fencing_token=operation.fencing_token AND provisioning.payload_digest=operation.payload_digest
    AND provisioning.outcome='SUCCEEDED' AND provisioning.verified_identity_id=person.id
    AND length(btrim(provisioning.provider_receipt_ref))>0
  JOIN public.tenant_people_activation_attempts attempt ON attempt.tenant_id=operation.tenant_id
    AND attempt.operation_id=operation.id AND attempt.user_id=person.id AND attempt.payload_digest=operation.payload_digest
    AND attempt.status_revision+1<=lifecycle.revision
  JOIN public.tenant_people_activation_receipts activation ON activation.tenant_id=attempt.tenant_id
    AND activation.attempt_id=attempt.id AND activation.recorded_at>=attempt.created_at
    AND activation.recorded_at<attempt.expires_at
  WHERE scope=nullif(current_setting('app.tenant_id',true),'')::uuid
    AND person.tenant_id=scope AND person.id=target AND person.is_active
    AND person.keycloak_id=person.id AND person.password_hash='!keycloak-managed'
    AND person.role::text IN ('ADMIN','SUPERVISOR') AND lifecycle.creation_role=person.role::text
    AND tenant.slug=slug_value AND tenant.lifecycle_status='ACTIVE'
    AND lifecycle.account_state='ACTIVE' AND lifecycle.provisioning_state='PROVISIONED'
    AND lifecycle.activation_state='ACTIVATED' AND lifecycle.verified_identity_id=person.keycloak_id
    AND lifecycle.verified_at IS NOT NULL AND operation.state='SUCCEEDED' AND operation.step='VERIFY_PROVISIONED'
    AND operation.request_payload->>'role'=person.role::text
    AND EXISTS(SELECT 1 FROM public.tenant_voice_identity_binding_audit deployment
      WHERE deployment.tenant_id=scope AND deployment.created_at<=operation.created_at
        AND deployment.binding->>'issuer'=issuer_value AND deployment.binding->>'client_id'=client_value
        AND deployment.binding->>'tenant_slug'=slug_value AND deployment.binding->>'identity_class'='TENANT_USER'
        AND deployment.binding->>'is_active'='true')
    AND NOT EXISTS(SELECT 1 FROM public.tenant_voice_identity_bindings binding
      WHERE binding.tenant_id=scope AND binding.user_id=target)
  ORDER BY activation.recorded_at DESC,activation.probe_ref LIMIT 1
$$;
REVOKE ALL ON FUNCTION dc_people_configuration_authority(uuid,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_configuration_authority(uuid,uuid,text,text,text) TO dcontact_app;

CREATE OR REPLACE FUNCTION dc_people_disable_snapshot(scope uuid,target uuid,issuer_value text,client_value text,slug_value text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  WITH eligible AS (
    SELECT person.id,person.keycloak_id,person.role,person.team_id,person.is_active,person.config_revision,
      lifecycle.revision AS status_revision,lifecycle.account_state,lifecycle.activation_state,lifecycle.provisioning_state,lifecycle.operation_id,
      binding.revision AS binding_revision
    FROM public.users person
    LEFT JOIN public.tenant_user_lifecycles lifecycle ON lifecycle.tenant_id=person.tenant_id AND lifecycle.user_id=person.id
    LEFT JOIN public.tenant_people_operations operation ON operation.tenant_id=lifecycle.tenant_id
      AND operation.id=lifecycle.operation_id AND operation.target_user_id=person.id
    LEFT JOIN public.tenant_voice_identity_bindings binding ON binding.tenant_id=person.tenant_id AND binding.user_id=person.id
      AND binding.subject_id=person.keycloak_id::text AND binding.identity_class='TENANT_USER' AND binding.is_active
      AND binding.issuer=issuer_value AND binding.client_id=client_value AND binding.tenant_slug=slug_value
    WHERE person.tenant_id=scope AND scope=nullif(current_setting('app.tenant_id',true),'')::uuid
      AND person.keycloak_id IS NOT NULL AND person.role::text IN ('AGENT','SUPERVISOR','ADMIN')
      AND ((lifecycle.provisioning_state='PROVISIONED' AND lifecycle.account_state IN ('ACTIVE','PENDING_ACTIVATION')
        AND lifecycle.verified_identity_id=person.keycloak_id AND operation.state='SUCCEEDED' AND operation.step='VERIFY_PROVISIONED')
        OR (lifecycle.user_id IS NULL AND binding.user_id IS NOT NULL))
  )
  SELECT jsonb_build_object('target',to_jsonb(person),'admins',coalesce((
    SELECT jsonb_agg(to_jsonb(admin) ORDER BY admin.id) FROM eligible admin
    WHERE admin.role='ADMIN' AND admin.is_active
      AND (admin.binding_revision IS NOT NULL
        OR EXISTS(SELECT 1 FROM public.dc_people_configuration_authority(scope,admin.id,issuer_value,client_value,slug_value)))
      AND (admin.status_revision IS NULL OR (admin.account_state='ACTIVE' AND admin.activation_state='ACTIVATED'))
  ),'[]'::jsonb)) FROM eligible person WHERE person.id=target
$$;

COMMIT;
