CREATE TABLE tenant_people_disables (
  tenant_id uuid NOT NULL REFERENCES tenants(id), id uuid NOT NULL,
  command_id uuid NOT NULL, actor_user_id uuid NOT NULL, user_id uuid NOT NULL,
  identity_id uuid NOT NULL, role text NOT NULL CHECK(role IN ('AGENT','SUPERVISOR','ADMIN')),
  expected_revision integer NOT NULL CHECK(expected_revision>=1),
  snapshot jsonb NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  issuer text NOT NULL, client_id text NOT NULL, tenant_slug text NOT NULL,
  affected_queues uuid[] NOT NULL, affected_users uuid[] NOT NULL,
  reason_code text NOT NULL CHECK(reason_code ~ '^[A-Z][A-Z0-9_]{2,63}$'), reason text NOT NULL CHECK(length(reason) BETWEEN 1 AND 500),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','WAITING_EXTERNAL','SUCCEEDED','REJECTED','ACTION_REQUIRED')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1), fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
  attempted boolean NOT NULL DEFAULT false, lease_owner uuid, lease_expires_at timestamptz,
  error_code text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,id), UNIQUE(tenant_id,command_id),
  FOREIGN KEY(tenant_id,command_id) REFERENCES voice_config_commands(tenant_id,command_id),
  FOREIGN KEY(tenant_id,actor_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id),
  CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL))
);
CREATE UNIQUE INDEX tenant_people_disable_pending_user ON tenant_people_disables(tenant_id,user_id)
  WHERE state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED');
CREATE UNIQUE INDEX tenant_people_disable_pending_admin ON tenant_people_disables(tenant_id)
  WHERE role='ADMIN' AND state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED');

CREATE TABLE tenant_people_disable_receipts (
  tenant_id uuid NOT NULL, operation_id uuid NOT NULL, fencing_token bigint NOT NULL,
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK(outcome IN ('SUCCEEDED','REJECTED_NO_EFFECT','UNKNOWN')),
  provider_receipt_ref text, reason_code text, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,operation_id,fencing_token),
  FOREIGN KEY(tenant_id,operation_id) REFERENCES tenant_people_disables(tenant_id,id),
  CHECK((outcome='UNKNOWN' AND provider_receipt_ref IS NULL) OR (outcome<>'UNKNOWN' AND provider_receipt_ref ~ '^[a-f0-9]{64}$'))
);
CREATE TRIGGER people_disable_receipt_immutable BEFORE UPDATE OR DELETE ON tenant_people_disable_receipts
  FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();

CREATE TABLE tenant_people_disable_flushes (
  tenant_id uuid NOT NULL, operation_id uuid NOT NULL, work_session_lease_id uuid NOT NULL,
  extension text NOT NULL, sip_domain text NOT NULL, telephony_node_id text NOT NULL,
  PRIMARY KEY(tenant_id,operation_id,work_session_lease_id),
  FOREIGN KEY(tenant_id,operation_id) REFERENCES tenant_people_disables(tenant_id,id),
  FOREIGN KEY(work_session_lease_id) REFERENCES agent_sip_credentials(work_session_lease_id)
);
CREATE TRIGGER people_disable_flush_immutable BEFORE UPDATE OR DELETE ON tenant_people_disable_flushes
  FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_people_disables','tenant_people_disable_receipts','tenant_people_disable_flushes'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',table_name);
    EXECUTE format('CREATE POLICY worker_binding_required ON %I AS RESTRICTIVE TO dcontact_tenant_people_worker USING (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled)) WITH CHECK (EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=%I.tenant_id AND b.database_principal=session_user AND b.enabled))',table_name,table_name,table_name);
  END LOOP;
END $$;

