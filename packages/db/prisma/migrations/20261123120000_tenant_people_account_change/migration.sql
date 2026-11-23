-- #998 1B + 2: Admin แก้ชื่อที่แสดง (UPDATE_PROFILE) และเปิดบัญชีที่ปิดแล้วกลับ (ENABLE_ACCOUNT)
-- ใช้แบบเดียวกับ tenant_people_disables: accept ใน function เดียวภายใต้ fence, worker แบบ fenced lease,
-- receipt append-only และเปลี่ยน users/lifecycle เฉพาะเมื่อ Keycloak receipt สำเร็จพร้อม readback เท่านั้น
-- ผลไม่ชัดเจนคงสถานะเดิม (ชื่อเดิม / DISABLED) และ reconcile แบบอ่านอย่างเดียว ไม่ยิง mutation ซ้ำ

CREATE TABLE tenant_people_account_changes (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  kind text NOT NULL CHECK(kind IN ('UPDATE_PROFILE','ENABLE_ACCOUNT')),
  command_id uuid NOT NULL, actor_user_id uuid NOT NULL, user_id uuid NOT NULL,
  identity_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('AGENT','SUPERVISOR','ADMIN')),
  expected_revision integer NOT NULL CHECK(expected_revision>=1),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  display_name text CHECK(display_name IS NULL OR char_length(display_name) BETWEEN 1 AND 120),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  issuer text NOT NULL, client_id text NOT NULL, tenant_slug text NOT NULL,
  reason text NOT NULL CHECK(char_length(reason) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','WAITING_EXTERNAL','SUCCEEDED','REJECTED','ACTION_REQUIRED')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1), fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
  attempted boolean NOT NULL DEFAULT false, lease_owner uuid, lease_expires_at timestamptz,
  error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,command_id),
  FOREIGN KEY(tenant_id,command_id) REFERENCES voice_config_commands(tenant_id,command_id),
  FOREIGN KEY(tenant_id,actor_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id),
  CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL)),
  CHECK((kind='UPDATE_PROFILE')=(display_name IS NOT NULL))
);
-- หนึ่งคำสั่งค้างต่อผู้ใช้ เพื่อไม่ให้ชื่อ/สถานะใน Keycloak กับ app สลับลำดับกัน
CREATE UNIQUE INDEX tenant_people_account_change_pending ON tenant_people_account_changes(tenant_id,user_id)
  WHERE state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED');

CREATE TABLE tenant_people_account_change_receipts (
  tenant_id uuid NOT NULL, operation_id uuid NOT NULL, fencing_token bigint NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK(outcome IN ('SUCCEEDED','REJECTED_NO_EFFECT','UNKNOWN')),
  provider_receipt_ref text, reason_code text, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,operation_id,fencing_token),
  FOREIGN KEY(tenant_id,operation_id) REFERENCES tenant_people_account_changes(tenant_id,id),
  CHECK((outcome='UNKNOWN' AND provider_receipt_ref IS NULL) OR (outcome<>'UNKNOWN' AND provider_receipt_ref ~ '^[a-f0-9]{64}$'))
);
CREATE TRIGGER people_account_change_receipt_immutable BEFORE UPDATE OR DELETE ON tenant_people_account_change_receipts
  FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_people_account_changes','tenant_people_account_change_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',table_name);
    EXECUTE format('CREATE POLICY worker_binding_required ON %I AS RESTRICTIVE TO dcontact_tenant_people_worker USING (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled)) WITH CHECK (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled))',table_name,table_name,table_name);
  END LOOP;
END $$;

