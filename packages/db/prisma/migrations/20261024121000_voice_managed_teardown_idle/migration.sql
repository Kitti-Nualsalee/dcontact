BEGIN;

CREATE FUNCTION dc_voice_managed_cleanup_pending(tid uuid,queue_ids uuid[] DEFAULT NULL,agent_ids uuid[] DEFAULT NULL)
RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT tid=nullif(current_setting('app.tenant_id',true),'')::uuid AND EXISTS(
    SELECT 1 FROM voice_managed_commands cmd
    JOIN interactions i ON i.tenant_id=cmd.tenant_id AND i.id=cmd.interaction_id
    LEFT JOIN voice_managed_offers offer ON offer.tenant_id=cmd.tenant_id AND offer.id=cmd.offer_id
    WHERE cmd.tenant_id=tid AND cmd.status='PENDING' AND cmd.command_type IN ('offer.cancel','call.hangup')
      AND (i.queue_id=ANY(queue_ids) OR offer.agent_id=ANY(agent_ids))
  )
$$;
REVOKE ALL ON FUNCTION dc_voice_managed_cleanup_pending(uuid,uuid[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_voice_managed_cleanup_pending(uuid,uuid[],uuid[]) TO dcontact_app;

DO $$ DECLARE name text; original text; definition text; tid text; needle text; BEGIN
  FOREACH name IN ARRAY ARRAY['dc_voice_skill_assignment_guard','dc_voice_routing_update_guard'] LOOP
    SELECT pg_get_functiondef((name||'()')::regprocedure) INTO original;
    tid:=CASE WHEN name='dc_voice_skill_assignment_guard' THEN 'assignment.tenant_id' ELSE 'scope' END;
    needle:='IF EXISTS(SELECT 1 FROM interactions WHERE tenant_id='||tid||' AND channel=''VOICE''';
    definition:=replace(original,needle,
      'IF dc_voice_managed_cleanup_pending('||tid||',affected_queues,affected_agents) THEN RAISE EXCEPTION ''CONFIG_BUSY'' USING ERRCODE=''55P03''; END IF; '||needle);
    IF definition=original THEN RAISE EXCEPTION 'MANAGED_IDLE_GUARD_BASELINE_MISMATCH: %',name; END IF;
    EXECUTE definition;
  END LOOP;
END $$;

COMMIT;