CREATE FUNCTION dc_people_disable_snapshot(scope uuid,target uuid,issuer_value text,client_value text,slug_value text)
RETURNS jsonb LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  WITH eligible AS (
    SELECT u.id,u.keycloak_id,u.role,u.team_id,u.is_active,u.config_revision,
      l.revision AS status_revision,l.account_state,l.activation_state,l.provisioning_state,l.operation_id,
      b.revision AS binding_revision
    FROM public.users u
    LEFT JOIN public.tenant_user_lifecycles l ON l.tenant_id=u.tenant_id AND l.user_id=u.id
    LEFT JOIN public.tenant_people_operations o ON o.tenant_id=l.tenant_id AND o.id=l.operation_id AND o.target_user_id=u.id
    LEFT JOIN public.tenant_voice_identity_bindings b ON b.tenant_id=u.tenant_id AND b.user_id=u.id
      AND b.subject_id=u.keycloak_id::text AND b.identity_class='TENANT_USER' AND b.is_active
      AND b.issuer=issuer_value AND b.client_id=client_value AND b.tenant_slug=slug_value
    WHERE u.tenant_id=scope AND scope=nullif(current_setting('app.tenant_id',true),'')::uuid
      AND u.keycloak_id IS NOT NULL AND u.role::text IN ('AGENT','SUPERVISOR','ADMIN')
      AND ((l.provisioning_state='PROVISIONED' AND l.account_state IN ('ACTIVE','PENDING_ACTIVATION') AND l.verified_identity_id=u.keycloak_id AND o.state='SUCCEEDED' AND o.step='VERIFY_PROVISIONED')
        OR (l.user_id IS NULL AND b.user_id IS NOT NULL))
  )
  SELECT jsonb_build_object('target',to_jsonb(person),'admins',coalesce((
    SELECT jsonb_agg(to_jsonb(admin) ORDER BY admin.id) FROM eligible admin
    WHERE admin.role='ADMIN' AND admin.is_active
      AND (admin.status_revision IS NULL OR (admin.account_state='ACTIVE' AND admin.activation_state='ACTIVATED'))
  ),'[]'::jsonb)) FROM eligible person WHERE person.id=target
$$;

CREATE FUNCTION dc_people_disable_closure(scope uuid,target uuid)
RETURNS TABLE(queue_ids uuid[],user_ids uuid[]) LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  WITH target_skills AS (SELECT skill_id FROM public.agent_skills WHERE tenant_id=scope AND user_id=target),
  affected_queues AS (
    SELECT q.id,q.team_id FROM public.queues q WHERE q.tenant_id=scope
      AND EXISTS(SELECT 1 FROM public.users u WHERE u.tenant_id=scope AND u.id=target AND u.role='AGENT')
      AND (EXISTS(SELECT 1 FROM public.queue_skills qs WHERE qs.tenant_id=scope AND qs.queue_id=q.id AND qs.skill_id IN(SELECT skill_id FROM target_skills))
        OR NOT EXISTS(SELECT 1 FROM public.queue_skills qs WHERE qs.tenant_id=scope AND qs.queue_id=q.id))
  ), affected_users AS (
    SELECT target AS id UNION SELECT u.id FROM public.users u WHERE u.tenant_id=scope AND u.role='AGENT' AND (
      u.team_id IN(SELECT team_id FROM affected_queues)
      OR u.id IN(SELECT user_id FROM public.agent_skills WHERE tenant_id=scope AND skill_id IN(SELECT skill_id FROM target_skills))
      OR u.id IN(SELECT agent_id FROM public.interactions WHERE tenant_id=scope AND queue_id IN(SELECT id FROM affected_queues)))
  ) SELECT coalesce((SELECT array_agg(id ORDER BY id) FROM affected_queues),'{}'::uuid[]),
    coalesce((SELECT array_agg(id ORDER BY id) FROM affected_users),'{}'::uuid[])
  WHERE scope=nullif(current_setting('app.tenant_id',true),'')::uuid
$$;

CREATE FUNCTION dc_people_disable_idle(scope uuid,target uuid) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT NOT EXISTS(SELECT 1 FROM public.interactions i,public.dc_people_disable_closure(scope,target) closure
    WHERE i.tenant_id=scope AND i.state IN ('QUEUED','ASSIGNED','ACTIVE','WRAPUP')
      AND (i.queue_id=ANY(closure.queue_ids) OR i.agent_id=ANY(closure.user_ids)
        OR i.metadata->>'targetAgentId'=ANY(closure.user_ids::text[]) OR i.metadata->>'target_agent_id'=ANY(closure.user_ids::text[])))
    AND NOT EXISTS(SELECT 1 FROM public.voice_managed_commands cmd
      JOIN public.interactions i ON i.tenant_id=cmd.tenant_id AND i.id=cmd.interaction_id
      LEFT JOIN public.voice_managed_offers offer ON offer.tenant_id=cmd.tenant_id AND offer.id=cmd.offer_id,
      public.dc_people_disable_closure(scope,target) closure
      WHERE cmd.tenant_id=scope AND cmd.status='PENDING' AND cmd.command_type IN ('offer.cancel','call.hangup')
        AND (i.queue_id=ANY(closure.queue_ids) OR i.agent_id=ANY(closure.user_ids) OR offer.agent_id=ANY(closure.user_ids)))
