-- #901: first admin ที่ Platform provisioning สร้างได้ positive identity binding (`PLATFORM_PROVISIONING`)
--
-- บันทึกใน transaction เดียวกับที่ request เป็น SUCCEEDED และ tenant เป็น ACTIVE (ตอนนั้น slug เป็นค่าจริงแล้ว)
-- ก่อน first admin รับคำเชิญ; Keycloak ยังไม่ออก token จนกว่าจะทำ required actions ครบ
-- ฟังก์ชันอ่านหลักฐานจาก DB เองทั้งหมด: subject จากผลขั้น FIRST_ADMIN, Organization จากผลขั้น
-- KEYCLOAK_ORGANIZATION, ผู้รับรองจาก requested_by — มีเพียง issuer/client ที่เป็น deployment config ของ worker
BEGIN;

ALTER TABLE tenant_voice_identity_bindings DROP CONSTRAINT tenant_voice_identity_bindings_source_kind_check;
ALTER TABLE tenant_voice_identity_bindings ADD CONSTRAINT tenant_voice_identity_bindings_source_kind_check
  CHECK(source_kind IN ('BOOTSTRAP_MANIFEST','VERIFIED_ENROLLMENT','PLATFORM_PROVISIONING'));

CREATE FUNCTION dc_platform_bind_first_admin(scope uuid,request uuid,issuer_value text,client_value text)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  accepted public.pf_provisioning_requests%ROWTYPE;
  existing public.tenant_voice_identity_bindings%ROWTYPE;
  subject_value text;
  organization_value text;
  target uuid;
  evidence text;
BEGIN
  IF NOT pg_has_role(session_user,'dcontact_platform','MEMBER') THEN
    RAISE EXCEPTION 'PLATFORM_BINDING_SCOPE_DENIED' USING ERRCODE='42501';
  END IF;
  IF issuer_value IS NULL OR issuer_value !~ '^https?://[^[:space:]/]+(/[^[:space:]]*)?/realms/[A-Za-z0-9._-]+$'
    OR client_value IS NULL OR client_value !~ '^[A-Za-z0-9._-]{1,255}$'
    OR client_value IN ('platform-console','dcontact-platform-api','realm-management','admin-cli') THEN
    RAISE EXCEPTION 'PLATFORM_BINDING_CONTEXT_INVALID' USING ERRCODE='22023';
  END IF;

  SELECT * INTO accepted FROM public.pf_provisioning_requests WHERE id=request AND tenant_id=scope FOR SHARE;
  IF NOT FOUND OR accepted.status::text<>'SUCCEEDED' THEN
    RAISE EXCEPTION 'PLATFORM_BINDING_REQUEST_NOT_SUCCEEDED' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tenants tenant WHERE tenant.id=scope
    AND tenant.lifecycle_status::text='ACTIVE' AND tenant.slug=accepted.slug) THEN
    RAISE EXCEPTION 'PLATFORM_BINDING_TENANT_NOT_ACTIVE' USING ERRCODE='23514';
  END IF;

  SELECT step.external_ref INTO subject_value FROM public.pf_provisioning_steps step
    WHERE step.request_id=request AND step.tenant_id=scope AND step.step_key::text='FIRST_ADMIN'
      AND step.state::text='SUCCEEDED';
  SELECT step.external_ref INTO organization_value FROM public.pf_provisioning_steps step
    WHERE step.request_id=request AND step.tenant_id=scope AND step.step_key::text='KEYCLOAK_ORGANIZATION'
      AND step.state::text='SUCCEEDED';
  IF subject_value IS NULL OR subject_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    OR organization_value IS NULL
    OR organization_value !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RAISE EXCEPTION 'PLATFORM_BINDING_STEP_EVIDENCE_MISSING' USING ERRCODE='23514';
  END IF;

  -- first admin ของ request: แถวเดียวที่ keycloak_id ตรงผลขั้น FIRST_ADMIN และ email ตรง request
  SELECT person.id INTO target FROM public.users person
    WHERE person.tenant_id=scope AND person.keycloak_id=subject_value::uuid AND person.role::text='ADMIN'
      AND person.is_active AND person.password_hash='!keycloak-managed'
      AND person.email=accepted.first_admin_email;
  IF target IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_BINDING_FIRST_ADMIN_MISMATCH' USING ERRCODE='23514';
  END IF;

  evidence:=encode(sha256(convert_to(concat_ws(chr(10),'dcontact:platform-first-admin-binding:v1',
    scope::text,request::text,accepted.payload_digest,target::text,subject_value,organization_value,
    issuer_value,client_value,accepted.slug),'UTF8')),'hex');

  SELECT * INTO existing FROM public.tenant_voice_identity_bindings WHERE tenant_id=scope AND user_id=target;
  IF FOUND THEN
    IF existing.issuer=issuer_value AND existing.subject_id=subject_value AND existing.client_id=client_value
      AND existing.tenant_slug=accepted.slug AND existing.organization_id=organization_value::uuid
      AND existing.identity_class='TENANT_USER' AND existing.source_kind='PLATFORM_PROVISIONING'
      AND existing.evidence_ref='platform-provisioning:'||request::text AND existing.evidence_digest=evidence
      AND existing.verified_by_operator_subject=accepted.requested_by AND existing.is_active THEN
      RETURN existing.revision;
    END IF;
    RAISE EXCEPTION 'PLATFORM_BINDING_CONFLICT' USING ERRCODE='23514';
  END IF;

  INSERT INTO public.tenant_voice_identity_bindings(tenant_id,user_id,issuer,subject_id,client_id,tenant_slug,
    organization_id,identity_class,source_kind,evidence_ref,evidence_digest,verified_by_operator_subject,
    verified_at,revision,is_active)
  VALUES(scope,target,issuer_value,subject_value,client_value,accepted.slug,organization_value::uuid,'TENANT_USER',
    'PLATFORM_PROVISIONING','platform-provisioning:'||request::text,evidence,accepted.requested_by,
    clock_timestamp(),1,true);
  RETURN 1;
END $$;
REVOKE ALL ON FUNCTION dc_platform_bind_first_admin(uuid,uuid,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_platform_bind_first_admin(uuid,uuid,text,text) TO dcontact_platform;

COMMIT;
