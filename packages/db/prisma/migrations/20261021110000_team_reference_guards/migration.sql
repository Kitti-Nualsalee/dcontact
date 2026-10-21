-- Core Settings §7: transaction fences อยู่ฐานข้อมูลเพื่อครอบ logical refs/legacy writers
-- Platform bootstrap เดิมเป็น authority แยก: drafts ใน PROVISIONING ไม่ใช่ Core deactivate ของ ACTIVE tenant
CREATE FUNCTION dc_team_reference_lock(p_tenant uuid,p_teams uuid[],p_exclusive boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE team uuid; acquired boolean; provisioning boolean; BEGIN
  provisioning:=public.dc_team_provisioning_writer(p_tenant);
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)
    AND p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid AND NOT provisioning THEN
    RAISE EXCEPTION 'TEAM_TENANT_CONTEXT_REQUIRED' USING ERRCODE='42501'; END IF;
  IF p_exclusive THEN acquired:=pg_try_advisory_xact_lock(hashtextextended('team-reference-tenant:'||p_tenant::text,0));
  ELSE acquired:=pg_try_advisory_xact_lock_shared(hashtextextended('team-reference-tenant:'||p_tenant::text,0)); END IF;
  IF NOT acquired THEN RAISE EXCEPTION 'TEAM_REFERENCE_BUSY' USING ERRCODE='55P03'; END IF;
  FOR team IN SELECT DISTINCT x FROM unnest(p_teams) x WHERE x IS NOT NULL ORDER BY x LOOP
    IF p_exclusive THEN acquired:=pg_try_advisory_xact_lock(hashtextextended('team-reference:'||p_tenant::text||':'||team::text,0));
    ELSE acquired:=pg_try_advisory_xact_lock_shared(hashtextextended('team-reference:'||p_tenant::text||':'||team::text,0)); END IF;
    IF NOT acquired THEN RAISE EXCEPTION 'TEAM_REFERENCE_BUSY' USING ERRCODE='55P03'; END IF;
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION dc_team_reference_lock(uuid,uuid[],boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_team_reference_lock(uuid,uuid[],boolean) TO dcontact_app;

CREATE FUNCTION dc_team_canonical_uuid(value text) RETURNS uuid LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN value ~ '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' THEN value::uuid END
$$;
REVOKE ALL ON FUNCTION dc_team_canonical_uuid(text) FROM PUBLIC;
CREATE FUNCTION dc_team_pinned_team(p_tenant uuid,p_journey text,p_version integer) RETURNS uuid
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE team uuid; BEGIN
  SELECT owner_team_id INTO team FROM public.jr_journey_definitions WHERE tenant_id=p_tenant
    AND journey_id=public.dc_team_canonical_uuid(p_journey) AND version=p_version AND status='PUBLISHED';
  RETURN team;
END $$;
REVOKE ALL ON FUNCTION dc_team_pinned_team(uuid,text,integer) FROM PUBLIC;
-- Parser เฉพาะ J2 contractVersion=1 ตาม packages/cxa-contracts/src/interaction-result.ts
CREATE FUNCTION dc_j2_exact_keys(v jsonb,required text[],optional text[] DEFAULT ARRAY[]::text[]) RETURNS boolean
LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(v)='object' THEN v ?& required AND NOT EXISTS(SELECT 1 FROM jsonb_object_keys(v) k WHERE NOT(k=ANY(required||optional))) ELSE false END
$$;
CREATE FUNCTION dc_j2_reference(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT coalesce(jsonb_typeof(v)='string' AND (v#>>'{}') ~ '^[A-Za-z0-9][A-Za-z0-9:._-]{0,159}$'
    AND regexp_replace(v#>>'{}','[().\s-]','','g') !~ '^[0-9]{7,}$',false)
$$;
CREATE FUNCTION dc_j2_version(v jsonb,p_min integer DEFAULT 1) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT CASE WHEN jsonb_typeof(v)='number' THEN (v#>>'{}')::numeric>=p_min AND mod((v#>>'{}')::numeric,1)=0 ELSE false END
$$;
CREATE FUNCTION dc_j2_outcome(v jsonb) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
  SELECT public.dc_j2_exact_keys(v,ARRAY['outcomeType','outcomeId','outcomeVersion'])
    AND v->>'outcomeType' IN ('INTERACTION_ABANDONED','INTERACTION_DISPOSITION_RECORDED','FEEDBACK_DETRACTOR_RECORDED')
    AND public.dc_j2_reference(v->'outcomeId') AND public.dc_j2_version(v->'outcomeVersion')
$$;
CREATE FUNCTION dc_j2_owner_payload_v1(p jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE field text; intent jsonb; command text; BEGIN
  IF NOT public.dc_j2_exact_keys(p,ARRAY['contractVersion','commandId','actionKey','requestHash','journeyId','journeyVersion','enrollmentId','stepId','sourceOutcome','interactionId','contactId','sourceOwnerTeamId','targetOwnerTeamId','commandType','intent'],ARRAY['expectedOwnerVersion'])
    OR p->'contractVersion' IS DISTINCT FROM '1'::jsonb THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['commandId','actionKey','journeyId','enrollmentId','stepId','interactionId','contactId','sourceOwnerTeamId','targetOwnerTeamId'] LOOP
    IF NOT public.dc_j2_reference(p->field) THEN RETURN false; END IF;
  END LOOP;
  IF jsonb_typeof(p->'requestHash')<>'string' OR p->>'requestHash' !~ '^[a-f0-9]{64}$'
    OR NOT public.dc_j2_version(p->'journeyVersion') OR (p->>'journeyVersion')::numeric>2147483647 OR NOT public.dc_j2_outcome(p->'sourceOutcome')
    OR (p?'expectedOwnerVersion' AND NOT public.dc_j2_version(p->'expectedOwnerVersion',0)) THEN RETURN false; END IF;
  intent:=p->'intent';command:=p->>'commandType';
  CASE command
    WHEN 'ENSURE_CASE' THEN RETURN public.dc_j2_exact_keys(intent,ARRAY['caseTypePolicyRef','routingPolicyRef']) AND public.dc_j2_reference(intent->'caseTypePolicyRef') AND public.dc_j2_reference(intent->'routingPolicyRef');
    WHEN 'ADMIT_CAMPAIGN_TARGET' THEN RETURN public.dc_j2_exact_keys(intent,ARRAY['campaignId']) AND public.dc_j2_reference(intent->'campaignId');
    WHEN 'SCHEDULE_CALLBACK' THEN
      IF NOT public.dc_j2_exact_keys(intent,ARRAY['requestedFor','queueId'],ARRAY['agentId']) OR NOT public.dc_j2_reference(intent->'queueId')
        OR (intent?'agentId' AND NOT public.dc_j2_reference(intent->'agentId')) OR jsonb_typeof(intent->'requestedFor')<>'string' THEN RETURN false; END IF;
      PERFORM (intent->>'requestedFor')::timestamptz; RETURN true;
    WHEN 'CANCEL_CAMPAIGN_TARGET','CANCEL_CALLBACK' THEN
      IF NOT public.dc_j2_exact_keys(intent,ARRAY['originalActionKey','reasonCode']) THEN RETURN false; END IF;
    WHEN 'SUPERSEDE_CAMPAIGN_TARGET','SUPERSEDE_CALLBACK' THEN
      IF NOT public.dc_j2_exact_keys(intent,ARRAY['originalActionKey','reasonCode','supersedingOutcome']) OR NOT public.dc_j2_outcome(intent->'supersedingOutcome') THEN RETURN false; END IF;
    ELSE RETURN false;
  END CASE;
  RETURN public.dc_j2_reference(intent->'originalActionKey') AND intent->>'originalActionKey'=p->>'actionKey'
    AND jsonb_typeof(intent->'reasonCode')='string' AND intent->>'reasonCode' ~ '^[A-Z][A-Z0-9_]{0,63}$';
EXCEPTION WHEN invalid_text_representation OR datetime_field_overflow OR invalid_datetime_format OR numeric_value_out_of_range THEN RETURN false;
END $$;
REVOKE ALL ON FUNCTION dc_j2_exact_keys(jsonb,text[],text[]),dc_j2_reference(jsonb),dc_j2_version(jsonb,integer),dc_j2_outcome(jsonb),dc_j2_owner_payload_v1(jsonb) FROM PUBLIC;

CREATE FUNCTION dc_team_owner_claims(p_tenant uuid,p_action jsonb,p_command jsonb,p_kind text,p_resource text)
RETURNS TABLE(kind text,resource text,team_id uuid,reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE cmd jsonb; payload jsonb; enrollment jsonb; pinned uuid; payload_pinned uuid; source_team uuid; target_team uuid;
  teams uuid[]:=ARRAY[]::uuid[]; valid boolean; seen boolean:=false; unresolved boolean:=false; canonical uuid[]; legacy_binding uuid[]; canonical_seen boolean:=false;
BEGIN
  IF p_action IS NOT NULL THEN
    SELECT to_jsonb(e) INTO enrollment FROM public.jr_enrollments e WHERE e.tenant_id=p_tenant AND e.id=(p_action->>'enrollment_id')::uuid;
    IF enrollment IS NOT NULL THEN pinned:=public.dc_team_pinned_team(p_tenant,enrollment->>'journey_id',(enrollment->>'journey_version')::integer); END IF;
    IF pinned IS NOT NULL THEN teams:=array_append(teams,pinned); END IF;
  END IF;
  FOR cmd IN SELECT p_command WHERE p_command IS NOT NULL
    UNION ALL SELECT to_jsonb(c) FROM public.jr_owner_command_outbox c WHERE c.tenant_id=p_tenant AND c.action_id=(p_action->>'id')::uuid AND c.state::text<>'CANCELLED' AND (p_command IS NULL OR c.command_id<>p_command->>'command_id') LOOP
    seen:=true;payload:=cmd->'payload';canonical:=NULL;valid:=coalesce(public.dc_j2_owner_payload_v1(payload),false);
    IF valid THEN
      IF enrollment IS NULL THEN SELECT to_jsonb(e) INTO enrollment FROM public.jr_enrollments e WHERE e.tenant_id=p_tenant AND e.id=public.dc_team_canonical_uuid(payload->>'enrollmentId'); END IF;
      payload_pinned:=public.dc_team_pinned_team(p_tenant,payload->>'journeyId',(payload->>'journeyVersion')::numeric::integer);
      source_team:=public.dc_team_canonical_uuid(payload->>'sourceOwnerTeamId');target_team:=public.dc_team_canonical_uuid(payload->>'targetOwnerTeamId');
      valid:=payload->>'commandId'=cmd->>'command_id' AND payload->>'actionKey'=cmd->>'action_key' AND payload->>'requestHash'=cmd->>'request_hash'
        AND source_team IS NOT NULL AND target_team IS NOT NULL AND source_team=payload_pinned AND enrollment IS NOT NULL
        AND enrollment->>'id'=payload->>'enrollmentId' AND (enrollment->>'journey_version')::integer=(payload->>'journeyVersion')::numeric
        AND (enrollment->>'journey_id' IS NULL OR enrollment->>'journey_id'=payload->>'journeyId')
        AND (p_action IS NULL OR (p_action->>'enrollment_id'=payload->>'enrollmentId' AND p_action->>'action_key'=cmd->>'action_key' AND p_action->>'kind'=cmd->>'kind'
          AND (p_action->>'step_id' IS NULL OR p_action->>'step_id'=payload->>'stepId')
          AND (payload->>'commandType' NOT IN ('ENSURE_CASE','ADMIT_CAMPAIGN_TARGET','SCHEDULE_CALLBACK') OR p_action->>'request_hash'=cmd->>'request_hash')))
        AND CASE cmd->>'kind' WHEN 'ENSURE_CASE' THEN payload->>'commandType'='ENSURE_CASE'
          WHEN 'ADMIT_CAMPAIGN_TARGET' THEN payload->>'commandType' IN ('ADMIT_CAMPAIGN_TARGET','CANCEL_CAMPAIGN_TARGET','SUPERSEDE_CAMPAIGN_TARGET')
          WHEN 'SCHEDULE_CALLBACK' THEN payload->>'commandType' IN ('SCHEDULE_CALLBACK','CANCEL_CALLBACK','SUPERSEDE_CALLBACK') ELSE false END;
      IF valid THEN
        IF legacy_binding IS NOT NULL AND legacy_binding IS DISTINCT FROM ARRAY[source_team,target_team] THEN unresolved:=true; END IF;
        legacy_binding:=ARRAY[source_team,target_team];teams:=teams||legacy_binding;
      END IF;
    END IF;
    IF NOT coalesce(valid,false) AND (payload IS NULL OR jsonb_typeof(payload)='null') THEN
      -- legacy: ใช้ owner receipt ที่ผูก command/action/hash จริงและ canonical record เท่านั้น
      SELECT ARRAY[t.source_owner_team_id,t.target_owner_team_id] INTO canonical
        FROM public.ob_dialer_command_inbox i JOIN public.ob_campaign_targets t ON t.tenant_id=i.tenant_id AND t.id=i.record_id
        WHERE i.tenant_id=p_tenant AND i.command_id=cmd->>'command_id' AND i.action_key=cmd->>'action_key' AND i.request_hash=cmd->>'request_hash' AND cmd->>'kind'='ADMIT_CAMPAIGN_TARGET' AND i.command_type IN ('ADMIT_CAMPAIGN_TARGET','CANCEL_CAMPAIGN_TARGET','SUPERSEDE_CAMPAIGN_TARGET') AND i.record_version>0 AND i.record_version<=t.version;
      IF canonical IS NULL THEN
        SELECT ARRAY[t.source_owner_team_id,t.target_owner_team_id] INTO canonical
          FROM public.ob_dialer_command_inbox i JOIN public.ob_callbacks t ON t.tenant_id=i.tenant_id AND t.id=i.record_id
          WHERE i.tenant_id=p_tenant AND i.command_id=cmd->>'command_id' AND i.action_key=cmd->>'action_key' AND i.request_hash=cmd->>'request_hash' AND cmd->>'kind'='SCHEDULE_CALLBACK' AND i.command_type IN ('SCHEDULE_CALLBACK','CANCEL_CALLBACK','SUPERSEDE_CALLBACK') AND i.record_version>0 AND i.record_version<=t.version;
      END IF;
      IF canonical IS NOT NULL AND pinned IS NOT NULL AND pinned=canonical[1] THEN
        IF legacy_binding IS NOT NULL AND legacy_binding IS DISTINCT FROM canonical THEN unresolved:=true; END IF;
        legacy_binding:=canonical;teams:=teams||canonical;
      ELSE unresolved:=true; END IF;
    ELSIF NOT coalesce(valid,false) THEN unresolved:=true;
    END IF;
  END LOOP;
  IF NOT seen THEN
    -- outbox เดิมอาจถูก purge แล้ว แต่ positive owner receipt + pinned enrollment ยังเป็น canonical binding ได้
    FOR canonical IN
      SELECT ARRAY[t.source_owner_team_id,t.target_owner_team_id] FROM public.ob_dialer_command_inbox i JOIN public.ob_campaign_targets t ON t.tenant_id=i.tenant_id AND t.id=i.record_id
        WHERE i.tenant_id=p_tenant AND i.action_key=p_action->>'action_key' AND i.request_hash=p_action->>'request_hash' AND p_action->>'kind'='ADMIT_CAMPAIGN_TARGET'
          AND i.command_type='ADMIT_CAMPAIGN_TARGET' AND i.record_version>0 AND i.record_version<=t.version
      UNION ALL SELECT ARRAY[t.source_owner_team_id,t.target_owner_team_id] FROM public.ob_dialer_command_inbox i JOIN public.ob_callbacks t ON t.tenant_id=i.tenant_id AND t.id=i.record_id
        WHERE i.tenant_id=p_tenant AND i.action_key=p_action->>'action_key' AND i.request_hash=p_action->>'request_hash' AND p_action->>'kind'='SCHEDULE_CALLBACK'
          AND i.command_type='SCHEDULE_CALLBACK' AND i.record_version>0 AND i.record_version<=t.version LOOP
      canonical_seen:=true;
      IF pinned IS NULL OR pinned IS DISTINCT FROM canonical[1] OR (legacy_binding IS NOT NULL AND legacy_binding IS DISTINCT FROM canonical) THEN unresolved:=true;
      ELSE teams:=teams||canonical;legacy_binding:=canonical; END IF;
    END LOOP;
    IF NOT canonical_seen THEN unresolved:=true; END IF;
  END IF;
  RETURN QUERY SELECT p_kind,p_resource,x,NULL::text FROM (SELECT DISTINCT unnest(teams) x) v;
  IF unresolved THEN RETURN QUERY SELECT p_kind,p_resource,NULL::uuid,'OWNER_BINDING_MISSING_OR_CONFLICTING'::text; END IF;
END $$;
REVOKE ALL ON FUNCTION dc_team_owner_claims(uuid,jsonb,jsonb,text,text) FROM PUBLIC;

CREATE FUNCTION dc_team_send_claims(p_tenant uuid,r jsonb) RETURNS TABLE(kind text,resource text,team_id uuid,reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE pinned uuid; reserved uuid; reservation_exists boolean; BEGIN
  SELECT public.dc_team_pinned_team(p_tenant,e.journey_id::text,e.journey_version) INTO pinned FROM public.jr_enrollments e WHERE e.tenant_id=p_tenant AND e.id=(r->>'enrollment_id')::uuid;
  SELECT true,c.team_id INTO reservation_exists,reserved FROM public.cg_reservations c WHERE c.tenant_id=p_tenant AND c.id=(r->>'reservation_id')::uuid;
  IF pinned IS NOT NULL THEN RETURN QUERY SELECT 'JOURNEY_SEND'::text,r->>'id',pinned,NULL::text; END IF;
  IF reserved IS NOT NULL AND reserved IS DISTINCT FROM pinned THEN RETURN QUERY SELECT 'JOURNEY_SEND'::text,r->>'id',reserved,NULL::text; END IF;
  IF pinned IS NULL OR reservation_exists IS NOT TRUE OR (reserved IS NOT NULL AND reserved IS DISTINCT FROM pinned) THEN
    RETURN QUERY SELECT 'JOURNEY_SEND'::text,r->>'id',NULL::uuid,'SEND_BINDING_MISSING_OR_CONFLICTING'::text; END IF;
END $$;
REVOKE ALL ON FUNCTION dc_team_send_claims(uuid,jsonb) FROM PUBLIC;
-- Aggregate ของ People ที่มีจริงใน B2; reservation/invitation intent ไม่สร้าง current owner แยกจาก operation/lifecycle
CREATE FUNCTION dc_team_people_claims(p_tenant uuid,p_operation uuid,p_op jsonb DEFAULT NULL,p_lifecycle jsonb DEFAULT NULL)
RETURNS TABLE(kind text,resource text,team_id uuid,reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE op jsonb; life jsonb; request_team uuid; creation_team uuid; team uuid; pending boolean; BEGIN
  IF p_op IS NOT NULL THEN op:=p_op; ELSE SELECT to_jsonb(o) INTO op FROM public.tenant_people_operations o WHERE o.tenant_id=p_tenant AND o.id=p_operation; END IF;
  IF p_lifecycle IS NOT NULL THEN life:=p_lifecycle; ELSE SELECT to_jsonb(l) INTO life FROM public.tenant_user_lifecycles l WHERE l.tenant_id=p_tenant AND l.operation_id=p_operation; END IF;
  pending:=coalesce(op->>'state' IN ('QUEUED','RUNNING','WAITING_EXTERNAL','ACTION_REQUIRED'),false)
    OR coalesce(life->>'provisioning_state' IN ('PENDING','UNKNOWN'),false)
    OR coalesce(life->>'provisioning_state'<>'REJECTED' AND life->>'account_state' IN ('PROVISIONING','PENDING_ACTIVATION','DISABLING','ATTENTION_REQUIRED'),false)
    OR coalesce(life->>'provisioning_state'='PROVISIONED' AND life->>'account_state'<>'DISABLED' AND life->>'activation_state' IN ('PENDING','UNKNOWN'),false);
  IF NOT pending THEN RETURN; END IF;
  request_team:=public.dc_team_canonical_uuid(op->'request_payload'->>'teamId');creation_team:=public.dc_team_canonical_uuid(life->>'creation_team_id');
  team:=coalesce(creation_team,request_team);
  IF op IS NULL OR team IS NULL OR (request_team IS NOT NULL AND creation_team IS NOT NULL AND request_team<>creation_team)
    OR (life IS NOT NULL AND life->>'user_id' IS DISTINCT FROM op->>'target_user_id') THEN
    RETURN QUERY SELECT 'PEOPLE_PENDING'::text,p_operation::text,NULL::uuid,'PEOPLE_CREATION_BINDING_MISSING_OR_CONFLICTING'::text;
  ELSE RETURN QUERY SELECT 'PEOPLE_PENDING'::text,p_operation::text,team,NULL::text; END IF;
END $$;
REVOKE ALL ON FUNCTION dc_team_people_claims(uuid,uuid,jsonb,jsonb) FROM PUBLIC;

CREATE FUNCTION dc_team_row_claims(p_table text,r jsonb,p_at timestamptz)
RETURNS TABLE(kind text,resource text,team_id uuid,reason text)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope uuid; team uuid; claim_kind text; BEGIN
  IF r IS NULL THEN RETURN; END IF;
  scope:=(r->>'tenant_id')::uuid;
  IF p_table IN ('users','queues','skills') AND r->>'team_id' IS NOT NULL THEN
    RETURN QUERY SELECT CASE p_table WHEN 'users' THEN 'USER_REFERENCE' WHEN 'queues' THEN 'QUEUE_REFERENCE' ELSE 'SKILL_REFERENCE' END,r->>'id',(r->>'team_id')::uuid,NULL::text;
  END IF;
  IF p_table='iam_team_segment_scope_active_grants' THEN
    RETURN QUERY SELECT 'TEAM_SCOPE_GRANT'::text,r->>'grant_id',(r->>'team_id')::uuid,NULL::text;
  ELSIF p_table IN ('iam_authoring_capability_grants','iam_authoring_delegations') AND r->>'scope_kind'='TEAM'
    AND ((r->>'expires_at')::timestamptz IS NULL OR (r->>'expires_at')::timestamptz>p_at) THEN
    IF p_table='iam_authoring_delegations' AND EXISTS(SELECT 1 FROM public.iam_authoring_delegation_revocations v WHERE v.tenant_id=scope AND v.delegation_id=(r->>'id')::uuid) THEN RETURN; END IF;
    claim_kind:=CASE p_table WHEN 'iam_authoring_delegations' THEN 'AUTHORING_DELEGATION' ELSE 'AUTHORING_GRANT' END;
    team:=public.dc_team_canonical_uuid(r->>'scope_id');
    RETURN QUERY SELECT claim_kind,r->>'id',team,CASE WHEN team IS NULL THEN 'NON_CANONICAL_TEAM_SCOPE'::text END;
  ELSIF p_table='cg_reservations' AND r->>'state' IN ('RESERVED','CONFIRMED') AND r->>'terminal_outcome' IS NULL
    AND r->>'settlement_status' IS DISTINCT FROM 'SETTLED' AND r->>'team_id' IS NOT NULL THEN
    RETURN QUERY SELECT 'CG_RESERVATION'::text,r->>'id',(r->>'team_id')::uuid,NULL::text;
  ELSIF p_table='cg5_alert_state' AND r->>'state' IN ('OPEN','ACKED') AND r->>'team_id' IS NOT NULL THEN
    RETURN QUERY SELECT 'CG_ALERT'::text,r->>'id',(r->>'team_id')::uuid,NULL::text;
  ELSIF p_table IN ('ob_campaign_targets','ob_callbacks') AND r->>'state' NOT IN ('CONSUMED','CANCELLED','SUPERSEDED') THEN
    claim_kind:=CASE p_table WHEN 'ob_callbacks' THEN 'CALLBACK' ELSE 'CAMPAIGN_TARGET' END;
    RETURN QUERY SELECT claim_kind,r->>'id',x,NULL::text FROM (SELECT DISTINCT unnest(ARRAY[(r->>'source_owner_team_id')::uuid,(r->>'target_owner_team_id')::uuid]) x) v;
  ELSIF p_table='jr_journey_heads' AND r->>'lifecycle' IN ('DRAFT_ONLY','ACTIVE','PAUSED') THEN
    RETURN QUERY SELECT 'JOURNEY_OWNERSHIP'::text,r->>'journey_id',(r->>'owner_team_id')::uuid,NULL::text;
  ELSIF p_table='jr_template_heads' AND r->>'lifecycle' IN ('DRAFT_ONLY','ACTIVE') THEN
    RETURN QUERY SELECT 'TEMPLATE_OWNERSHIP'::text,r->>'template_id',(r->>'owner_team_id')::uuid,NULL::text;
  ELSIF p_table='jr_owner_actions' THEN
    IF r->>'state' IN ('PENDING','DISPATCHED','ACK_UNKNOWN','CANCEL_REQUESTED','RECONCILING') THEN claim_kind:='JOURNEY_OWNER_INTENT';
    ELSIF r->>'state' IN ('ACKNOWLEDGED','REJECTED') AND r->>'step_id' IS NOT NULL AND r->>'step_sequence' IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM public.jr_owner_continuations c WHERE c.tenant_id=scope AND c.action_id=(r->>'id')::uuid) THEN claim_kind:='JOURNEY_CONTINUATION';
    END IF;
    IF claim_kind IS NOT NULL THEN RETURN QUERY SELECT * FROM public.dc_team_owner_claims(scope,r,NULL,claim_kind,r->>'id'); END IF;
  ELSIF p_table='jr_owner_command_outbox' AND (r->>'state' IN ('PENDING','PROCESSING') OR (r->>'state' IN ('SENT','FAILED') AND EXISTS(
      SELECT 1 FROM public.jr_owner_actions a WHERE a.tenant_id=scope AND a.id=(r->>'action_id')::uuid AND a.state::text IN ('PENDING','DISPATCHED','ACK_UNKNOWN','CANCEL_REQUESTED','RECONCILING')))) THEN
    RETURN QUERY SELECT c.* FROM public.dc_team_owner_claims(scope,(SELECT to_jsonb(a) FROM public.jr_owner_actions a WHERE a.tenant_id=scope AND a.id=(r->>'action_id')::uuid),r,'JOURNEY_OWNER_INTENT',r->>'action_id') c;
  ELSIF p_table='jr_owner_continuations' THEN
    RETURN QUERY SELECT c.* FROM public.jr_owner_actions a CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_actions',to_jsonb(a),p_at) c WHERE a.tenant_id=scope AND a.id=(r->>'action_id')::uuid;
  ELSIF p_table='tenant_people_operations' THEN
    RETURN QUERY SELECT * FROM public.dc_team_people_claims(scope,(r->>'id')::uuid,r,NULL);
  ELSIF p_table='tenant_user_lifecycles' THEN
    RETURN QUERY SELECT * FROM public.dc_team_people_claims(scope,(r->>'operation_id')::uuid,NULL,r);
  ELSIF p_table='jr_actions' AND r->>'realtime_state' NOT IN ('CANCELLED','SETTLED') THEN
    RETURN QUERY SELECT * FROM public.dc_team_send_claims(scope,r);
  ELSIF p_table='jr_segment_refilter_cursors' AND r->>'state' NOT IN ('NO_OP','CANCELLED') AND r->>'scope_team_id' IS NOT NULL THEN
    RETURN QUERY SELECT 'SEGMENT_REFILTER'::text,r->>'id',(r->>'scope_team_id')::uuid,NULL::text;
  ELSIF p_table='jr_segment_enrollment_intents'
    AND NOT EXISTS(SELECT 1 FROM public.jr_enrollments e WHERE e.tenant_id=scope AND e.segment_intent_id=(r->>'id')::uuid)
    AND NOT EXISTS(SELECT 1 FROM public.jr_segment_heads h WHERE h.tenant_id=scope AND h.contact_id=(r->>'contact_id')::uuid AND h.segment_id=r->>'segment_id' AND h.terminal_entry_id=r->>'entry_id') THEN
    team:=public.dc_team_pinned_team(scope,r->>'journey_id',(r->>'journey_version')::integer);
    RETURN QUERY SELECT 'JOURNEY_ENROLLMENT'::text,'intent:'||(r->>'id'),team,CASE WHEN team IS NULL THEN 'PINNED_DEFINITION_MISSING'::text END;
  ELSIF p_table='jr_schedule_occurrences' AND r->>'state'='CLAIMED' AND NOT EXISTS(SELECT 1 FROM public.jr_enrollments e WHERE e.tenant_id=scope AND e.occurrence_id=(r->>'id')::uuid) THEN
    team:=public.dc_team_pinned_team(scope,r->>'journey_id',(r->>'journey_version')::integer);
    RETURN QUERY SELECT 'JOURNEY_SCHEDULE'::text,r->>'id',team,CASE WHEN team IS NULL THEN 'PINNED_DEFINITION_MISSING'::text END;
  ELSIF p_table='jr_enrollments' AND r->>'run_state'<>'TERMINAL' THEN
    team:=public.dc_team_pinned_team(scope,r->>'journey_id',(r->>'journey_version')::integer);
    RETURN QUERY SELECT 'JOURNEY_ENROLLMENT'::text,r->>'id',team,CASE WHEN team IS NULL THEN 'PINNED_DEFINITION_MISSING'::text END;
  ELSIF p_table='iam_authoring_delegation_revocations' THEN
    -- insert เพิกถอนลด claim; ใช้ parent เพียงเพื่อ coordination ก่อน material write
    RETURN QUERY SELECT c.* FROM public.iam_authoring_delegations d CROSS JOIN LATERAL public.dc_team_row_claims('iam_authoring_delegations',to_jsonb(d),p_at) c WHERE d.tenant_id=scope AND d.id=(r->>'delegation_id')::uuid;
  END IF;

END $$;
REVOKE ALL ON FUNCTION dc_team_row_claims(text,jsonb,timestamptz) FROM PUBLIC;

CREATE FUNCTION dc_team_current_references(p_tenant uuid,p_at timestamptz)
RETURNS TABLE(kind text,resource text,team_id uuid,reason text)
LANGUAGE sql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
  SELECT 'USER_REFERENCE'::text,u.id::text,u.team_id,NULL::text FROM public.users u WHERE u.tenant_id=p_tenant AND u.team_id IS NOT NULL
  UNION ALL SELECT 'QUEUE_REFERENCE'::text,u.id::text,u.team_id,NULL::text FROM public.queues u WHERE u.tenant_id=p_tenant AND u.team_id IS NOT NULL
  UNION ALL SELECT 'SKILL_REFERENCE'::text,u.id::text,u.team_id,NULL::text FROM public.skills u WHERE u.tenant_id=p_tenant AND u.team_id IS NOT NULL
  UNION ALL SELECT c.* FROM public.iam_team_segment_scope_active_grants u CROSS JOIN LATERAL public.dc_team_row_claims('iam_team_segment_scope_active_grants',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant
  UNION ALL SELECT c.* FROM public.iam_authoring_capability_grants u CROSS JOIN LATERAL public.dc_team_row_claims('iam_authoring_capability_grants',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant
  UNION ALL SELECT c.* FROM public.iam_authoring_delegations u CROSS JOIN LATERAL public.dc_team_row_claims('iam_authoring_delegations',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant
  UNION ALL SELECT c.* FROM public.jr_enrollments u CROSS JOIN LATERAL public.dc_team_row_claims('jr_enrollments',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant AND u.run_state<>'TERMINAL'
  UNION ALL SELECT 'CG_RESERVATION'::text,u.id::text,u.team_id,NULL::text FROM public.cg_reservations u WHERE u.tenant_id=p_tenant AND u.team_id IS NOT NULL AND u.state IN ('RESERVED','CONFIRMED') AND u.terminal_outcome IS NULL AND u.settlement_status IS DISTINCT FROM 'SETTLED'
  UNION ALL SELECT 'CG_ALERT'::text,u.id::text,u.team_id,NULL::text FROM public.cg5_alert_state u WHERE u.tenant_id=p_tenant AND u.team_id IS NOT NULL AND u.state IN ('OPEN','ACKED')
  UNION ALL SELECT c.* FROM public.ob_campaign_targets u CROSS JOIN LATERAL public.dc_team_row_claims('ob_campaign_targets',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant AND u.state NOT IN ('CONSUMED','CANCELLED','SUPERSEDED')
  UNION ALL SELECT c.* FROM public.ob_callbacks u CROSS JOIN LATERAL public.dc_team_row_claims('ob_callbacks',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant AND u.state NOT IN ('CONSUMED','CANCELLED','SUPERSEDED')
  UNION ALL SELECT c.* FROM public.jr_owner_actions u CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_actions',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant
  UNION ALL SELECT c.* FROM public.jr_owner_command_outbox u CROSS JOIN LATERAL public.dc_team_row_claims('jr_owner_command_outbox',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant
  UNION ALL SELECT 'JOURNEY_OWNERSHIP'::text,u.journey_id::text,u.owner_team_id,NULL::text FROM public.jr_journey_heads u WHERE u.tenant_id=p_tenant AND u.lifecycle IN ('DRAFT_ONLY','ACTIVE','PAUSED')
  UNION ALL SELECT 'TEMPLATE_OWNERSHIP'::text,u.template_id::text,u.owner_team_id,NULL::text FROM public.jr_template_heads u WHERE u.tenant_id=p_tenant AND u.lifecycle IN ('DRAFT_ONLY','ACTIVE')
  UNION ALL SELECT c.* FROM public.jr_schedule_occurrences u CROSS JOIN LATERAL public.dc_team_row_claims('jr_schedule_occurrences',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant AND u.state='CLAIMED'
  UNION ALL SELECT c.* FROM public.jr_segment_refilter_cursors u CROSS JOIN LATERAL public.dc_team_row_claims('jr_segment_refilter_cursors',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant
  UNION ALL SELECT c.* FROM public.jr_segment_enrollment_intents u CROSS JOIN LATERAL public.dc_team_row_claims('jr_segment_enrollment_intents',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant
  UNION ALL SELECT c.* FROM public.jr_actions u CROSS JOIN LATERAL public.dc_team_row_claims('jr_actions',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant AND u.realtime_state NOT IN ('CANCELLED','SETTLED')
  UNION ALL SELECT c.* FROM public.tenant_people_operations u CROSS JOIN LATERAL public.dc_team_row_claims('tenant_people_operations',to_jsonb(u),p_at) c WHERE u.tenant_id=p_tenant
$$;
REVOKE ALL ON FUNCTION dc_team_current_references(uuid,timestamptz) FROM PUBLIC;

CREATE FUNCTION dc_team_reference_writer() RETURNS trigger
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous jsonb; following jsonb; scope uuid; old_teams uuid[]; new_teams uuid[]; team uuid; active boolean; BEGIN
  IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
  IF TG_OP<>'DELETE' THEN following:=to_jsonb(NEW); END IF;
  scope:=coalesce(following->>'tenant_id',previous->>'tenant_id')::uuid;
  IF TG_OP='UPDATE' AND following->>'tenant_id' IS DISTINCT FROM previous->>'tenant_id' THEN
    RAISE EXCEPTION 'TEAM_REFERENCE_TENANT_IMMUTABLE' USING ERRCODE='23514'; END IF;
  -- tenant lock มาก่อน canonical lookup; VOLATILE helper ใช้ fresh statement snapshot
  PERFORM public.dc_team_reference_lock(scope,ARRAY[]::uuid[],false);
  SELECT array_agg(DISTINCT team_id) INTO old_teams FROM public.dc_team_row_claims(TG_TABLE_NAME,previous,statement_timestamp()) WHERE team_id IS NOT NULL;
  SELECT array_agg(DISTINCT team_id) INTO new_teams FROM public.dc_team_row_claims(TG_TABLE_NAME,following,statement_timestamp()) WHERE team_id IS NOT NULL;
  PERFORM public.dc_team_reference_lock(scope,coalesce(old_teams,ARRAY[]::uuid[])||coalesce(new_teams,ARRAY[]::uuid[]),false);
  IF TG_TABLE_NAME IN ('iam_authoring_delegation_revocations','jr_owner_continuations') AND TG_OP='INSERT' THEN old_teams:=new_teams; END IF;
  FOR team IN SELECT x FROM unnest(new_teams) x WHERE NOT(x=ANY(coalesce(old_teams,ARRAY[]::uuid[]))) LOOP
    SELECT is_active INTO active FROM public.teams WHERE tenant_id=scope AND id=team;
    IF NOT FOUND THEN RAISE EXCEPTION 'TEAM_INACTIVE' USING ERRCODE='23514'; END IF;
    IF NOT active AND NOT public.dc_team_provisioning_writer(scope) THEN RAISE EXCEPTION 'TEAM_INACTIVE' USING ERRCODE='23514'; END IF;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dc_team_reference_writer() FROM PUBLIC;
CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON users FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();

CREATE FUNCTION dc_team_reference_blockers(p_tenant uuid,p_team uuid)
RETURNS TABLE(kind text,count bigint)
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper)
    AND p_tenant IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'TEAM_TENANT_CONTEXT_REQUIRED' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT CASE WHEN r.reason IS NOT NULL OR t.id IS NULL THEN 'UNRESOLVED_CURRENT_REFERENCE' ELSE r.kind END,
    count(DISTINCT (r.kind,r.resource))
    FROM public.dc_team_current_references(p_tenant,statement_timestamp()) r
    LEFT JOIN public.teams t ON t.tenant_id=p_tenant AND t.id=r.team_id
    WHERE r.team_id=p_team OR r.reason IS NOT NULL OR t.id IS NULL
    GROUP BY 1;
END $$;
REVOKE ALL ON FUNCTION dc_team_reference_blockers(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_team_reference_blockers(uuid,uuid) TO dcontact_app;

CREATE FUNCTION dc_team_transition_fence() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$ BEGIN
  IF TG_OP='INSERT' THEN
    IF NOT NEW.is_active THEN PERFORM public.dc_team_reference_lock(NEW.tenant_id,ARRAY[NEW.id],NOT public.dc_team_provisioning_writer(NEW.tenant_id)); END IF;
  ELSIF NEW.is_active IS DISTINCT FROM OLD.is_active THEN
    PERFORM public.dc_team_reference_lock(NEW.tenant_id,ARRAY[NEW.id],true);
    IF NEW.is_active AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=session_user AND rolsuper) THEN
      RAISE EXCEPTION 'TEAM_REACTIVATION_UNSUPPORTED' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dc_team_transition_fence() FROM PUBLIC;
CREATE TRIGGER team_transition_fence BEFORE INSERT OR UPDATE ON teams FOR EACH ROW EXECUTE FUNCTION dc_team_transition_fence();

CREATE FUNCTION dc_team_final_state() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE scope uuid; resource uuid; active boolean; unresolved boolean; referenced boolean; BEGIN
  IF TG_OP='UPDATE' AND NOT OLD.is_active AND NOT NEW.is_active THEN RETURN NEW; END IF;
  scope:=NEW.tenant_id;resource:=NEW.id;
  SELECT is_active INTO active FROM public.teams WHERE tenant_id=scope AND id=resource;
  IF active IS NOT FALSE THEN RETURN NEW; END IF;
  IF TG_OP='INSERT' AND NOT NEW.is_active AND public.dc_team_provisioning_writer(scope) THEN RETURN NEW; END IF;
  SELECT bool_or(kind='UNRESOLVED_CURRENT_REFERENCE'),bool_or(true) INTO unresolved,referenced
    FROM public.dc_team_reference_blockers(scope,resource);
  IF unresolved THEN RAISE EXCEPTION 'TEAM_REFERENCE_UNRESOLVED' USING ERRCODE='23514'; END IF;
  IF referenced THEN RAISE EXCEPTION 'TEAM_REFERENCED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION dc_team_final_state() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER team_reference_final_state AFTER INSERT OR UPDATE ON teams
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_final_state();

CREATE FUNCTION dc_team_writer_final_state() RETURNS trigger LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE previous jsonb; following jsonb; scope uuid; row_key jsonb; predicate text; column_name text; old_teams uuid[]; claim record; BEGIN
  IF TG_OP<>'INSERT' THEN previous:=to_jsonb(OLD); END IF;
  IF TG_OP='DELETE' THEN row_key:=previous; ELSE row_key:=to_jsonb(NEW); END IF;
  scope:=(row_key->>'tenant_id')::uuid;
  SELECT string_agg(format('r.%I=k.%I',x,x),' AND ') INTO predicate FROM unnest(string_to_array(coalesce(TG_ARGV[0],'id'),',')) x;
  EXECUTE format('SELECT to_jsonb(r) FROM public.%I r, jsonb_populate_record(NULL::public.%I,$2) k WHERE r.tenant_id=$1 AND %s',TG_TABLE_NAME,TG_TABLE_NAME,predicate) INTO following USING scope,row_key;
  SELECT array_agg(DISTINCT team_id) INTO old_teams FROM public.dc_team_row_claims(TG_TABLE_NAME,previous,statement_timestamp()) WHERE team_id IS NOT NULL;
  FOR claim IN SELECT * FROM public.dc_team_row_claims(TG_TABLE_NAME,following,statement_timestamp()) LOOP
    IF claim.reason IS NOT NULL THEN
      IF NOT EXISTS(SELECT 1 FROM public.dc_team_row_claims(TG_TABLE_NAME,previous,statement_timestamp()) WHERE reason IS NOT NULL)
        AND EXISTS(SELECT 1 FROM public.teams WHERE tenant_id=scope AND NOT is_active) THEN
        RAISE EXCEPTION 'TEAM_REFERENCE_UNRESOLVED' USING ERRCODE='23514'; END IF;
    ELSIF NOT(claim.team_id=ANY(coalesce(old_teams,ARRAY[]::uuid[]))) THEN
      IF NOT EXISTS(SELECT 1 FROM public.teams WHERE tenant_id=scope AND id=claim.team_id AND (is_active OR public.dc_team_provisioning_writer(scope))) THEN
        RAISE EXCEPTION 'TEAM_INACTIVE' USING ERRCODE='23514'; END IF;
    END IF;
  END LOOP;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION dc_team_writer_final_state() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON users
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON queues FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON queues DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
-- queues(tenant_id,team_id) ใช้ index เดิม ไม่สร้างซ้ำ

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON skills FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON skills DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX skills_team_reference_idx ON skills(tenant_id,team_id);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON iam_team_segment_scope_active_grants FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer('team_id,segment_id,permission');
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON iam_team_segment_scope_active_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state('team_id,segment_id,permission');

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON iam_authoring_capability_grants FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON iam_authoring_capability_grants DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state('id');

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON iam_authoring_delegations FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON iam_authoring_delegations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state('id');

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON iam_authoring_delegation_revocations FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON iam_authoring_delegation_revocations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX iam_authoring_team_expiry_idx ON iam_authoring_capability_grants(tenant_id,scope_kind,scope_id,expires_at);
CREATE INDEX iam_authoring_delegation_team_expiry_idx ON iam_authoring_delegations(tenant_id,scope_kind,scope_id,expires_at);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_enrollments FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_enrollments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON cg_reservations FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON cg_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX cg_reservations_team_reference_idx ON cg_reservations(tenant_id,team_id,state);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON cg5_alert_state FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON cg5_alert_state DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX cg5_alert_state_team_reference_idx ON cg5_alert_state(tenant_id,team_id,state);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON ob_campaign_targets FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON ob_campaign_targets DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX ob_campaign_targets_source_owner_team_id_ref_idx ON ob_campaign_targets(tenant_id,source_owner_team_id,state);
CREATE INDEX ob_campaign_targets_target_owner_team_id_ref_idx ON ob_campaign_targets(tenant_id,target_owner_team_id,state);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON ob_callbacks FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON ob_callbacks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX ob_callbacks_source_owner_team_id_ref_idx ON ob_callbacks(tenant_id,source_owner_team_id,state);
CREATE INDEX ob_callbacks_target_owner_team_id_ref_idx ON ob_callbacks(tenant_id,target_owner_team_id,state);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_owner_actions FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_owner_actions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_owner_command_outbox FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_owner_command_outbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_owner_continuations FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_owner_continuations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX jr_owner_command_action_reference_idx ON jr_owner_command_outbox(tenant_id,action_id,state);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_journey_heads FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_journey_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_template_heads FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_template_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_schedule_occurrences FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_schedule_occurrences DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_segment_refilter_cursors FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_segment_refilter_cursors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_segment_enrollment_intents FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_segment_enrollment_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_segment_heads FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer('contact_id,segment_id');
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_segment_heads DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state('contact_id,segment_id');
CREATE INDEX jr_segment_intents_team_reference_idx ON jr_segment_enrollment_intents(tenant_id,journey_id,journey_version);
CREATE INDEX jr_segment_refilter_team_reference_idx ON jr_segment_refilter_cursors(tenant_id,scope_team_id,state);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_actions FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_actions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX jr_send_reservation_reference_idx ON jr_actions(tenant_id,reservation_id,realtime_state);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON tenant_people_operations FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer('id');
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON tenant_people_operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state('id');

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON tenant_user_lifecycles FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer('user_id');
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON tenant_user_lifecycles DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state('user_id');

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON tenant_identity_reservations FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer('identity_kind,identity_hash');
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON tenant_identity_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state('identity_kind,identity_hash');

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON tenant_people_invitation_intents FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer('operation_id');
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON tenant_people_invitation_intents DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state('operation_id');
CREATE INDEX tenant_people_lifecycle_operation_reference_idx ON tenant_user_lifecycles(tenant_id,operation_id);

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON jr_journey_definitions FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON jr_journey_definitions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();

CREATE TRIGGER team_reference_writer BEFORE INSERT OR UPDATE OR DELETE ON ob_dialer_command_inbox FOR EACH ROW EXECUTE FUNCTION dc_team_reference_writer();
CREATE CONSTRAINT TRIGGER team_reference_writer_final AFTER INSERT OR UPDATE OR DELETE ON ob_dialer_command_inbox DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_team_writer_final_state();
CREATE INDEX ob_owner_canonical_record_reference_idx ON ob_dialer_command_inbox(tenant_id,record_id);

-- Canonical joins สำหรับ dependent checks ไม่ scan versions/enrollments ทั้ง tenant
CREATE INDEX users_team_reference_idx ON users(tenant_id,team_id);
CREATE INDEX jr_enrollment_pinned_reference_idx ON jr_enrollments(tenant_id,journey_id,journey_version);
CREATE INDEX jr_owner_payload_pinned_reference_idx ON jr_owner_command_outbox(tenant_id,(payload->>'journeyId'),(payload->'journeyVersion'));