$$;

CREATE FUNCTION dc_people_disable_descriptor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PEOPLE_DISABLE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(NEW)-ARRAY['state','revision','fencing_token','attempted','lease_owner','lease_expires_at','error_code','updated_at'])
    IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['state','revision','fencing_token','attempted','lease_owner','lease_expires_at','error_code','updated_at'])
    OR NEW.revision<>OLD.revision+1 OR NEW.fencing_token<OLD.fencing_token OR (OLD.attempted AND NOT NEW.attempted)
    OR OLD.state IN ('SUCCEEDED','REJECTED') THEN RAISE EXCEPTION 'PEOPLE_DISABLE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER people_disable_descriptor BEFORE UPDATE OR DELETE ON tenant_people_disables
  FOR EACH ROW EXECUTE FUNCTION dc_people_disable_descriptor();

CREATE FUNCTION dc_people_accept_disable(scope uuid,operation uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.tenant_people_disables%ROWTYPE; closure record;
BEGIN
  IF scope IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid
    OR NOT pg_has_role(session_user,'dcontact_app','MEMBER')
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND (rolsuper OR rolbypassrls))
    THEN RAISE EXCEPTION 'PEOPLE_DISABLE_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||scope::text,0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:tenant-account:'||scope::text,0))
    THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  SELECT * INTO accepted FROM public.tenant_people_disables WHERE tenant_id=scope AND id=operation FOR UPDATE;
  IF NOT FOUND OR accepted.state<>'QUEUED' OR accepted.attempted THEN RAISE EXCEPTION 'PEOPLE_DISABLE_STATE_CONFLICT' USING ERRCODE='23514'; END IF;
  IF accepted.role IS DISTINCT FROM accepted.snapshot->'target'->>'role'
    OR accepted.snapshot IS DISTINCT FROM public.dc_people_disable_snapshot(scope,accepted.user_id,accepted.issuer,accepted.client_id,accepted.tenant_slug)
    THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.tenants WHERE id=scope AND lifecycle_status='ACTIVE')
    OR NOT EXISTS(SELECT 1 FROM public.users WHERE tenant_id=scope AND id=accepted.actor_user_id AND role='ADMIN' AND is_active)
    OR NOT EXISTS(SELECT 1 FROM public.voice_config_commands WHERE tenant_id=scope AND command_id=accepted.command_id
      AND actor_user_id=accepted.actor_user_id AND resource_id=accepted.user_id AND expected_revision=accepted.expected_revision
      AND action='DISABLE_TENANT_USER' AND command_kind='PEOPLE_DISABLE')
    THEN RAISE EXCEPTION 'PEOPLE_DISABLE_SCOPE_DENIED' USING ERRCODE='42501'; END IF;
  SELECT * INTO closure FROM public.dc_people_disable_closure(scope,accepted.user_id);
  IF accepted.affected_queues IS DISTINCT FROM closure.queue_ids OR accepted.affected_users IS DISTINCT FROM closure.user_ids
    OR NOT public.dc_people_disable_idle(scope,accepted.user_id) THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=scope AND id=ANY(closure.user_ids||ARRAY[accepted.actor_user_id]) ORDER BY id FOR UPDATE NOWAIT;
  PERFORM 1 FROM public.queues WHERE tenant_id=scope AND id=ANY(closure.queue_ids) ORDER BY id FOR UPDATE NOWAIT;
  UPDATE public.users SET is_active=false,config_revision=config_revision+1 WHERE tenant_id=scope AND id=accepted.user_id
    AND config_revision=accepted.expected_revision AND keycloak_id=accepted.identity_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  UPDATE public.tenant_user_lifecycles SET revision=revision+1,account_state='DISABLING' WHERE tenant_id=scope AND user_id=accepted.user_id;
  INSERT INTO public.tenant_people_disable_flushes(tenant_id,operation_id,work_session_lease_id,extension,sip_domain,telephony_node_id)
    SELECT scope,operation,work_session_lease_id,extension,sip_domain,telephony_node_id FROM public.agent_sip_credentials
    WHERE tenant_id=scope AND user_id=accepted.user_id;
  UPDATE public.agent_sip_credentials SET revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE tenant_id=scope AND user_id=accepted.user_id;
  INSERT INTO public.agent_work_session_events(id,tenant_id,user_id,lease_id,action,surface,host_origin,correlation_id,occurred_at)
    SELECT gen_random_uuid(),scope,accepted.user_id,id,'AUTH_REVOKED',surface,host_origin,operation::text,clock_timestamp()
    FROM public.agent_work_session_leases WHERE tenant_id=scope AND user_id=accepted.user_id AND released_at IS NULL;
  UPDATE public.agent_work_session_leases SET released_at=clock_timestamp(),release_reason='auth_revoked'
    WHERE tenant_id=scope AND user_id=accepted.user_id AND released_at IS NULL;
  IF accepted.role='AGENT' THEN
    INSERT INTO public.agent_state_logs(tenant_id,user_id,state,reason,started_at)
      VALUES(scope,accepted.user_id,'OFFLINE','tenant_account_disabling',clock_timestamp());
  END IF;
