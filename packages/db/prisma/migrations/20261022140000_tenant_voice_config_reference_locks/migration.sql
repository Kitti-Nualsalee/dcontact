CREATE FUNCTION dc_voice_lock_config_refs(tid uuid, queue_ids uuid[], user_ids uuid[]) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
  IF tid IS NULL OR tid IS DISTINCT FROM nullif(current_setting('app.tenant_id',true),'')::uuid THEN
    RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='42501';
  END IF;
  PERFORM queue_id FROM public.voice_managed_queue_policies
    WHERE tenant_id=tid AND queue_id=ANY(queue_ids) ORDER BY queue_id FOR UPDATE NOWAIT;
  PERFORM user_id FROM public.tenant_user_lifecycles
    WHERE tenant_id=tid AND user_id=ANY(user_ids) ORDER BY user_id FOR UPDATE NOWAIT;
END $$;

REVOKE ALL ON FUNCTION dc_voice_lock_config_refs(uuid,uuid[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_voice_lock_config_refs(uuid,uuid[],uuid[]) TO dcontact_app;
