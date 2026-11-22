-- #991: คิว managed (voice_config_version=1) เปิด recording_enabled ได้
-- auto QM และ transcription ยังต้องปิดเหมือนเดิม; migration นี้ additive (แก้เฉพาะนิยาม function)
BEGIN;

DO $$ DECLARE original text; definition text; BEGIN
  SELECT pg_get_functiondef('dc_voice_managed_activation_check(uuid,jsonb,text)'::regprocedure) INTO original;
  definition:=replace(original,
    'AND NOT recording_enabled AND NOT auto_qm_enabled AND transcription_mode',
    'AND NOT auto_qm_enabled AND transcription_mode');
  IF definition=original THEN RAISE EXCEPTION 'MANAGED_RECORDING_ACTIVATION_BASELINE_MISMATCH'; END IF;
  EXECUTE definition;

  SELECT pg_get_functiondef('dc_voice_routing_update_guard()'::regprocedure) INTO original;
  definition:=replace(original,
    'ARRAY[''name'',''is_active'',''config_revision'']',
    'ARRAY[''name'',''is_active'',''recording_enabled'',''config_revision'']');
  IF definition=original THEN RAISE EXCEPTION 'MANAGED_RECORDING_UPDATE_GUARD_BASELINE_MISMATCH'; END IF;
  EXECUTE definition;
END $$;

COMMIT;