END $$;

CREATE FUNCTION dc_people_disable_admission_final() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM users WHERE tenant_id=NEW.tenant_id AND id=NEW.user_id AND NOT is_active AND config_revision=NEW.expected_revision+1)
    OR NOT EXISTS(SELECT 1 FROM voice_config_command_receipts WHERE tenant_id=NEW.tenant_id AND command_id=NEW.command_id)
    OR NOT EXISTS(SELECT 1 FROM voice_config_audit WHERE tenant_id=NEW.tenant_id AND command_id=NEW.command_id
      AND resource_id=NEW.user_id AND action='DISABLE_TENANT_USER' AND outcome='ACCEPTED')
    THEN RAISE EXCEPTION 'PEOPLE_DISABLE_ADMISSION_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER people_disable_admission_final AFTER INSERT ON tenant_people_disables
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_people_disable_admission_final();

CREATE FUNCTION dc_people_claim_disable(scope uuid,operation uuid,owner_id uuid)
RETURNS TABLE(descriptor jsonb,reconcile_only boolean) LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.tenant_people_disables%ROWTYPE; previous_attempt boolean;
BEGIN
  PERFORM public.dc_people_activation_authorize(scope);
  SELECT * INTO accepted FROM public.tenant_people_disables WHERE tenant_id=scope AND id=operation
    AND state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED;
  IF NOT FOUND THEN RETURN; END IF;
  previous_attempt:=accepted.attempted;
  UPDATE public.tenant_people_disables SET revision=revision+1,fencing_token=fencing_token+1,attempted=true,state='WAITING_EXTERNAL',
    lease_owner=owner_id,lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
    WHERE tenant_id=scope AND id=operation RETURNING * INTO accepted;
  RETURN QUERY SELECT to_jsonb(accepted)||jsonb_build_object('fencing_token',accepted.fencing_token::text),previous_attempt;
END $$;

CREATE FUNCTION dc_people_record_disable(scope uuid,operation uuid,owner_id uuid,fence bigint,proof_digest text,identity_value uuid,
  provider_outcome text,receipt_ref text,reason_value text) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE accepted public.tenant_people_disables%ROWTYPE; result_state text; compensation boolean:=false;
