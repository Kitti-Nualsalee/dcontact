-- สถานะก่อน material write ต้องเก็บจริง ไม่คำนวณ OLD ใหม่จาก canonical rows ที่เปลี่ยนไปแล้ว
CREATE TABLE public.dc_team_reference_checks (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  transaction_id bigint NOT NULL,
  tenant_id uuid NOT NULL,
  source_table text NOT NULL,
  key_columns text[] NOT NULL,
  source_key jsonb NOT NULL,
  previous_hint jsonb,
  following_hint jsonb,
  before_claims jsonb NOT NULL
);
REVOKE ALL ON public.dc_team_reference_checks FROM PUBLIC,dcontact_app;

CREATE FUNCTION dc_team_reference_dependents(p_table text,r jsonb,p_at timestamptz)
RETURNS TABLE(kind text,resource text,team_id uuid,reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope uuid; BEGIN
  IF r IS NULL THEN RETURN; END IF;scope:=(r->>'tenant_id')::uuid;
  IF p_table='jr_enrollments' THEN
    RETURN QUERY SELECT c.* FROM public.jr_schedule_occurrences s CROSS JOIN LATERAL public.dc_team_row_claims('jr_schedule_occurrences',to_jsonb(s),p_at) c
      WHERE s.tenant_id=scope AND s.id=(r->>'occurrence_id')::uuid;
    RETURN QUERY SELECT c.* FROM public.jr_segment_enrollment_intents i CROSS JOIN LATERAL public.dc_team_row_claims('jr_segment_enrollment_intents',to_jsonb(i),p_at) c
      WHERE i.tenant_id=scope AND i.id=(r->>'segment_intent_id')::uuid;
    RETURN QUERY SELECT c.* FROM public.jr_actions a CROSS JOIN LATERAL public.dc_team_row_claims('jr_actions',to_jsonb(a),p_at) c WHERE a.tenant_id=scope AND a.enrollment_id=(r->>'id')::uuid;
    RETURN QUERY SELECT c.* FROM public.jr_owner_actions a CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_actions',to_jsonb(a),p_at) c WHERE a.tenant_id=scope AND a.enrollment_id=(r->>'id')::uuid;
  ELSIF p_table='jr_journey_definitions' THEN
    RETURN QUERY SELECT c.* FROM public.jr_enrollments e CROSS JOIN LATERAL public.dc_team_row_claims('jr_enrollments',to_jsonb(e),p_at) c
      WHERE e.tenant_id=scope AND e.journey_id=(r->>'journey_id')::uuid AND e.journey_version=(r->>'version')::integer;
    RETURN QUERY SELECT c.* FROM public.jr_actions a JOIN public.jr_enrollments e ON e.tenant_id=a.tenant_id AND e.id=a.enrollment_id
      CROSS JOIN LATERAL public.dc_team_row_claims('jr_actions',to_jsonb(a),p_at) c WHERE a.tenant_id=scope AND e.journey_id=(r->>'journey_id')::uuid AND e.journey_version=(r->>'version')::integer;
    RETURN QUERY SELECT c.* FROM public.jr_owner_actions a CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_actions',to_jsonb(a),p_at) c
      WHERE a.tenant_id=scope AND (EXISTS(SELECT 1 FROM public.jr_enrollments e WHERE e.tenant_id=scope AND e.id=a.enrollment_id AND e.journey_id=(r->>'journey_id')::uuid AND e.journey_version=(r->>'version')::integer)
        OR EXISTS(SELECT 1 FROM public.jr_owner_command_outbox o WHERE o.tenant_id=scope AND o.action_id=a.id AND o.payload->>'journeyId'=r->>'journey_id' AND o.payload->'journeyVersion'=r->'version'));
    RETURN QUERY SELECT c.* FROM public.jr_owner_command_outbox o CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_command_outbox',to_jsonb(o),p_at) c
      WHERE o.tenant_id=scope AND o.payload->>'journeyId'=r->>'journey_id' AND o.payload->'journeyVersion'=r->'version';
    RETURN QUERY SELECT c.* FROM public.jr_schedule_occurrences o CROSS JOIN LATERAL public.dc_team_row_claims('jr_schedule_occurrences',to_jsonb(o),p_at) c WHERE o.tenant_id=scope AND o.journey_id=(r->>'journey_id')::uuid AND o.journey_version=(r->>'version')::integer;
    RETURN QUERY SELECT c.* FROM public.jr_segment_enrollment_intents i CROSS JOIN LATERAL public.dc_team_row_claims('jr_segment_enrollment_intents',to_jsonb(i),p_at) c WHERE i.tenant_id=scope AND i.journey_id=r->>'journey_id' AND i.journey_version=(r->>'version')::integer;
  ELSIF p_table IN ('ob_dialer_command_inbox','ob_campaign_targets','ob_callbacks') THEN
    RETURN QUERY SELECT c.* FROM public.jr_owner_actions a CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_actions',to_jsonb(a),p_at) c WHERE a.tenant_id=scope AND (
      (p_table='ob_dialer_command_inbox' AND a.action_key=r->>'action_key') OR EXISTS(SELECT 1 FROM public.ob_dialer_command_inbox i WHERE i.tenant_id=scope AND i.record_id=(r->>'id')::uuid AND i.action_key=a.action_key));
    RETURN QUERY SELECT c.* FROM public.jr_owner_command_outbox o CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_command_outbox',to_jsonb(o),p_at) c WHERE o.tenant_id=scope AND (
      (p_table='ob_dialer_command_inbox' AND o.command_id=r->>'command_id') OR EXISTS(SELECT 1 FROM public.ob_dialer_command_inbox i WHERE i.tenant_id=scope AND i.record_id=(r->>'id')::uuid AND i.command_id=o.command_id));
  ELSIF p_table='iam_authoring_delegation_revocations' THEN
    RETURN QUERY SELECT c.* FROM public.iam_authoring_delegations d CROSS JOIN LATERAL public.dc_team_row_claims('iam_authoring_delegations',to_jsonb(d),p_at) c WHERE d.tenant_id=scope AND d.id=(r->>'delegation_id')::uuid;
  ELSIF p_table IN ('jr_owner_continuations','jr_owner_command_outbox') THEN
    RETURN QUERY SELECT c.* FROM public.jr_owner_actions a CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_actions',to_jsonb(a),p_at) c WHERE a.tenant_id=scope AND a.id=(r->>'action_id')::uuid;
  ELSIF p_table='jr_owner_actions' THEN
    RETURN QUERY SELECT c.* FROM public.jr_owner_command_outbox o CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_command_outbox',to_jsonb(o),p_at) c WHERE o.tenant_id=scope AND o.action_id=(r->>'id')::uuid;
  ELSIF p_table IN ('tenant_people_operations','tenant_user_lifecycles','tenant_identity_reservations','tenant_people_invitation_intents') THEN
    RETURN QUERY SELECT * FROM public.dc_team_people_claims(scope,CASE WHEN p_table='tenant_people_operations' THEN (r->>'id')::uuid ELSE (r->>'operation_id')::uuid END);
  ELSIF p_table='cg_reservations' THEN
    RETURN QUERY SELECT c.* FROM public.jr_actions a CROSS JOIN LATERAL public.dc_team_row_claims('jr_actions',to_jsonb(a),p_at) c WHERE a.tenant_id=scope AND a.reservation_id=(r->>'id')::uuid;
  ELSIF p_table='jr_segment_heads' THEN
    RETURN QUERY SELECT c.* FROM public.jr_segment_enrollment_intents i CROSS JOIN LATERAL public.dc_team_row_claims('jr_segment_enrollment_intents',to_jsonb(i),p_at) c
      WHERE i.tenant_id=scope AND i.contact_id=(r->>'contact_id')::uuid AND i.segment_id=r->>'segment_id';
  END IF;
