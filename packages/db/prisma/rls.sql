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
    'cg_reservation_command_receipts',
    'cg_preferences', 'cg_policies', 'cg_holiday_calendar_entries',
    'cg_callback_requests', 'cg_contact_state_heads', 'cg_event_outbox',
    'cg_command_receipts', 'cg_audit_logs', 'cg_consumer_acknowledgements',
    'jr_event_inbox', 'jr_enrollments', 'jr_actions', 'jr_journey_definitions',
    'ob_attempts', 'ob_governance_consumer_inbox', 'ob_governance_acknowledgement_outbox',
    'ob_governance_effect_outbox',
    'dl_outbox_entries',
    'jr_schedule_occurrences', 'jr_step_runs', 'jr_owner_continuations',
    -- CG4.2 (#185)
    'cg_policy', 'cg_policy_scope_head', 'cg_policy_test_artifact', 'cg_policy_approval',
    'cg_policy_activation_job', 'cg_exception', 'cg_exception_head', 'cg_exception_approval',
    'cg_scope_kill_switch', 'cg4_backfill_ledger', 'cg_exception_contact_head',
    -- CG4.3 (#186)
    'cg_delegation',
    -- CG4.6 (#189)
    'cg_consumer_inbox', 'cg_scope_pause',
    -- CG4.7 (#190)
    'cg_authorization_subject', 'cg_capability_grant',
    -- CG4.10 (#193)
    'cg4_rollout_state', 'cg4_rollout_transition', 'cg4_shadow_mismatch',
    -- CG5.2 (#286)
    'cg5_metric_bucket', 'cg5_policy_impact_bucket', 'cg5_projection_cursor', 'cg5_alert_state', 'cg5_alert_transition', 'cg5_export_job', 'cg5_tenant_config', 'cg5_tenant_config_audit',
    -- J3.2 (#213)
    'c360_segment_definitions', 'c360_segment_definition_heads',
    'c360_fact_snapshots', 'c360_segment_evaluations',
    -- J3.3 (#214)
    'c360_segment_membership_heads', 'c360_segment_membership_changes',
    'c360_segment_membership_outbox', 'c360_segment_evidence',
    'c360_evidence_access_audit', 'c360_membership_command_receipts',
    'c360_membership_quarantine', 'c360_identity_heads', 'c360_identity_lineage',
    -- J5.1 (#339)
    'jr_journey_heads', 'jr_journey_drafts', 'jr_authoring_command_receipts',
    'jr_review_candidates', 'jr_review_decisions', 'jr_authoring_audit', 'jr_authoring_outbox',
    'jr_template_heads', 'jr_template_drafts', 'jr_template_versions', 'jr_template_provenance',
    'jr_template_upgrade_applications', 'jr_authoring_rollout_state',
    'iam_authoring_subjects', 'iam_authoring_capability_grants', 'iam_authoring_delegations',
    'iam_authoring_delegation_revocations', 'iam_authoring_scope_versions',
    -- S2.1 (#365)
    'dl_provider_submission_attempts', 'dl_line_scope_gates', 'dl_line_credential_refs',
    'dl_line_allowlist_entries', 'dl_line_run_authorizations', 'dl_line_cap_ledger',
    'dl_line_webhook_inbox', 'dl_line_touch_correlations', 'dl_line_audit_events',
    -- S2.5 (#369)
    'dl_line_inbound_messages', 'dl_line_event_outbox', 'dl_line_webhook_payloads',
    -- U1.1 (#429)
    'uat_fixture_packs', 'uat_runs', 'uat_run_step_results', 'uat_command_receipts',
    -- A1.5 (#410): operational baseline ของ tenant
    'tenant_settings', 'tenant_plan_bindings', 'business_hours',
    -- D1.12 (#451): หมุดแอปของ tenant/ผู้ใช้
    'navigation_tenant_default_pins', 'navigation_user_pins', 'navigation_audit_events',
    -- D1.13 (#452): UI flag ระดับ tenant
    'tenant_ui_flags', 'tenant_ui_flag_audit_events'
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

-- ไม่มีสิ่งนี้แล้ว dcontact_app มองไม่เห็น schema เลย (fail กับ "permission denied
-- for schema public") บน environment ที่สร้างใหม่ทั้งหมด — เคย implicit ผ่าน default
-- privilege ของ Postgres รุ่นเก่า/การตั้งค่าที่ไม่ได้ track ไว้ในนี้
GRANT USAGE ON SCHEMA public TO dcontact_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dcontact_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dcontact_app;

-- Queue audit is append-only through the application role.
REVOKE UPDATE, DELETE ON queue_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON navigation_audit_events FROM dcontact_app;
-- D1.13 (#452): แอปอ่าน UI flag ได้อย่างเดียว — platform operator เป็นผู้เปลี่ยน (ผ่าน dcontact_platform)
REVOKE INSERT, UPDATE, DELETE ON tenant_ui_flags, tenant_ui_flag_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON recording_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON qm_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_decision_logs FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_attempts FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_touches FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_reservation_command_receipts FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_preferences FROM dcontact_app;
REVOKE DELETE ON cg_policies FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_holiday_calendar_entries FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_callback_requests FROM dcontact_app;
REVOKE DELETE ON cg_contact_state_heads FROM dcontact_app;
REVOKE DELETE ON cg_event_outbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_command_receipts FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_audit_logs FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_consumer_acknowledgements FROM dcontact_app;
-- Journey definition content is immutable; only the publish transition (status/published_at)
-- may change a row, and the application enforces that narrowing — not a DB-level column grant.
REVOKE DELETE ON jr_journey_definitions FROM dcontact_app;
-- U1.1 (#429): fixture pack สร้างโดย UAT operator เท่านั้น; run ห้ามลบ; step result append-only
REVOKE INSERT, UPDATE, DELETE ON uat_fixture_packs FROM dcontact_app;
REVOKE DELETE ON uat_runs FROM dcontact_app;
REVOKE UPDATE, DELETE ON uat_run_step_results FROM dcontact_app;
REVOKE DELETE ON uat_command_receipts FROM dcontact_app;
-- Delivery outbox rows advance through states, so UPDATE stays granted; a delivery that was
-- already claimed must never disappear, because the reservation it settles points back at it.
REVOKE DELETE ON dl_outbox_entries FROM dcontact_app;
-- Occurrence เดินสถานะได้ แต่หลักฐานว่า schedule เคยยิงต้องอยู่ตลอด
REVOKE DELETE ON jr_schedule_occurrences FROM dcontact_app;
-- Step run เป็น ledger เขียนครั้งเดียว: เดินซ้ำได้เฉพาะเพราะแถวเดิมยังอยู่
REVOKE UPDATE, DELETE ON jr_step_runs FROM dcontact_app;
-- Raw Dialer attempts และ consumer/effect ledgers เป็นหลักฐานที่ต้องเก็บไว้สำหรับ replay.
REVOKE DELETE ON ob_attempts FROM dcontact_app;
REVOKE DELETE ON ob_governance_consumer_inbox FROM dcontact_app;
REVOKE DELETE ON ob_governance_acknowledgement_outbox FROM dcontact_app;
REVOKE DELETE ON ob_governance_effect_outbox FROM dcontact_app;
-- S1.5: CG3 realtime invalidation ledgers ของ Journey — พลาดตกหล่นตอนแรก ทำให้
-- blanket GRANT ด้านบนคืนสิทธิ์ DELETE ให้โดยไม่ตั้งใจ (ตรงข้ามกับที่ migration เดิมตั้งใจ)
REVOKE DELETE ON jr_governance_consumer_inbox FROM dcontact_app;
REVOKE DELETE ON jr_governance_acknowledgement_outbox FROM dcontact_app;
REVOKE DELETE ON jr_governance_effect_outbox FROM dcontact_app;
REVOKE DELETE ON jr_action_lifecycle_inbox FROM dcontact_app;
-- J2.3: outcome/action durable foundation — receipt/head/action/command/result เดินสถานะได้
-- (UPDATE ยังอยู่) แต่ห้ามหายทั้งแถว; recovery audit เป็น append-only ล้วน
REVOKE DELETE ON jr_outcome_receipts FROM dcontact_app;
REVOKE DELETE ON jr_outcome_heads FROM dcontact_app;
REVOKE DELETE ON jr_owner_actions FROM dcontact_app;
REVOKE DELETE ON jr_owner_command_outbox FROM dcontact_app;
REVOKE DELETE ON jr_owner_result_inbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_recovery_audit FROM dcontact_app;
-- J5.0: continuation เป็น immutable ledger ของการขยับ cursor หลัง owner result
REVOKE UPDATE, DELETE ON jr_owner_continuations FROM dcontact_app;
-- J2.4: Cases ENSURE_CASE owner slice — fixture/case/link/activity/command เดินสถานะได้
-- แต่ห้ามหายทั้งแถว
REVOKE DELETE ON cs_case_type_policies FROM dcontact_app;
REVOKE DELETE ON cs_routing_policies FROM dcontact_app;
REVOKE DELETE ON cs_cases FROM dcontact_app;
REVOKE DELETE ON cs_case_links FROM dcontact_app;
REVOKE DELETE ON cs_case_activities FROM dcontact_app;
REVOKE DELETE ON cs_command_inbox FROM dcontact_app;
-- J2.5: Dialer ADMIT_CAMPAIGN_TARGET owner slice — fixture/target/command เดินสถานะได้
-- แต่ห้ามหายทั้งแถว
REVOKE DELETE ON ob_campaigns FROM dcontact_app;
REVOKE DELETE ON ob_campaign_admission_policies FROM dcontact_app;
REVOKE DELETE ON ob_campaign_targets FROM dcontact_app;
REVOKE DELETE ON ob_dialer_command_inbox FROM dcontact_app;
-- J2.6: Dialer SCHEDULE_CALLBACK owner slice — callback เดินสถานะได้แต่ห้ามหายทั้งแถว
REVOKE DELETE ON ob_callbacks FROM dcontact_app;
-- CG4.2 (#185): blanket GRANT ด้านบนคืนสิทธิ์ UPDATE/DELETE ให้ตารางที่ยังไม่เคยอยู่ใน
-- array/REVOKE ชุดนี้มาก่อน ต้อง REVOKE ซ้ำที่นี่ให้ตรงกับ grant ที่ migration ตั้งใจไว้
-- ไม่งั้น cg_exception/cg_exception_approval ที่ควร append-only จะกลาย mutable/deletable
-- ทันทีที่ environment รัน db:rls
REVOKE UPDATE, DELETE ON cg_policy_test_artifact FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_policy_approval FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_exception FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg_exception_approval FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg4_backfill_ledger FROM dcontact_app;
REVOKE DELETE ON cg_policy FROM dcontact_app;
REVOKE DELETE ON cg_policy_scope_head FROM dcontact_app;
REVOKE DELETE ON cg_policy_activation_job FROM dcontact_app;
REVOKE DELETE ON cg_exception_head FROM dcontact_app;
REVOKE DELETE ON cg_scope_kill_switch FROM dcontact_app;
REVOKE DELETE ON cg_exception_contact_head FROM dcontact_app;
-- CG4.3 (#186): delegation is append-only, same reasoning as above.
REVOKE UPDATE, DELETE ON cg_delegation FROM dcontact_app;
-- CG4.6 (#189): the inbox is the completion record for at-least-once delivery, so a row
-- must never be rewritten or removed; a scope pause advances state but keeps its history.
REVOKE UPDATE, DELETE ON cg_consumer_inbox FROM dcontact_app;
REVOKE DELETE ON cg_scope_pause FROM dcontact_app;
-- CG4.7 (#190): Contact Governance only reads its authorization state. Grants are
-- administered outside the application role so a compromised app cannot widen its own
-- capabilities — the blanket GRANT above would otherwise hand it exactly that.
REVOKE INSERT, UPDATE, DELETE ON cg_authorization_subject FROM dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON cg_capability_grant FROM dcontact_app;
-- CG4.10 (#193): rollout state เดินได้แต่ลบไม่ได้; transition/shadow mismatch เป็นหลักฐาน append-only
REVOKE DELETE ON cg4_rollout_state FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg4_rollout_transition FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg4_shadow_mismatch FROM dcontact_app;
-- J3.2: definition เดินได้เฉพาะ lifecycle ผ่าน DB trigger; snapshot/evaluation เป็น immutable
REVOKE DELETE ON c360_segment_definitions FROM dcontact_app;
REVOKE DELETE ON c360_segment_definition_heads FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_fact_snapshots FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_segment_evaluations FROM dcontact_app;
-- J3.3: heads/outbox เป็น CAS state; canonical facts, receipts, audit และ lineage เป็น append-only
REVOKE DELETE ON c360_segment_membership_heads FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_segment_membership_changes FROM dcontact_app;
REVOKE DELETE ON c360_segment_membership_outbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_segment_evidence FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_evidence_access_audit FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_membership_command_receipts FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_membership_quarantine FROM dcontact_app;
REVOKE DELETE ON c360_identity_heads FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_identity_lineage FROM dcontact_app;

-- J3.5/J3.10: bootstrap ต้องไม่คืนสิทธิ์แก้/ลบหลักฐานที่ migration กำหนดเป็น append-only
REVOKE UPDATE, DELETE ON jr_segment_enrollment_intents FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_segment_shadow_mismatches FROM dcontact_app;
REVOKE DELETE ON jr_segment_rollout_state FROM dcontact_app;

-- IAM scope authority: grant/revocation เป็นหลักฐาน append-only (ดู 20260917050000 /
-- 20260917050200) — bootstrap เคยคืนสิทธิ์ที่ migration ถอนไว้ จึงต้องถอนซ้ำที่นี่
REVOKE UPDATE, DELETE ON iam_scope_consumer_inbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON iam_team_segment_scope_grants FROM dcontact_app;

-- J2.9 (#137): rollout gate ของ originate barrier — audit เป็น append-only และแถว state ลบไม่ได้
-- (ลบแถวที่ถูก kill = สร้างใหม่เป็น DISABLED ได้ เท่ากับยก kill switch ซึ่ง #124 ห้ามไว้)
REVOKE DELETE ON ob_originate_rollout_state FROM dcontact_app;
REVOKE UPDATE ON ob_originate_rollout_scopes FROM dcontact_app;
REVOKE UPDATE, DELETE ON ob_originate_rollout_audit FROM dcontact_app;

-- CG5.2: คงสิทธิ์ append-only หลัง bootstrap
REVOKE UPDATE, DELETE ON cg5_alert_transition, cg5_tenant_config_audit FROM dcontact_app;
REVOKE DELETE ON cg5_tenant_config FROM dcontact_app;

-- J5.1 (#339): head/receipt/candidate/outbox/upgrade/rollout เดินสถานะได้แต่ห้ามหาย;
-- draft/decision/audit/template version/provenance/delegation เป็น append-only;
-- IAM authorization state อ่านได้อย่างเดียวจาก application role (แบบเดียวกับ CG4.7)
REVOKE DELETE ON jr_journey_heads FROM dcontact_app;
REVOKE DELETE ON jr_authoring_command_receipts FROM dcontact_app;
REVOKE DELETE ON jr_review_candidates FROM dcontact_app;
REVOKE DELETE ON jr_authoring_outbox FROM dcontact_app;
REVOKE DELETE ON jr_template_heads FROM dcontact_app;
REVOKE DELETE ON jr_template_upgrade_applications FROM dcontact_app;
REVOKE DELETE ON jr_authoring_rollout_state FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_journey_drafts FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_review_decisions FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_authoring_audit FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_template_drafts FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_template_versions FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_template_provenance FROM dcontact_app;
REVOKE UPDATE, DELETE ON iam_authoring_delegations FROM dcontact_app;
REVOKE UPDATE, DELETE ON iam_authoring_delegation_revocations FROM dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON iam_authoring_subjects FROM dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON iam_authoring_capability_grants FROM dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON iam_authoring_scope_versions FROM dcontact_app;

-- S2.1 (#365): gate/credential/allowlist/run/cap/inbox/correlation เดินสถานะได้แต่ห้ามหาย
-- (ลบ gate ที่ถูก kill = สร้างใหม่เป็น DISABLED เท่ากับยก kill switch); attempt receipt และ
-- audit เป็นหลักฐาน append-only
REVOKE DELETE ON dl_line_scope_gates FROM dcontact_app;
REVOKE DELETE ON dl_line_credential_refs FROM dcontact_app;
REVOKE DELETE ON dl_line_allowlist_entries FROM dcontact_app;
REVOKE DELETE ON dl_line_run_authorizations FROM dcontact_app;
REVOKE DELETE ON dl_line_cap_ledger FROM dcontact_app;
REVOKE DELETE ON dl_line_webhook_inbox FROM dcontact_app;
REVOKE DELETE ON dl_line_touch_correlations FROM dcontact_app;
REVOKE UPDATE, DELETE ON dl_provider_submission_attempts FROM dcontact_app;
REVOKE UPDATE, DELETE ON dl_line_audit_events FROM dcontact_app;
-- S2.5 (#369): projection เป็นหลักฐานว่า message ถูก project แล้ว (append-only);
-- event outbox claim/publish ได้แต่ลบไม่ได้
REVOKE UPDATE, DELETE ON dl_line_inbound_messages FROM dcontact_app;
REVOKE DELETE ON dl_line_event_outbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON dl_line_webhook_payloads FROM dcontact_app;

-- A1.1 (#406): control plane ของ Platform Admin ไม่ใช่ข้อมูลของ tenant — tenant application
-- (`dcontact_app`) ต้องไม่เห็น `pf_*` เลย ส่วน `dcontact_platform` เห็นเฉพาะ metadata ที่จำเป็น
-- และไม่มีสิทธิ์บน tenant business tables ใด ๆ (blanket GRANT ด้านบนให้เฉพาะ dcontact_app)
REVOKE ALL ON pf_bootstrap_templates, pf_provisioning_requests, pf_provisioning_steps,
  pf_provisioning_step_receipts, pf_command_receipts, pf_identity_reservations,
  pf_action_history FROM dcontact_app;

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_platform') THEN
    CREATE ROLE dcontact_platform LOGIN PASSWORD 'dcontact_platform' NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO dcontact_platform;
GRANT SELECT, INSERT ON tenants TO dcontact_platform;
GRANT UPDATE (lifecycle_status, slug, sip_domain, primary_domain) ON tenants TO dcontact_platform;
GRANT SELECT, INSERT, UPDATE ON pf_bootstrap_templates, pf_provisioning_requests,
  pf_provisioning_steps, pf_identity_reservations TO dcontact_platform;
GRANT SELECT, INSERT ON pf_provisioning_step_receipts, pf_command_receipts, pf_action_history
  TO dcontact_platform;

-- A1.4 (#409): invitation outbox เป็น control plane; tenant app ห้ามเห็น
REVOKE ALL ON pf_invitations FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON pf_invitations TO dcontact_platform;

-- #388 decision "Tenant bootstrap write boundary": saga worker เขียนข้อมูลตั้งต้นของ tenant ด้วย
-- role แยกนี้เท่านั้น และได้เฉพาะ tenant ที่ยัง PROVISIONING (policy อยู่ใน migration ของ A1.4)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_provisioner') THEN
    CREATE ROLE dcontact_provisioner LOGIN PASSWORD 'dcontact_provisioner' NOBYPASSRLS;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO dcontact_provisioner;
GRANT SELECT (id, lifecycle_status) ON tenants TO dcontact_provisioner;
GRANT SELECT, INSERT ON users TO dcontact_provisioner;
GRANT UPDATE (keycloak_id) ON users TO dcontact_provisioner;

-- A1.5 (#410): plan catalog และ payload revision เป็น control plane; provisioner seed baseline
-- ได้เฉพาะ tenant ที่ยัง PROVISIONING (policy อยู่ใน migration ของ A1.5)
REVOKE ALL ON pf_plan_versions, pf_request_payload_revisions FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON pf_plan_versions TO dcontact_platform;
GRANT SELECT, INSERT ON pf_request_payload_revisions TO dcontact_platform;
GRANT UPDATE (name) ON tenants TO dcontact_platform;
GRANT SELECT, INSERT ON teams, queues, tenant_settings, tenant_plan_bindings, business_hours
  TO dcontact_provisioner;

-- A1.6 (#411): durable operator command เป็น control plane
REVOKE ALL ON pf_operator_commands FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON pf_operator_commands TO dcontact_platform;

-- A1.5b (#441): revision ของอีเมล first admin เป็น control plane
REVOKE ALL ON pf_first_admin_email_revisions FROM dcontact_app;
GRANT SELECT, INSERT ON pf_first_admin_email_revisions TO dcontact_platform;

-- D1.13 (#452): platform operator เปิด/ปิด `ui.shell.v2` ต่อ tenant — ยังอยู่ใต้ tenant_isolation
-- (ต้องตั้ง app.tenant_id) และ audit เป็น append-only
GRANT SELECT, INSERT, UPDATE ON tenant_ui_flags TO dcontact_platform;
GRANT SELECT, INSERT ON tenant_ui_flag_audit_events TO dcontact_platform;