BEGIN
  PERFORM public.dc_people_activation_authorize(scope);
  PERFORM pg_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||scope::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended('dc:v1:tenant-account:'||scope::text,0));
  SELECT * INTO accepted FROM public.tenant_people_disables WHERE tenant_id=scope AND id=operation FOR UPDATE;
  IF NOT FOUND OR accepted.lease_owner IS DISTINCT FROM owner_id OR accepted.fencing_token<>fence
    OR accepted.lease_expires_at<=clock_timestamp() OR accepted.state<>'WAITING_EXTERNAL' THEN RETURN 'STALE'; END IF;
  IF accepted.payload_digest<>proof_digest OR accepted.identity_id<>identity_value
    OR provider_outcome NOT IN ('SUCCEEDED','REJECTED_NO_EFFECT','UNKNOWN')
    OR (provider_outcome<>'UNKNOWN' AND (receipt_ref IS NULL OR receipt_ref !~ '^[a-f0-9]{64}$'))
    OR (provider_outcome='SUCCEEDED' AND reason_value IS DISTINCT FROM 'DISABLED')
    THEN RAISE EXCEPTION 'PEOPLE_DISABLE_PROOF_MISMATCH' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.users WHERE tenant_id=scope AND id=accepted.user_id FOR UPDATE;
  INSERT INTO public.tenant_people_disable_receipts(tenant_id,operation_id,fencing_token,payload_digest,outcome,provider_receipt_ref,reason_code)
    VALUES(scope,operation,fence,proof_digest,provider_outcome,CASE WHEN provider_outcome='UNKNOWN' THEN NULL ELSE receipt_ref END,reason_value);
  result_state:='ACTION_REQUIRED';
  IF EXISTS(SELECT 1 FROM public.users WHERE tenant_id=scope AND id=accepted.user_id AND NOT is_active
      AND config_revision=accepted.expected_revision+1 AND keycloak_id=accepted.identity_id AND role::text=accepted.role)
    AND NOT EXISTS(SELECT 1 FROM public.tenant_user_lifecycles WHERE tenant_id=scope AND user_id=accepted.user_id
      AND (revision IS DISTINCT FROM (accepted.snapshot->'target'->>'status_revision')::integer+1 OR account_state<>'DISABLING')) THEN
    IF provider_outcome='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM public.tenant_people_disable_flushes flush
      WHERE flush.tenant_id=scope AND flush.operation_id=operation AND NOT EXISTS(SELECT 1 FROM public.dl_voice_audit_events audit
        WHERE audit.tenant_id=scope AND audit.event_id='e1-sandbox:sip.registration.flush:'||flush.work_session_lease_id::text AND audit.code='E1_SANDBOX_REGISTRATION_FLUSHED')) THEN
      result_state:='SUCCEEDED';
      UPDATE public.tenant_user_lifecycles SET revision=revision+1,account_state='DISABLED' WHERE tenant_id=scope AND user_id=accepted.user_id;
    ELSIF provider_outcome='REJECTED_NO_EFFECT' AND reason_value='LAST_USABLE_ADMIN' AND public.dc_people_disable_idle(scope,accepted.user_id)
      AND ((accepted.snapshot->'target'->>'binding_revision') IS NULL OR EXISTS(SELECT 1 FROM public.tenant_voice_identity_bindings
        WHERE tenant_id=scope AND user_id=accepted.user_id AND revision=(accepted.snapshot->'target'->>'binding_revision')::integer AND is_active AND subject_id=accepted.identity_id::text)) THEN
      UPDATE public.users SET is_active=(accepted.snapshot->'target'->>'is_active')::boolean,config_revision=config_revision+1 WHERE tenant_id=scope AND id=accepted.user_id;
      UPDATE public.tenant_user_lifecycles SET revision=revision+1,account_state=accepted.snapshot->'target'->>'account_state'
        WHERE tenant_id=scope AND user_id=accepted.user_id;
      result_state:='REJECTED';compensation:=true;
    END IF;
  END IF;
  UPDATE public.tenant_people_disables SET revision=revision+1,state=result_state,lease_owner=NULL,lease_expires_at=NULL,
    error_code=CASE WHEN result_state='SUCCEEDED' THEN NULL WHEN provider_outcome='SUCCEEDED' THEN 'DISABLE_RECONCILIATION_REQUIRED' ELSE coalesce(reason_value,'IDENTITY_OUTCOME_UNKNOWN') END,updated_at=clock_timestamp()
    WHERE tenant_id=scope AND id=operation;
  INSERT INTO public.voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id)
    VALUES(gen_random_uuid(),scope,accepted.actor_user_id,accepted.user_id,NULL,'DISABLE_TENANT_USER',result_state,
      accepted.expected_revision+1,accepted.expected_revision+1+compensation::integer,ARRAY['accountState','identityOutcome'],
      coalesce(reason_value,'IDENTITY_OUTCOME_UNKNOWN'),operation::text);
  RETURN result_state;
END $$;