END $$;
REVOKE ALL ON FUNCTION dc_team_reference_dependents(text,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION dc_team_reference_hint(r jsonb) RETURNS jsonb LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT jsonb_object_agg(key,value) FROM jsonb_each(r) WHERE key=ANY(ARRAY['tenant_id','id','user_id','operation_id','target_user_id','delegation_id','action_id','action_key','command_id','enrollment_id','reservation_id','occurrence_id','segment_intent_id','journey_id','journey_version','version','contact_id','segment_id','entry_id','terminal_entry_id','is_active','lifecycle','expires_at'])
$$;
REVOKE ALL ON FUNCTION dc_team_reference_hint(jsonb) FROM PUBLIC;
CREATE FUNCTION dc_team_capture_reference_check(p_table text,p_previous jsonb,p_following jsonb,p_keys text[])
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope uuid; identity jsonb; before_values jsonb; BEGIN
  scope:=(coalesce(p_following,p_previous)->>'tenant_id')::uuid;
  SELECT jsonb_object_agg(key,value) INTO identity FROM jsonb_each(coalesce(p_following,p_previous)) WHERE key=ANY(p_keys);
  SELECT coalesce(jsonb_agg(to_jsonb(c)),'[]'::jsonb) INTO before_values FROM (
    SELECT * FROM public.dc_team_row_claims(p_table,p_previous,statement_timestamp())
    UNION SELECT * FROM public.dc_team_reference_dependents(p_table,p_previous,statement_timestamp())
    UNION SELECT * FROM public.dc_team_reference_dependents(p_table,p_following,statement_timestamp())
  ) c;
  INSERT INTO public.dc_team_reference_checks(transaction_id,tenant_id,source_table,key_columns,source_key,previous_hint,following_hint,before_claims)
    VALUES(txid_current(),scope,p_table,p_keys,identity,public.dc_team_reference_hint(p_previous),public.dc_team_reference_hint(p_following),before_values);
END $$;
REVOKE ALL ON FUNCTION dc_team_capture_reference_check(text,jsonb,jsonb,text[]) FROM PUBLIC;

-- การเปิดใช้งาน/ต่ออายุเป็น acquisition แม้ canonical UUID/reference set เดิมยังอยู่
CREATE FUNCTION dc_team_claim_renewed(p_table text,previous jsonb,following jsonb) RETURNS boolean
LANGUAGE plpgsql VOLATILE SET search_path=pg_catalog AS $$ BEGIN
  IF previous IS NULL OR following IS NULL THEN RETURN false; END IF;
  IF p_table IN ('users','queues') THEN RETURN coalesce(previous->>'is_active'='false' AND following->>'is_active'='true',false);
  ELSIF p_table IN ('jr_journey_heads','jr_template_heads') THEN RETURN coalesce(previous->>'lifecycle'<>'ACTIVE' AND following->>'lifecycle'='ACTIVE',false);
  ELSIF p_table='iam_authoring_capability_grants' AND previous->>'expires_at' IS NOT NULL THEN
    RETURN following->>'expires_at' IS NULL OR (following->>'expires_at')::timestamptz>(previous->>'expires_at')::timestamptz;
  END IF;
  RETURN false;
END $$;
REVOKE ALL ON FUNCTION dc_team_claim_renewed(text,jsonb,jsonb) FROM PUBLIC;
CREATE FUNCTION dc_team_reference_check_final() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE following jsonb; predicate text; claim record; force_active boolean; BEGIN
  IF NEW.transaction_id<>txid_current() THEN RAISE EXCEPTION 'TEAM_REFERENCE_TRANSACTION_MISMATCH' USING ERRCODE='23514'; END IF;
  SELECT string_agg(format('r.%I=k.%I',x,x),' AND ') INTO predicate FROM unnest(NEW.key_columns) x;
  EXECUTE format('SELECT to_jsonb(r) FROM public.%I r,jsonb_populate_record(NULL::public.%I,$2) k WHERE r.tenant_id=$1 AND %s',NEW.source_table,NEW.source_table,predicate)
    INTO following USING NEW.tenant_id,NEW.source_key;
  force_active:=public.dc_team_claim_renewed(NEW.source_table,NEW.previous_hint,following);
  FOR claim IN SELECT * FROM public.dc_team_row_claims(NEW.source_table,following,statement_timestamp())
    UNION SELECT * FROM public.dc_team_reference_dependents(NEW.source_table,NEW.previous_hint,statement_timestamp())
    UNION SELECT * FROM public.dc_team_reference_dependents(NEW.source_table,NEW.following_hint,statement_timestamp()) LOOP
    IF claim.reason IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(NEW.before_claims) b(kind text,resource text,team_id uuid,reason text)
        WHERE b.resource=claim.resource AND b.reason IS NOT NULL AND
        (b.kind=claim.kind OR (b.kind IN ('JOURNEY_OWNER_INTENT','JOURNEY_CONTINUATION') AND claim.kind IN ('JOURNEY_OWNER_INTENT','JOURNEY_CONTINUATION'))))
        AND EXISTS(SELECT 1 FROM public.teams WHERE tenant_id=NEW.tenant_id AND NOT is_active) THEN
        RAISE EXCEPTION 'TEAM_REFERENCE_UNRESOLVED' USING ERRCODE='23514'; END IF;
    ELSIF force_active OR NOT EXISTS(SELECT 1 FROM jsonb_to_recordset(NEW.before_claims) b(kind text,resource text,team_id uuid,reason text)
      WHERE b.resource=claim.resource AND b.team_id=claim.team_id AND b.reason IS NULL AND
      (b.kind=claim.kind OR (b.kind IN ('JOURNEY_OWNER_INTENT','JOURNEY_CONTINUATION') AND claim.kind IN ('JOURNEY_OWNER_INTENT','JOURNEY_CONTINUATION')))) THEN
      IF NOT EXISTS(SELECT 1 FROM public.teams WHERE tenant_id=NEW.tenant_id AND id=claim.team_id AND (is_active OR public.dc_team_provisioning_writer(NEW.tenant_id))) THEN
        RAISE EXCEPTION 'TEAM_INACTIVE' USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;
  DELETE FROM public.dc_team_reference_checks WHERE id=NEW.id AND transaction_id=txid_current();
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION dc_team_reference_check_final() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER team_reference_check_final AFTER INSERT ON public.dc_team_reference_checks
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_reference_check_final();

