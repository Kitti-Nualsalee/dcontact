-- Row-Level Security: tenant isolation ที่ระดับ DB
-- ใช้ร่วมกับ session variable app.tenant_id (SET LOCAL app.tenant_id = '<uuid>')
--
-- หมายเหตุ: Prisma ต่อ DB ด้วย superuser/owner ตอน dev ซึ่ง bypass RLS
-- ใน production ให้ app ต่อด้วย role "dcontact_app" (NOBYPASSRLS) เท่านั้น
-- Phase 0: นโยบายถูกติดตั้งไว้ก่อน + service layer scope ทุก query ด้วย tenantId เสมอ

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'teams', 'queues', 'voice_destinations', 'queue_audit_events', 'skills',
    'agent_state_logs', 'contacts', 'contact_identities',
    'interactions', 'interaction_events', 'conversations', 'messages', 'recordings',
    'recording_audit_events', 'recording_legal_holds',
    'qm_transcription_jobs', 'qm_audit_events', 'qm_transcripts',
    'qm_transcript_segments', 'qm_evaluations', 'qm_console_contexts', 'command_receipts',
    'cg_restrictions', 'cg_consents', 'cg_decision_logs', 'cg_reservations',
    'cg_attempts', 'cg_touches',
    'jr_event_inbox', 'jr_enrollments', 'jr_actions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- application role สำหรับ production (ไม่ bypass RLS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') THEN
    CREATE ROLE dcontact_app LOGIN PASSWORD 'dcontact_app' NOBYPASSRLS;
  END IF;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dcontact_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dcontact_app;

-- Queue audit is append-only through the application role.
REVOKE UPDATE, DELETE ON queue_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON recording_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON qm_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_decision_logs FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_attempts FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_touches FROM dcontact_app;
