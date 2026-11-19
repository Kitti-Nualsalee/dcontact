-- #914: first admin ที่ Platform provisioning สร้างได้ capability `CONTACT_CREATE` ของ Cus360 ทันที
--
-- เดิมให้ได้ทางเดียวคือ operator command (`platform-operator` ใน org login ของ tenant) ซึ่งต้องมีบัญชีใน tenant
-- และขัด #387 (platform identity ห้ามเป็นสมาชิก tenant) owner เลือก 19 พ.ย. 2569 ให้ provisioning ให้แทน
-- ยังไม่มี self-grant: เรียกได้เฉพาะ role `dcontact_platform` และผู้รับต้องเป็น first admin ที่มี binding
-- `PLATFORM_PROVISIONING` ของ request นี้แล้ว (#901) จึงเรียกหลัง `dc_platform_bind_first_admin` ใน transaction เดียวกัน
-- บันทึกตาม engine ของ Cus360: admission + effect + audit + receipt ใต้ command id ที่คำนวณจาก request
-- เรียกซ้ำไม่ให้ซ้ำ และถ้า grant เดิมถูกถอนแล้วจะไม่ให้ใหม่ (เคารพการถอน)
BEGIN;

CREATE FUNCTION dc_platform_grant_first_admin_contact_create(scope uuid, request uuid)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  accepted public.pf_provisioning_requests%ROWTYPE;
  target uuid;
  actor_key constant text := 'platform-provisioning';
  command uuid;
  seed text;
  evidence text;
  digest text;
  refs jsonb;
BEGIN
  IF NOT pg_has_role(session_user,'dcontact_platform','MEMBER') THEN
    RAISE EXCEPTION 'PLATFORM_CAPABILITY_SCOPE_DENIED' USING ERRCODE='42501';
  END IF;

  SELECT * INTO accepted FROM public.pf_provisioning_requests WHERE id=request AND tenant_id=scope FOR SHARE;
  IF NOT FOUND OR accepted.status::text<>'SUCCEEDED' THEN
    RAISE EXCEPTION 'PLATFORM_CAPABILITY_REQUEST_NOT_SUCCEEDED' USING ERRCODE='23514';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tenants tenant WHERE tenant.id=scope
    AND tenant.lifecycle_status::text='ACTIVE' AND tenant.slug=accepted.slug) THEN
    RAISE EXCEPTION 'PLATFORM_CAPABILITY_TENANT_NOT_ACTIVE' USING ERRCODE='23514';
  END IF;

  evidence:='platform-provisioning:'||request::text;
  -- ผู้รับ = first admin ที่ binding ของ request นี้ยังใช้งาน และบัญชียังเป็น ADMIN ที่ active
  SELECT binding.user_id INTO target FROM public.tenant_voice_identity_bindings binding
    JOIN public.users person ON person.tenant_id=binding.tenant_id AND person.id=binding.user_id
    WHERE binding.tenant_id=scope AND binding.source_kind='PLATFORM_PROVISIONING'
      AND binding.evidence_ref=evidence AND binding.is_active
      AND person.role::text='ADMIN' AND person.is_active
      AND person.keycloak_id::text=binding.subject_id;
  IF target IS NULL THEN
    RAISE EXCEPTION 'PLATFORM_CAPABILITY_BINDING_MISSING' USING ERRCODE='23514';
  END IF;

  -- command id คงที่ต่อ request (รูปแบบ UUID v5/variant 8) เพื่อให้เรียกซ้ำเห็นคำสั่งเดิม
  seed:=md5('dcontact:c360-first-admin-contact-create:v1:'||request::text);
  command:=(substr(seed,1,8)||'-'||substr(seed,9,4)||'-5'||substr(seed,14,3)||'-8'||
    substr(seed,18,3)||'-'||substr(seed,21,12))::uuid;

  -- เรียกซ้ำ: คำสั่งของ request นี้มีอยู่แล้ว ไม่ให้ซ้ำแม้ grant จะถูกถอนไปแล้ว
  IF EXISTS(SELECT 1 FROM public.c360_profile_commands existing
    WHERE existing.tenant_id=scope AND existing.actor_identity_key=actor_key AND existing.command_id=command) THEN
    RETURN 'NO_OP';
  END IF;
  -- first admin มีสิทธิ์อยู่แล้วจากทางอื่น (เช่น operator command): ไม่เพิ่ม grant ซ้ำ
  IF EXISTS(SELECT 1 FROM public.c360_actor_capability_grants grant_row
    WHERE grant_row.tenant_id=scope AND grant_row.grantee_user_id=target
      AND grant_row.capability='CONTACT_CREATE'
      AND NOT EXISTS(SELECT 1 FROM public.c360_actor_capability_revocations revocation
        WHERE revocation.tenant_id=grant_row.tenant_id AND revocation.grant_id=grant_row.id)) THEN
    RETURN 'NO_OP';
  END IF;

  digest:=encode(sha256(convert_to(concat_ws(chr(10),'dcontact:platform-first-admin-contact-create:v1',
    scope::text,request::text,accepted.payload_digest,target::text,'CONTACT_CREATE'),'UTF8')),'hex');
  refs:=jsonb_build_array(jsonb_build_object('type','USER','id',target::text));

  INSERT INTO public.c360_profile_commands(tenant_id,actor_identity_key,command_id,actor_user_id,action,
    resource_type,resource_id,payload_digest,normalization_contract_version)
  VALUES(scope,actor_key,command,NULL,'CAPABILITY_GRANT','USER',target,digest,'platform-provisioning-v1');
  INSERT INTO public.c360_actor_capability_grants(id,tenant_id,grantee_user_id,capability,evidence_ref,
    actor_identity_key,command_id,actor_user_id)
  VALUES(gen_random_uuid(),scope,target,'CONTACT_CREATE',evidence,actor_key,command,NULL);
  INSERT INTO public.c360_profile_audits(id,tenant_id,actor_identity_key,command_id,event_ordinal,actor_user_id,
    operation,resource_type,resource_id,changed_fields,evidence_refs)
  VALUES(gen_random_uuid(),scope,actor_key,command,0,NULL,'CAPABILITY_GRANT','USER',target,
    ARRAY['capability'],ARRAY[evidence,'requested-by:'||accepted.requested_by]);
  INSERT INTO public.c360_profile_command_receipts(tenant_id,actor_identity_key,command_id,outcome,code,
    http_status,resource_refs)
  VALUES(scope,actor_key,command,'APPLIED',NULL,200,refs);
  RETURN 'APPLIED';
END $$;
REVOKE ALL ON FUNCTION dc_platform_grant_first_admin_contact_create(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_platform_grant_first_admin_contact_create(uuid,uuid) TO dcontact_platform;

COMMIT;