-- positive proof แบบเดียวกับ dc_people_disable_snapshot แต่รับบัญชีที่ปิดสำเร็จแล้วด้วย (สำหรับเปิดกลับ)
-- ไม่รับ PENDING_ACTIVATION: resend invitation ตรวจ firstName กับ payload ตอนสร้าง การแก้ชื่อก่อนเปิดใช้งานจะทำให้ resend ค้าง
CREATE FUNCTION dc_people_account_snapshot(scope uuid,target uuid,issuer_value text,client_value text,slug_value text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT to_jsonb(person) FROM (
    SELECT u.id,u.keycloak_id,u.role,u.team_id,u.is_active,u.config_revision,u.display_name,u.extension,
      l.revision AS status_revision,l.account_state,l.activation_state,
      b.revision AS binding_revision,
      (SELECT d.id FROM public.tenant_people_disables d WHERE d.tenant_id=u.tenant_id AND d.user_id=u.id AND d.state='SUCCEEDED'
        ORDER BY d.updated_at DESC,d.id LIMIT 1) AS disable_operation_id
    FROM public.users u
    LEFT JOIN public.tenant_user_lifecycles l ON l.tenant_id=u.tenant_id AND l.user_id=u.id
    LEFT JOIN public.tenant_people_operations o ON o.tenant_id=l.tenant_id AND o.id=l.operation_id AND o.target_user_id=u.id
    LEFT JOIN public.tenant_voice_identity_bindings b ON b.tenant_id=u.tenant_id AND b.user_id=u.id
      AND b.subject_id=u.keycloak_id::text AND b.identity_class='TENANT_USER' AND b.is_active
      AND b.issuer=issuer_value AND b.client_id=client_value AND b.tenant_slug=slug_value
    WHERE u.tenant_id=scope AND u.id=target AND scope=nullif(current_setting('app.tenant_id',true),'')::uuid
      AND u.keycloak_id IS NOT NULL AND u.role::text IN ('AGENT','SUPERVISOR','ADMIN')
      AND ((l.provisioning_state='PROVISIONED' AND l.account_state IN ('ACTIVE','DISABLED') AND l.activation_state='ACTIVATED'
          AND l.verified_identity_id=u.keycloak_id AND o.state='SUCCEEDED' AND o.step='VERIFY_PROVISIONED')
        OR (l.user_id IS NULL AND b.user_id IS NOT NULL))
  ) person
$$;

-- เงื่อนไขของแต่ละ kind ที่ต้องจริงทั้งตอน accept และตอน record ผล (ตรวจซ้ำใต้ lock)
CREATE FUNCTION dc_people_account_change_blocker(scope uuid,change_kind text,person jsonb) RETURNS text
LANGUAGE plpgsql STABLE SET search_path=pg_catalog,public AS $$
DECLARE target uuid:=(person->>'id')::uuid; team uuid:=(person->>'team_id')::uuid;
BEGIN
  IF person IS NULL THEN RETURN 'RESOURCE_NOT_FOUND'; END IF;
  IF EXISTS(SELECT 1 FROM public.tenant_people_disables WHERE tenant_id=scope AND user_id=target
      AND state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED'))
    OR EXISTS(SELECT 1 FROM public.tenant_people_operations WHERE tenant_id=scope AND target_user_id=target
      AND state NOT IN ('SUCCEEDED','REJECTED')) THEN RETURN 'ACCOUNT_STATE_CONFLICT'; END IF;
  IF change_kind='UPDATE_PROFILE' THEN
    IF NOT (person->>'is_active')::boolean OR coalesce(person->>'account_state','ACTIVE')<>'ACTIVE'
      THEN RETURN 'ACCOUNT_STATE_CONFLICT'; END IF;
    RETURN NULL;
  END IF;
  -- ENABLE_ACCOUNT: ต้องปิดสำเร็จจริง (disable SUCCEEDED) ไม่ใช่ inactive จากเหตุอื่น
  IF (person->>'is_active')::boolean OR person->>'disable_operation_id' IS NULL
    OR coalesce(person->>'account_state','DISABLED')<>'DISABLED' THEN RETURN 'ACCOUNT_STATE_CONFLICT'; END IF;
  IF team IS NULL AND person->>'role'='AGENT' THEN RETURN 'REFERENCE_SCOPE_MISMATCH'; END IF;
  IF team IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.teams WHERE tenant_id=scope AND id=team AND is_active)
    THEN RETURN 'REFERENCE_SCOPE_MISMATCH'; END IF;
  -- หมายเลขภายในเดิมต้องยังเป็นของผู้ใช้: reservation ไม่ถูก tombstone และไม่มีบัญชีที่นับ seat อื่นใช้เลขเดียวกัน
  IF person->>'role'='AGENT' AND person->>'extension' IS NOT NULL AND (
      EXISTS(SELECT 1 FROM public.tenant_identity_reservations WHERE tenant_id=scope AND target_user_id=target
        AND identity_kind='EXTENSION' AND status='TOMBSTONED')
      OR (person->>'status_revision' IS NOT NULL AND NOT EXISTS(SELECT 1 FROM public.tenant_identity_reservations
        WHERE tenant_id=scope AND target_user_id=target AND identity_kind='EXTENSION'))
      OR EXISTS(SELECT 1 FROM public.users other WHERE other.tenant_id=scope AND other.id<>target
        AND other.extension=person->>'extension' AND other.is_active)) THEN RETURN 'EXTENSION_CONFLICT'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION dc_people_account_change_descriptor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','revision','fencing_token','attempted','lease_owner','lease_expires_at','error_code','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','fencing_token','attempted','lease_owner','lease_expires_at','error_code','updated_at'])
    OR NEW.revision<>OLD.revision+1 OR NEW.fencing_token<OLD.fencing_token OR (OLD.attempted AND NOT NEW.attempted)
    OR OLD.state IN ('SUCCEEDED','REJECTED') THEN RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER people_account_change_descriptor BEFORE UPDATE OR DELETE ON tenant_people_account_changes
  FOR EACH ROW EXECUTE FUNCTION dc_people_account_change_descriptor();

-- seat ของบัญชีที่กำลังเปิดกลับถูกจองตั้งแต่ accept เพื่อไม่ให้สองคำสั่งเปิดกลับเกิน quota พร้อมกัน
CREATE OR REPLACE FUNCTION dc_people_reserved_accounts(scope uuid,agents_only boolean DEFAULT false) RETURNS bigint
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT count(*) FROM public.users u WHERE u.tenant_id=scope AND scope=nullif(current_setting('app.tenant_id',true),'')::uuid
    AND (NOT agents_only OR u.role='AGENT') AND NOT (NOT u.is_active AND (
      EXISTS(SELECT 1 FROM public.tenant_user_lifecycles l WHERE l.tenant_id=scope AND l.user_id=u.id AND l.account_state='DISABLED')
      OR EXISTS(SELECT 1 FROM public.tenant_people_disables d WHERE d.tenant_id=scope AND d.user_id=u.id AND d.state='SUCCEEDED'))
      AND NOT EXISTS(SELECT 1 FROM public.tenant_people_account_changes c WHERE c.tenant_id=scope AND c.user_id=u.id
        AND c.kind='ENABLE_ACCOUNT' AND c.state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED')))
$$;

CREATE FUNCTION dc_people_accept_account_change(scope uuid,operation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.tenant_people_account_changes%ROWTYPE; current_snapshot jsonb; blocker text; limits record;
BEGIN
  IF scope IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR NOT pg_has_role(session_user,'dcontact_app','MEMBER')
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls))
    THEN RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||scope::text,0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:tenant-account:'||scope::text,0))
    THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  SELECT * INTO accepted FROM public.tenant_people_account_changes WHERE tenant_id=scope AND id=operation FOR UPDATE;
  IF NOT FOUND OR accepted.state<>'QUEUED' OR accepted.attempted THEN
    RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_STATE_CONFLICT' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=scope AND lifecycle_status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE tenant_id=scope AND id=accepted.actor_user_id AND role='ADMIN' AND is_active)
    OR NOT EXISTS(SELECT 1 FROM public.voice_config_commands WHERE tenant_id=scope AND command_id=accepted.command_id
      AND actor_user_id=accepted.actor_user_id AND resource_id=accepted.user_id AND expected_revision=accepted.expected_revision
      AND action=accepted.kind AND command_kind='PEOPLE_ACCOUNT_CHANGE')
    THEN RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=scope AND id IN (accepted.actor_user_id,accepted.user_id) ORDER BY id FOR UPDATE NOWAIT;
  current_snapshot:=public.dc_people_account_snapshot(scope,accepted.user_id,accepted.issuer,accepted.client_id,accepted.tenant_slug);
  IF current_snapshot IS NULL THEN RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF accepted.snapshot IS DISTINCT FROM current_snapshot OR accepted.role IS DISTINCT FROM current_snapshot->>'role'
    OR accepted.identity_id::text IS DISTINCT FROM current_snapshot->>'keycloak_id'
    OR accepted.expected_revision IS DISTINCT FROM (current_snapshot->>'config_revision')::integer
    THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  -- แถวนี้เป็นคำสั่งค้างแล้ว จึงไม่นับตัวเองเป็น blocker (unique index กันคำสั่งที่สองต่อผู้ใช้อยู่แล้ว)
  blocker:=public.dc_people_account_change_blocker(scope,accepted.kind,current_snapshot);
  IF blocker IS NOT NULL THEN RAISE EXCEPTION '%',blocker USING ERRCODE='23514'; END IF;
  IF accepted.kind='UPDATE_PROFILE' AND accepted.display_name=current_snapshot->>'display_name' THEN
    RAISE EXCEPTION 'VALIDATION_FAILED' USING ERRCODE='22023'; END IF;
  IF accepted.kind='ENABLE_ACCOUNT' THEN
    IF NOT public.dc_people_disable_idle(scope,accepted.user_id) THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
    SELECT accounts_limit,agents_limit INTO limits FROM public.tenant_voice_provisioning_policies WHERE tenant_id=scope;
    IF NOT FOUND THEN RAISE EXCEPTION 'RESOURCE_POLICY_NOT_READY' USING ERRCODE='55000'; END IF;
    -- dc_people_reserved_accounts นับแถวที่เพิ่ง insert แล้ว จึงต้องไม่เกิน limit
    IF public.dc_people_reserved_accounts(scope,false)>limits.accounts_limit
      OR (accepted.role='AGENT' AND public.dc_people_reserved_accounts(scope,true)>limits.agents_limit)
      THEN RAISE EXCEPTION 'RESOURCE_LIMIT_REACHED' USING ERRCODE='23514'; END IF;
  END IF;
END $$;

CREATE FUNCTION dc_people_account_change_admission_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM voice_config_command_receipts WHERE tenant_id=NEW.tenant_id AND command_id=NEW.command_id)
    OR NOT EXISTS(SELECT 1 FROM voice_config_audit WHERE tenant_id=NEW.tenant_id AND command_id=NEW.command_id
      AND resource_id=NEW.user_id AND action=NEW.kind AND outcome='ACCEPTED')
    THEN RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_ADMISSION_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER people_account_change_admission_final AFTER INSERT ON tenant_people_account_changes
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_people_account_change_admission_final();

-- คำสั่ง PEOPLE_ACCOUNT_CHANGE ที่ commit ต้องมีแถว ledger ที่ผ่าน accept function เสมอ
CREATE FUNCTION dc_people_account_change_command_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.command_kind<>'PEOPLE_ACCOUNT_CHANGE' THEN RETURN NULL; END IF;
  IF NEW.action NOT IN ('UPDATE_PROFILE','ENABLE_ACCOUNT') OR NOT EXISTS(SELECT 1 FROM tenant_people_account_changes c
      WHERE c.tenant_id=NEW.tenant_id AND c.command_id=NEW.command_id AND c.kind=NEW.action AND c.user_id=NEW.resource_id
        AND c.actor_user_id=NEW.actor_user_id AND c.expected_revision=NEW.expected_revision)
    THEN RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_EVIDENCE_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER people_account_change_command_final AFTER INSERT ON voice_config_commands
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_people_account_change_command_final();

CREATE FUNCTION dc_people_claim_account_change(scope uuid,operation uuid,owner_id uuid)
RETURNS TABLE(descriptor jsonb,reconcile_only boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.tenant_people_account_changes%ROWTYPE; previous_attempt boolean;
BEGIN
  PERFORM public.dc_people_activation_authorize(scope);
  SELECT * INTO accepted FROM public.tenant_people_account_changes WHERE tenant_id=scope AND id=operation
    AND state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  previous_attempt:=accepted.attempted;
  UPDATE public.tenant_people_account_changes SET revision=revision+1,fencing_token=fencing_token+1,attempted=true,state='WAITING_EXTERNAL',
    lease_owner=owner_id,lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
    WHERE tenant_id=scope AND id=operation RETURNING * INTO accepted;
  RETURN QUERY SELECT jsonb_build_object('kind',accepted.kind,'user_id',accepted.user_id,'identity_id',accepted.identity_id,
    'role',accepted.role,'payload_digest',accepted.payload_digest,'fencing_token',accepted.fencing_token::text,
    'display_name',accepted.display_name),previous_attempt;
END $$;

CREATE FUNCTION dc_people_record_account_change(scope uuid,operation uuid,owner_id uuid,fence bigint,proof_digest text,identity_value uuid,
  provider_outcome text,receipt_ref text,reason_value text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.tenant_people_account_changes%ROWTYPE; result_state text; current_snapshot jsonb; applied boolean:=false;
BEGIN
  PERFORM public.dc_people_activation_authorize(scope);
  PERFORM pg_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||scope::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('dc:v1:tenant-account:'||scope::text,0));
  SELECT * INTO accepted FROM public.tenant_people_account_changes WHERE tenant_id=scope AND id=operation FOR UPDATE;
  IF NOT FOUND OR accepted.lease_owner IS DISTINCT FROM owner_id OR accepted.fencing_token<>fence
    OR accepted.lease_expires_at<=clock_timestamp() OR accepted.state<>'WAITING_EXTERNAL' THEN RETURN 'STALE'; END IF;
  IF accepted.payload_digest<>proof_digest OR accepted.identity_id<>identity_value
    OR provider_outcome NOT IN ('SUCCEEDED','REJECTED_NO_EFFECT','UNKNOWN')
    OR (provider_outcome<>'UNKNOWN' AND (receipt_ref IS NULL OR receipt_ref !~ '^[a-f0-9]{64}$'))
    OR (provider_outcome='SUCCEEDED' AND reason_value IS DISTINCT FROM CASE accepted.kind WHEN 'UPDATE_PROFILE' THEN 'PROFILE_UPDATED' ELSE 'ENABLED' END)
    THEN RAISE EXCEPTION 'PEOPLE_ACCOUNT_CHANGE_PROOF_MISMATCH' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=scope AND id=accepted.user_id FOR UPDATE;
  INSERT INTO public.tenant_people_account_change_receipts(tenant_id,operation_id,fencing_token,payload_digest,outcome,provider_receipt_ref,reason_code)
    VALUES(scope,operation,fence,proof_digest,provider_outcome,CASE WHEN provider_outcome='UNKNOWN' THEN NULL ELSE receipt_ref END,reason_value);
  result_state:='ACTION_REQUIRED';
  IF provider_outcome='REJECTED_NO_EFFECT' THEN
    result_state:='REJECTED';
  ELSIF provider_outcome='SUCCEEDED' THEN
    -- local state ต้องยังตรงกับตอน accept (ยกเว้น kind=UPDATE_PROFILE ที่ revision อาจเปลี่ยนเพราะย้ายทีม) ไม่งั้นต้อง reconcile
    current_snapshot:=public.dc_people_account_snapshot(scope,accepted.user_id,accepted.issuer,accepted.client_id,accepted.tenant_slug);
    IF current_snapshot IS NOT NULL AND current_snapshot->>'keycloak_id'=accepted.identity_id::text AND current_snapshot->>'role'=accepted.role THEN
      IF accepted.kind='UPDATE_PROFILE' AND (current_snapshot->>'is_active')::boolean THEN
        UPDATE public.users SET display_name=accepted.display_name,config_revision=config_revision+1
          WHERE tenant_id=scope AND id=accepted.user_id AND keycloak_id=accepted.identity_id;
        applied:=FOUND;
      ELSIF accepted.kind='ENABLE_ACCOUNT' AND current_snapshot IS NOT DISTINCT FROM accepted.snapshot THEN
        UPDATE public.users SET is_active=true,config_revision=config_revision+1
          WHERE tenant_id=scope AND id=accepted.user_id AND NOT is_active AND config_revision=accepted.expected_revision AND keycloak_id=accepted.identity_id;
        applied:=FOUND;
        IF applied THEN
          UPDATE public.tenant_user_lifecycles SET revision=revision+1,account_state='ACTIVE'
            WHERE tenant_id=scope AND user_id=accepted.user_id AND account_state='DISABLED';
        END IF;
      END IF;
    END IF;
    IF applied THEN result_state:='SUCCEEDED'; END IF;
  END IF;
  UPDATE public.tenant_people_account_changes SET revision=revision+1,state=result_state,lease_owner=NULL,lease_expires_at=NULL,
    error_code=CASE WHEN result_state='SUCCEEDED' THEN NULL WHEN provider_outcome='SUCCEEDED' THEN 'ACCOUNT_CHANGE_RECONCILIATION_REQUIRED'
      ELSE coalesce(reason_value,'IDENTITY_OUTCOME_UNKNOWN') END,updated_at=clock_timestamp()
    WHERE tenant_id=scope AND id=operation;
  INSERT INTO public.voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id)
    VALUES(gen_random_uuid(),scope,accepted.actor_user_id,accepted.user_id,NULL,accepted.kind,result_state,
      NULL,NULL,CASE accepted.kind WHEN 'UPDATE_PROFILE' THEN ARRAY['displayName','identityOutcome'] ELSE ARRAY['isActive','accountState','identityOutcome'] END,
      coalesce(reason_value,'IDENTITY_OUTCOME_UNKNOWN'),operation::text);
  RETURN result_state;
END $$;

REVOKE ALL ON FUNCTION dc_people_account_snapshot(uuid,uuid,text,text,text),dc_people_account_change_blocker(uuid,text,jsonb),
  dc_people_accept_account_change(uuid,uuid),dc_people_claim_account_change(uuid,uuid,uuid),
  dc_people_record_account_change(uuid,uuid,uuid,bigint,text,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_account_snapshot(uuid,uuid,text,text,text),dc_people_account_change_blocker(uuid,text,jsonb),
  dc_people_accept_account_change(uuid,uuid) TO dcontact_app;
GRANT EXECUTE ON FUNCTION dc_people_claim_account_change(uuid,uuid,uuid),
  dc_people_record_account_change(uuid,uuid,uuid,bigint,text,uuid,text,text,text) TO dcontact_tenant_people_worker;

-- ย้ายทีมและปิดบัญชีต้องไม่แทรกระหว่างคำสั่งที่ค้างของผู้ใช้คนเดียวกัน
CREATE FUNCTION dc_people_account_change_pending(scope uuid,target uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT EXISTS(SELECT 1 FROM public.tenant_people_account_changes WHERE tenant_id=scope AND user_id=target
    AND state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED'))
$$;
REVOKE ALL ON FUNCTION dc_people_account_change_pending(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_account_change_pending(uuid,uuid) TO dcontact_app;