-- Candidate locks ไม่ใช่ blocker authority: ต้องประสานแม้ current predicate ถูก proof ที่กำลังลบกดไว้
CREATE FUNCTION dc_team_reference_candidates(p_table text,r jsonb)
RETURNS SETOF uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope uuid; BEGIN
  IF r IS NULL THEN RETURN; END IF;scope:=(r->>'tenant_id')::uuid;
  IF p_table='iam_authoring_delegation_revocations' THEN
    RETURN QUERY SELECT public.dc_team_canonical_uuid(d.scope_id) FROM public.iam_authoring_delegations d
      WHERE d.tenant_id=scope AND d.id=(r->>'delegation_id')::uuid AND d.scope_kind='TEAM';
  ELSIF p_table='jr_owner_continuations' THEN
    RETURN QUERY SELECT c.team_id FROM public.jr_owner_actions a
      CROSS JOIN LATERAL public.dc_team_owner_claims(scope,to_jsonb(a),NULL,'JOURNEY_CONTINUATION',a.id::text) c
      WHERE a.tenant_id=scope AND a.id=(r->>'action_id')::uuid;
  ELSIF p_table='jr_segment_heads' THEN
    RETURN QUERY SELECT public.dc_team_pinned_team(scope,i.journey_id,i.journey_version)
      FROM public.jr_segment_enrollment_intents i WHERE i.tenant_id=scope AND i.contact_id=(r->>'contact_id')::uuid AND i.segment_id=r->>'segment_id';
  ELSIF p_table='jr_enrollments' THEN
    RETURN NEXT public.dc_team_pinned_team(scope,r->>'journey_id',(r->>'journey_version')::integer);
    RETURN QUERY SELECT public.dc_team_pinned_team(scope,o.journey_id::text,o.journey_version)
      FROM public.jr_schedule_occurrences o WHERE o.tenant_id=scope AND o.id=(r->>'occurrence_id')::uuid;
    RETURN QUERY SELECT public.dc_team_pinned_team(scope,i.journey_id,i.journey_version)
      FROM public.jr_segment_enrollment_intents i WHERE i.tenant_id=scope AND i.id=(r->>'segment_intent_id')::uuid;
  END IF;