REVOKE ALL ON FUNCTION dc_people_disable_snapshot(uuid,uuid,text,text,text),dc_people_disable_closure(uuid,uuid),dc_people_disable_idle(uuid,uuid),
  dc_people_accept_disable(uuid,uuid),dc_people_claim_disable(uuid,uuid,uuid),dc_people_record_disable(uuid,uuid,uuid,bigint,text,uuid,text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_disable_snapshot(uuid,uuid,text,text,text),dc_people_disable_closure(uuid,uuid),dc_people_disable_idle(uuid,uuid),dc_people_accept_disable(uuid,uuid) TO dcontact_app;
GRANT EXECUTE ON FUNCTION dc_people_claim_disable(uuid,uuid,uuid),dc_people_record_disable(uuid,uuid,uuid,bigint,text,uuid,text,text,text) TO dcontact_tenant_people_worker;

CREATE FUNCTION dc_people_disable_flush_status(scope uuid,operation uuid)
RETURNS TABLE(work_session_lease_id uuid,extension text,sip_domain text,telephony_node_id text,confirmed boolean)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.dc_people_activation_authorize(scope);
  RETURN QUERY SELECT flush.work_session_lease_id,flush.extension,flush.sip_domain,flush.telephony_node_id,
    EXISTS(SELECT 1 FROM public.dl_voice_audit_events audit WHERE audit.tenant_id=scope
      AND audit.event_id='e1-sandbox:sip.registration.flush:'||flush.work_session_lease_id::text AND audit.code='E1_SANDBOX_REGISTRATION_FLUSHED')
    FROM public.tenant_people_disable_flushes flush WHERE flush.tenant_id=scope AND flush.operation_id=operation;
END $$;
REVOKE ALL ON FUNCTION dc_people_disable_flush_status(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_disable_flush_status(uuid,uuid) TO dcontact_tenant_people_worker;

CREATE FUNCTION dc_people_reserved_accounts(scope uuid,agents_only boolean DEFAULT false) RETURNS bigint
LANGUAGE sql STABLE SET search_path=pg_catalog,public AS $$
  SELECT count(*) FROM public.users u WHERE u.tenant_id=scope AND scope=nullif(current_setting('app.tenant_id',true),'')::uuid
    AND (NOT agents_only OR u.role='AGENT') AND NOT (NOT u.is_active AND (
      EXISTS(SELECT 1 FROM public.tenant_user_lifecycles l WHERE l.tenant_id=scope AND l.user_id=u.id AND l.account_state='DISABLED')
      OR EXISTS(SELECT 1 FROM public.tenant_people_disables d WHERE d.tenant_id=scope AND d.user_id=u.id AND d.state='SUCCEEDED')))
$$;
REVOKE ALL ON FUNCTION dc_people_reserved_accounts(uuid,boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_reserved_accounts(uuid,boolean) TO dcontact_app;

CREATE FUNCTION dc_people_disable_pending(scope uuid,queue_ids uuid[],user_ids uuid[]) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS(SELECT 1 FROM tenant_people_disables d WHERE d.tenant_id=scope
    AND d.state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED') AND (d.user_id=ANY(user_ids) OR d.affected_queues && queue_ids))
$$;
REVOKE ALL ON FUNCTION dc_people_disable_pending(uuid,uuid[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_people_disable_pending(uuid,uuid[],uuid[]) TO dcontact_app;

DO $$ DECLARE name text; original text; definition text; tid text; needle text; BEGIN
  FOREACH name IN ARRAY ARRAY['dc_voice_skill_assignment_guard','dc_voice_routing_update_guard'] LOOP
    SELECT pg_get_functiondef((name||'()')::regprocedure) INTO original;
    tid:=CASE WHEN name='dc_voice_skill_assignment_guard' THEN 'assignment.tenant_id' ELSE 'scope' END;
    needle:='IF dc_voice_managed_cleanup_pending('||tid||',affected_queues,affected_agents)';
    definition:=replace(original,needle,'IF dc_people_disable_pending('||tid||',affected_queues,affected_agents) OR dc_voice_managed_cleanup_pending('||tid||',affected_queues,affected_agents)');
    IF definition=original THEN RAISE EXCEPTION 'PEOPLE_DISABLE_GUARD_BASELINE_MISMATCH: %',name; END IF;
    EXECUTE definition;
  END LOOP;
END $$;