END $$;
REVOKE ALL ON FUNCTION dc_team_reference_candidates(text,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION dc_team_reference_writer() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous jsonb; following jsonb; scope uuid; old_teams uuid[]; new_teams uuid[]; affected uuid[]; team uuid; active boolean; BEGIN
  IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN following:=to_jsonb(NEW); END IF;
  scope:=coalesce(following->>'tenant_id',previous->>'tenant_id')::uuid;
  IF TG_OP='UPDATE' AND following->>'tenant_id' IS DISTINCT FROM previous->>'tenant_id' THEN
    RAISE EXCEPTION 'TEAM_REFERENCE_TENANT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  -- tenant lock มาก่อน canonical lookup; VOLATILE helper ใช้ fresh statement snapshot
  PERFORM public.dc_team_reference_lock(scope,ARRAY[]::uuid[],false);
  SELECT array_agg(DISTINCT team_id) INTO old_teams FROM public.dc_team_row_claims(TG_TABLE_NAME,previous,statement_timestamp()) WHERE team_id IS NOT NULL;
  SELECT array_agg(DISTINCT team_id) INTO new_teams FROM public.dc_team_row_claims(TG_TABLE_NAME,following,statement_timestamp()) WHERE team_id IS NOT NULL;
  SELECT array_agg(DISTINCT team_id) INTO affected FROM (
    SELECT unnest(old_teams) AS team_id
    UNION SELECT unnest(new_teams)
    UNION SELECT public.dc_team_canonical_uuid(value#>>'{}') FROM jsonb_each(coalesce(previous,'{}'::jsonb)) WHERE key IN ('team_id','owner_team_id','scope_team_id','source_owner_team_id','target_owner_team_id','creation_team_id')
    UNION SELECT public.dc_team_canonical_uuid(value#>>'{}') FROM jsonb_each(coalesce(following,'{}'::jsonb)) WHERE key IN ('team_id','owner_team_id','scope_team_id','source_owner_team_id','target_owner_team_id','creation_team_id')
    UNION SELECT team_id FROM public.dc_team_reference_dependents(TG_TABLE_NAME,previous,statement_timestamp())
    UNION SELECT team_id FROM public.dc_team_reference_dependents(TG_TABLE_NAME,following,statement_timestamp())
    UNION SELECT * FROM public.dc_team_reference_candidates(TG_TABLE_NAME,previous)
    UNION SELECT * FROM public.dc_team_reference_candidates(TG_TABLE_NAME,following)
  ) c WHERE team_id IS NOT NULL;
  PERFORM public.dc_team_reference_lock(scope,affected,false);
  PERFORM public.dc_team_capture_reference_check(TG_TABLE_NAME,previous,following,string_to_array(coalesce(TG_ARGV[0],'id'),','));
  IF TG_TABLE_NAME IN ('iam_authoring_delegation_revocations','jr_owner_continuations') AND TG_OP='INSERT' THEN old_teams:=new_teams; END IF;
  FOR team IN SELECT x FROM unnest(new_teams) x WHERE NOT(x=ANY(coalesce(old_teams,ARRAY[]::uuid[]))) LOOP
    SELECT is_active INTO active FROM public.teams WHERE tenant_id=scope AND id=team;
    IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_INACTIVE' USING ERRCODE='23514'; END IF;
    IF NOT active AND NOT public.dc_team_provisioning_writer(scope) THEN RAISE EXCEPTION 'TEAM_INACTIVE' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dc_team_reference_writer() FROM PUBLIC;
