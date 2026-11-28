-- Row-Level Security: tenant isolation at the DB level
-- Used with the session variable app.tenant_id (SET LOCAL app.tenant_id = '<uuid>')
--
-- Note: in dev, Prisma connects to the DB as superuser/owner, which bypasses RLS
-- In production the app must connect only as the role "dcontact_app" (NOBYPASSRLS)
-- Phase 0: the policies are installed ahead of time + the service layer always scopes every query by tenantId

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'users', 'teams', 'queues', 'voice_destinations', 'queue_audit_events', 'skills',
    'agent_skills', 'queue_skills',
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
    'dl_outbox_entries', 'dl_voice_originates',
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
    -- #567: replies in the LINE team trial
    'dl_line_trial_sends',
    -- U1.1 (#429)
    'uat_fixture_packs', 'uat_runs', 'uat_run_step_results', 'uat_command_receipts',
    -- U1.5 (#433)
    'uat_run_evidence', 'uat_run_scans',
    -- A1.5 (#410): operational baseline of the tenant
    'tenant_settings', 'tenant_plan_bindings', 'business_hours',
    -- D1.12 (#451): tenant/user app pins
    'navigation_tenant_default_pins', 'navigation_user_pins', 'navigation_audit_events',
    -- D1.13 (#452): tenant-level UI flag
    'tenant_ui_flags', 'tenant_ui_flag_audit_events',
    -- E1.9 (#483): agent work-session lease
    'agent_work_session_leases', 'agent_work_session_events', 'agent_sip_credentials',
    -- E1.11 (#485): allowlist for dphone embedding
    'tenant_embed_origins', 'tenant_embed_origin_audit_events',
    'dphone_click_to_call_audit_events',
    -- AC1 (#594): account policy and account self-service (#589)
    'tenant_account_policies', 'tenant_account_policy_audit_events',
    'account_email_changes', 'account_totp_enrolments', 'account_audit_events',
    -- AC3 (#596): account email outbox
    'account_email_outbox',
    -- Cus360 C1 (#791): customer profile, command/receipt and work mutation auth
    'c360_profile_commands', 'c360_profile_command_receipts', 'c360_profile_audits',
    'c360_contact_points', 'c360_contact_custodian_grants', 'c360_contact_custodian_revocations',
    'c360_interaction_customer_changes', 'c360_tags', 'c360_contact_tags', 'c360_work_mutation_auth',
    'c360_actor_capability_grants', 'c360_actor_capability_revocations',
    -- #967: the team that actually took the call, and the Supervisor's listening session
    'voice_interaction_handling_attributions', 'recording_playback_sessions',
    -- #971: quality evaluation forms and versions
    'qm_forms', 'qm_form_versions',
    -- #1044: web chat widget, visitor sessions and offers
    'webchat_widgets', 'webchat_widget_audit_events', 'webchat_sessions', 'webchat_offers',
    'line_channels', 'line_channel_audit_events', 'line_chat_users',
    -- #1061: agent callback timeline
    'ob_callback_events',
    -- #1067: outbox of interaction outcome facts
    'interaction_outcome_outbox'
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

ALTER TABLE agent_skills FORCE ROW LEVEL SECURITY;
ALTER TABLE queue_skills FORCE ROW LEVEL SECURITY;

-- application role for production (does not bypass RLS)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_app') THEN
    CREATE ROLE dcontact_app LOGIN PASSWORD 'dcontact_app' NOBYPASSRLS;
  END IF;
END $$;

-- Without this dcontact_app cannot see the schema at all (fails with "permission denied
-- for schema public") on a fully fresh environment — it used to pass implicitly through the default
-- privileges of older Postgres versions/settings not tracked here
GRANT USAGE ON SCHEMA public TO dcontact_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO dcontact_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO dcontact_app;

-- Queue audit is append-only through the application role.
REVOKE UPDATE, DELETE ON queue_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON interaction_wrapup_results FROM dcontact_app;
REVOKE UPDATE, DELETE ON navigation_audit_events FROM dcontact_app;
-- #1044: the widget audit is append-only; widgets, sessions and offers change state but are never deleted
REVOKE UPDATE, DELETE ON webchat_widget_audit_events FROM dcontact_app;
REVOKE DELETE ON webchat_widgets, webchat_sessions, webchat_offers FROM dcontact_app;
REVOKE UPDATE, DELETE ON line_channel_audit_events FROM dcontact_app;
REVOKE DELETE ON line_channels, line_chat_users FROM dcontact_app;
REVOKE UPDATE, DELETE ON ob_callback_events FROM dcontact_app;
-- #1067: the relay marks rows SENT but never deletes an outcome fact
REVOKE DELETE ON interaction_outcome_outbox FROM dcontact_app;
-- E1.9 (#483): a lease is released only by UPDATE, never deleted; audit is append-only
REVOKE DELETE ON agent_work_session_leases FROM dcontact_app;
REVOKE DELETE ON agent_sip_credentials FROM dcontact_app;
REVOKE UPDATE, DELETE ON agent_work_session_events FROM dcontact_app;
-- E1.11 (#485): the embed origin audit is append-only
REVOKE UPDATE, DELETE ON tenant_embed_origin_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON dphone_click_to_call_audit_events FROM dcontact_app;
-- AC1 (#594): the account policy and user account audit is append-only; policies are never deleted (reset to defaults with UPDATE)
REVOKE UPDATE, DELETE ON tenant_account_policy_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON account_audit_events FROM dcontact_app;
REVOKE DELETE ON tenant_account_policies FROM dcontact_app;
-- AC3 (#596): the outbox is never deleted — finished rows have their recipients/variables cleared instead
REVOKE DELETE ON account_email_outbox FROM dcontact_app;
-- D1.13 (#452): the app can only read the UI flag — the platform operator changes it (through dcontact_platform)
REVOKE INSERT, UPDATE, DELETE ON tenant_ui_flags, tenant_ui_flag_audit_events FROM dcontact_app;
REVOKE UPDATE, DELETE ON recording_audit_events FROM dcontact_app;
-- #967: evidence of the team that took the call is append-only; a session is closed with UPDATE, not deleted
REVOKE UPDATE, DELETE ON voice_interaction_handling_attributions FROM dcontact_app;
REVOKE DELETE ON recording_playback_sessions FROM dcontact_app;
REVOKE UPDATE, DELETE ON qm_audit_events FROM dcontact_app;
-- #971: forms and versions are never deleted (evaluations reference them); a published version is protected from edits by a trigger
REVOKE DELETE ON qm_forms, qm_form_versions FROM dcontact_app;
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
-- U1.1 (#429): fixture packs are created only by the UAT operator; runs must not be deleted; step results are append-only
REVOKE INSERT, UPDATE, DELETE ON uat_fixture_packs FROM dcontact_app;
REVOKE DELETE ON uat_runs FROM dcontact_app;
REVOKE UPDATE, DELETE ON uat_run_step_results FROM dcontact_app;
REVOKE DELETE ON uat_command_receipts FROM dcontact_app;
-- U1.5 (#433): screenshot evidence metadata and negative scan results are append-only
REVOKE UPDATE, DELETE ON uat_run_evidence, uat_run_scans FROM dcontact_app;
-- Delivery outbox rows advance through states, so UPDATE stays granted; a delivery that was
-- already claimed must never disappear, because the reservation it settles points back at it.
REVOKE DELETE ON dl_outbox_entries FROM dcontact_app;
REVOKE DELETE ON dl_voice_originates FROM dcontact_app;
-- An occurrence can change state, but the evidence that a schedule ever fired must stay forever
REVOKE DELETE ON jr_schedule_occurrences FROM dcontact_app;
-- A step run is a write-once ledger: it can advance repeatedly only because the original row still exists
REVOKE UPDATE, DELETE ON jr_step_runs FROM dcontact_app;
-- Raw Dialer attempts and consumer/effect ledgers are evidence that must be kept for replay.
REVOKE DELETE ON ob_attempts FROM dcontact_app;
REVOKE DELETE ON ob_governance_consumer_inbox FROM dcontact_app;
REVOKE DELETE ON ob_governance_acknowledgement_outbox FROM dcontact_app;
REVOKE DELETE ON ob_governance_effect_outbox FROM dcontact_app;
-- S1.5: the CG3 realtime invalidation ledgers of Journey — missed at first, so the
-- blanket GRANT above gave DELETE back unintentionally (the opposite of what the original migration intended)
REVOKE DELETE ON jr_governance_consumer_inbox FROM dcontact_app;
REVOKE DELETE ON jr_governance_acknowledgement_outbox FROM dcontact_app;
REVOKE DELETE ON jr_governance_effect_outbox FROM dcontact_app;
REVOKE DELETE ON jr_action_lifecycle_inbox FROM dcontact_app;
-- J2.3: outcome/action durable foundation — receipt/head/action/command/result can change state
-- (UPDATE remains) but a whole row must not disappear; the recovery audit is purely append-only
REVOKE DELETE ON jr_outcome_receipts FROM dcontact_app;
REVOKE DELETE ON jr_outcome_heads FROM dcontact_app;
REVOKE DELETE ON jr_owner_actions FROM dcontact_app;
REVOKE DELETE ON jr_owner_command_outbox FROM dcontact_app;
REVOKE DELETE ON jr_owner_result_inbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_recovery_audit FROM dcontact_app;
-- J5.0: continuation is an immutable ledger of cursor movement after the owner result
REVOKE UPDATE, DELETE ON jr_owner_continuations FROM dcontact_app;
-- J2.4: Cases ENSURE_CASE owner slice — fixture/case/link/activity/command can change state
-- but a whole row must not disappear
REVOKE DELETE ON cs_case_type_policies FROM dcontact_app;
REVOKE DELETE ON cs_routing_policies FROM dcontact_app;
REVOKE DELETE ON cs_cases FROM dcontact_app;
REVOKE DELETE ON cs_case_links FROM dcontact_app;
REVOKE UPDATE, DELETE ON cs_case_activities FROM dcontact_app;
REVOKE DELETE ON cs_command_inbox FROM dcontact_app;
-- J2.5: Dialer ADMIT_CAMPAIGN_TARGET owner slice — fixture/target/command can change state
-- but a whole row must not disappear
REVOKE DELETE ON ob_campaigns FROM dcontact_app;
REVOKE DELETE ON ob_campaign_admission_policies FROM dcontact_app;
REVOKE DELETE ON ob_campaign_targets FROM dcontact_app;
REVOKE DELETE ON ob_dialer_command_inbox FROM dcontact_app;
-- J2.6: Dialer SCHEDULE_CALLBACK owner slice — a callback can change state but a whole row must not disappear
REVOKE DELETE ON ob_callbacks FROM dcontact_app;
-- CG4.2 (#185): the blanket GRANT above gives back UPDATE/DELETE to tables that were never in
-- this array/REVOKE set before, so REVOKE again here to match the grants the migration intended,
-- otherwise cg_exception/cg_exception_approval, which should be append-only, become mutable/deletable
-- as soon as an environment runs db:rls
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
-- CG4.10 (#193): the rollout state can move but cannot be deleted; transition/shadow mismatch are append-only evidence
REVOKE DELETE ON cg4_rollout_state FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg4_rollout_transition FROM dcontact_app;
REVOKE UPDATE, DELETE ON cg4_shadow_mismatch FROM dcontact_app;
-- J3.2: a definition moves only through its lifecycle via a DB trigger; snapshot/evaluation are immutable
REVOKE DELETE ON c360_segment_definitions FROM dcontact_app;
REVOKE DELETE ON c360_segment_definition_heads FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_fact_snapshots FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_segment_evaluations FROM dcontact_app;
-- J3.3: heads/outbox are CAS state; canonical facts, receipts, audit and lineage are append-only
REVOKE DELETE ON c360_segment_membership_heads FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_segment_membership_changes FROM dcontact_app;
REVOKE DELETE ON c360_segment_membership_outbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_segment_evidence FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_evidence_access_audit FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_membership_command_receipts FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_membership_quarantine FROM dcontact_app;
REVOKE DELETE ON c360_identity_heads FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_identity_lineage FROM dcontact_app;
-- Cus360 C1 (#791): command/receipt/audit/history/custodian evidence is append-only;
-- point/tag can only retire via a DB trigger, contact tag is a current relation (detach = DELETE)
REVOKE UPDATE, DELETE ON c360_profile_commands FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_profile_command_receipts FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_profile_audits FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_contact_custodian_grants FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_contact_custodian_revocations FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_interaction_customer_changes FROM dcontact_app;
REVOKE DELETE ON c360_contact_points FROM dcontact_app;
REVOKE DELETE ON c360_tags FROM dcontact_app;
REVOKE UPDATE ON c360_contact_tags FROM dcontact_app;
REVOKE DELETE ON c360_work_mutation_auth FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_actor_capability_grants FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_actor_capability_revocations FROM dcontact_app;

-- J3.5/J3.10: bootstrap must not give back privileges to edit/delete evidence that a migration defines as append-only
REVOKE UPDATE, DELETE ON jr_segment_enrollment_intents FROM dcontact_app;
REVOKE UPDATE, DELETE ON jr_segment_shadow_mismatches FROM dcontact_app;
REVOKE DELETE ON jr_segment_rollout_state FROM dcontact_app;

-- IAM scope authority: grant/revocation is append-only evidence (see 20260917050000 /
-- 20260917050200) — bootstrap used to give back privileges the migration revoked, so revoke again here
REVOKE UPDATE, DELETE ON iam_scope_consumer_inbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON iam_team_segment_scope_grants FROM dcontact_app;

-- J2.9 (#137): rollout gate of the originate barrier — audit is append-only and state rows cannot be deleted
-- (deleting a killed row = recreating it as DISABLED, which lifts the kill switch that #124 forbids)
REVOKE DELETE ON ob_originate_rollout_state FROM dcontact_app;
REVOKE UPDATE ON ob_originate_rollout_scopes FROM dcontact_app;
REVOKE UPDATE, DELETE ON ob_originate_rollout_audit FROM dcontact_app;

-- CG5.2: keep append-only privileges after bootstrap
REVOKE UPDATE, DELETE ON cg5_alert_transition, cg5_tenant_config_audit FROM dcontact_app;
REVOKE DELETE ON cg5_tenant_config FROM dcontact_app;

-- J5.1 (#339): head/receipt/candidate/outbox/upgrade/rollout can change state but must not disappear;
-- draft/decision/audit/template version/provenance/delegation are append-only;
-- IAM authorization state is read-only from the application role (same as CG4.7)
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

-- S2.1 (#365): gate/credential/allowlist/run/cap/inbox/correlation can change state but must not disappear
-- (deleting a killed gate = recreating it as DISABLED, which lifts the kill switch); attempt receipt and
-- audit are append-only evidence
REVOKE DELETE ON dl_line_scope_gates FROM dcontact_app;
REVOKE DELETE ON dl_line_credential_refs FROM dcontact_app;
REVOKE DELETE ON dl_line_allowlist_entries FROM dcontact_app;
REVOKE DELETE ON dl_line_run_authorizations FROM dcontact_app;
REVOKE DELETE ON dl_line_cap_ledger FROM dcontact_app;
REVOKE DELETE ON dl_line_webhook_inbox FROM dcontact_app;
REVOKE DELETE ON dl_line_touch_correlations FROM dcontact_app;
REVOKE UPDATE, DELETE ON dl_provider_submission_attempts FROM dcontact_app;
REVOKE UPDATE, DELETE ON dl_line_audit_events FROM dcontact_app;
-- S2.5 (#369): a projection is evidence that a message was projected (append-only);
-- event outbox can be claimed/published but not deleted
REVOKE UPDATE, DELETE ON dl_line_inbound_messages FROM dcontact_app;
REVOKE DELETE ON dl_line_event_outbox FROM dcontact_app;
REVOKE UPDATE, DELETE ON dl_line_webhook_payloads FROM dcontact_app;
-- #567: a trial reply is evidence of who sent what (digest) to whom — append-only
REVOKE UPDATE, DELETE ON dl_line_trial_sends FROM dcontact_app;

-- A1.1 (#406): the Platform Admin control plane is not tenant data — the tenant application
-- (`dcontact_app`) must not see `pf_*` at all, while `dcontact_platform` sees only the necessary metadata
-- and has no privileges on any tenant business table (the blanket GRANT above goes only to dcontact_app)
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

-- A1.4 (#409): the invitation outbox is control plane; the tenant app must not see it
REVOKE ALL ON pf_invitations FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON pf_invitations TO dcontact_platform;

-- #388 decision "Tenant bootstrap write boundary": the saga worker writes a tenant's initial data with
-- this separate role only, and only for a tenant still PROVISIONING (the policy is in the A1.4 migration)
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

-- A1.5 (#410): the plan catalog and payload revision are control plane; the provisioner seeds the baseline
-- only for a tenant still PROVISIONING (the policy is in the A1.5 migration)
REVOKE ALL ON pf_plan_versions, pf_request_payload_revisions FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON pf_plan_versions TO dcontact_platform;
GRANT SELECT, INSERT ON pf_request_payload_revisions TO dcontact_platform;
GRANT UPDATE (name) ON tenants TO dcontact_platform;
GRANT SELECT, INSERT ON teams, queues, tenant_settings, tenant_plan_bindings, business_hours
  TO dcontact_provisioner;

-- A1.6 (#411): durable operator command is control plane
REVOKE ALL ON pf_operator_commands FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON pf_operator_commands TO dcontact_platform;

-- A1.5b (#441): the first-admin email revision is control plane
REVOKE ALL ON pf_first_admin_email_revisions FROM dcontact_app;
GRANT SELECT, INSERT ON pf_first_admin_email_revisions TO dcontact_platform;

-- D1.13 (#452): the platform operator turns `ui.shell.v2` on/off per tenant — still under tenant_isolation
-- (app.tenant_id must be set) and the audit is append-only
GRANT SELECT, INSERT, UPDATE ON tenant_ui_flags TO dcontact_platform;
GRANT SELECT, INSERT ON tenant_ui_flag_audit_events TO dcontact_platform;

-- B1: keep the operator-only policy and append-only ledger after the broad grants of apply-rls
REVOKE INSERT, UPDATE, DELETE ON tenant_voice_provisioning_policies FROM dcontact_app;
REVOKE UPDATE, DELETE ON voice_config_commands, voice_config_command_receipts, voice_config_audit FROM dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON voice_managed_queue_policies FROM dcontact_app;
GRANT INSERT ON voice_managed_queue_policies TO dcontact_app;
GRANT EXECUTE ON FUNCTION dc_voice_lock_policy_refs(uuid) TO dcontact_app;
REVOKE ALL ON FUNCTION dc_voice_lock_config_refs(uuid,uuid[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_voice_lock_config_refs(uuid,uuid[],uuid[]) TO dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON tenant_voice_policy_audit FROM dcontact_app;

-- Positive identity is operator authority; the app is read-only and remains under RLS
REVOKE INSERT, UPDATE, DELETE ON tenant_voice_identity_bindings, tenant_voice_identity_binding_audit FROM dcontact_app;

REVOKE ALL ON tenant_people_disables,tenant_people_disable_receipts,tenant_people_disable_flushes FROM dcontact_app,dcontact_tenant_people_worker;
GRANT SELECT,INSERT ON tenant_people_disables TO dcontact_app;
GRANT SELECT ON tenant_people_disable_receipts,tenant_people_disable_flushes TO dcontact_app;
GRANT SELECT ON tenant_people_disables,tenant_people_disable_receipts,tenant_people_disable_flushes TO dcontact_tenant_people_worker;
-- #998 1A: the team-move ledger is written only through dc_people_apply_team_change; the app is read-only
REVOKE ALL ON tenant_people_team_changes FROM dcontact_app;
GRANT SELECT ON tenant_people_team_changes TO dcontact_app;
-- #998 1B/2: the app inserts a command and then accepts it through dc_people_accept_account_change; the worker changes state only through the definer
REVOKE ALL ON tenant_people_account_changes,tenant_people_account_change_receipts FROM dcontact_app,dcontact_tenant_people_worker;
GRANT SELECT,INSERT ON tenant_people_account_changes TO dcontact_app;
GRANT SELECT ON tenant_people_account_change_receipts TO dcontact_app;
GRANT SELECT ON tenant_people_account_changes,tenant_people_account_change_receipts TO dcontact_tenant_people_worker;
REVOKE ALL ON tenant_people_operations, tenant_identity_reservations, tenant_user_lifecycles, tenant_people_step_receipts FROM dcontact_app;
GRANT SELECT, INSERT ON tenant_people_operations, tenant_identity_reservations, tenant_user_lifecycles TO dcontact_app;
GRANT SELECT ON tenant_people_step_receipts TO dcontact_app;

REVOKE ALL ON tenant_people_worker_bindings FROM dcontact_app;
GRANT USAGE ON SCHEMA public TO dcontact_tenant_people_worker;
GRANT SELECT ON tenant_people_worker_bindings, tenant_people_operations, tenant_identity_reservations, tenant_user_lifecycles, tenant_people_step_receipts TO dcontact_tenant_people_worker;
GRANT SELECT (id,tenant_id,keycloak_id,is_active) ON users TO dcontact_tenant_people_worker;
GRANT UPDATE (revision,state,step,attempt,fencing_token,lease_owner,lease_expires_at,error_code,updated_at) ON tenant_people_operations TO dcontact_tenant_people_worker;
GRANT UPDATE (revision,account_state,provisioning_state) ON tenant_user_lifecycles TO dcontact_tenant_people_worker;
GRANT INSERT ON tenant_people_step_receipts TO dcontact_tenant_people_worker;
REVOKE ALL ON tenant_people_invitation_intents FROM dcontact_app, dcontact_tenant_people_worker;
GRANT SELECT ON tenant_people_invitation_intents TO dcontact_app;
GRANT SELECT, INSERT ON tenant_people_invitation_intents TO dcontact_tenant_people_worker;
REVOKE ALL ON tenant_people_invitation_dispatches, tenant_people_invitation_ambiguities FROM dcontact_app, dcontact_tenant_people_worker;
GRANT SELECT ON tenant_people_invitation_dispatches, tenant_people_invitation_ambiguities TO dcontact_app;
GRANT SELECT, INSERT ON tenant_people_invitation_dispatches, tenant_people_invitation_ambiguities TO dcontact_tenant_people_worker;
REVOKE ALL ON tenant_people_invitation_receipts FROM dcontact_app, dcontact_tenant_people_worker;
GRANT SELECT ON tenant_people_invitation_receipts TO dcontact_app;
GRANT SELECT, INSERT ON tenant_people_invitation_receipts TO dcontact_tenant_people_worker;
REVOKE ALL ON FUNCTION dc_tenant_people_apply_identity_proof(uuid,uuid,bigint,uuid) FROM PUBLIC, dcontact_app;
GRANT EXECUTE ON FUNCTION dc_tenant_people_apply_identity_proof(uuid,uuid,bigint,uuid) TO dcontact_tenant_people_worker;
-- Core Settings foundation: a repeated apply-rls must not open edits to command/receipt/audit/proof
REVOKE UPDATE, DELETE, TRUNCATE ON tenant_core_commands, tenant_core_command_receipts, tenant_core_config_audits FROM dcontact_app;
REVOKE DELETE, TRUNCATE ON tenant_core_profile_revisions FROM dcontact_app;

-- Core: keep the origin of defaults after a repeated apply-rls
REVOKE DELETE,TRUNCATE ON tenant_settings FROM dcontact_app;

-- organization revision is written only through the covered-field trigger
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER ON tenant_core_profile_revisions FROM dcontact_app;
REVOKE TRIGGER ON tenants,tenant_settings,tenant_core_config_audits FROM dcontact_app;
REVOKE ALL ON FUNCTION dc_core_capture_organization_effect() FROM PUBLIC;

REVOKE ALL ON tenant_people_invitation_reconciles FROM dcontact_app,dcontact_tenant_people_worker;
GRANT SELECT ON tenant_people_invitation_reconciles TO dcontact_app;
GRANT INSERT(tenant_id,id,command_id,actor_user_id,user_id,source_operation_id,generation,provider_attempt_ref,expected_revision,status_revision,reason_code,reason) ON tenant_people_invitation_reconciles TO dcontact_app;
GRANT SELECT ON tenant_people_invitation_reconciles TO dcontact_tenant_people_worker;
GRANT UPDATE(state,revision,lease_token,lease_expires_at,error_code,updated_at) ON tenant_people_invitation_reconciles TO dcontact_tenant_people_worker;

REVOKE ALL ON tenant_people_invitation_resends FROM dcontact_app,dcontact_tenant_people_worker;
GRANT SELECT ON tenant_people_invitation_resends TO dcontact_app,dcontact_tenant_people_worker;
GRANT INSERT(tenant_id,id,command_id,actor_user_id,user_id,source_operation_id,previous_generation,previous_attempt_ref,generation,provider_attempt_ref,expected_revision,status_revision,reason_code,reason) ON tenant_people_invitation_resends TO dcontact_app;

REVOKE ALL ON tenant_people_invitation_preparations,tenant_people_invitation_preparation_proofs FROM dcontact_app,dcontact_tenant_people_worker;
GRANT SELECT ON tenant_people_invitation_preparations,tenant_people_invitation_preparation_proofs TO dcontact_app,dcontact_tenant_people_worker;
GRANT INSERT(tenant_id,resend_id,operation_id,user_id,generation,provider_attempt_ref,fencing_token,lease_owner) ON tenant_people_invitation_preparations TO dcontact_tenant_people_worker;
GRANT INSERT(tenant_id,provider_attempt_ref,intent_ref,not_before_epoch,server_epoch) ON tenant_people_invitation_preparation_proofs TO dcontact_tenant_people_worker;
GRANT SELECT(config_revision) ON users TO dcontact_tenant_people_worker;

REVOKE ALL ON tenant_people_activation_attempts,tenant_people_activation_receipts FROM dcontact_app,dcontact_tenant_people_worker;
GRANT SELECT ON tenant_people_activation_attempts,tenant_people_activation_receipts TO dcontact_app,dcontact_tenant_people_worker;
REVOKE ALL ON FUNCTION dc_people_claim_activation(uuid,uuid,uuid),dc_people_apply_activation(uuid,uuid,uuid,bigint) FROM PUBLIC,dcontact_app;
GRANT EXECUTE ON FUNCTION dc_people_claim_activation(uuid,uuid,uuid),dc_people_apply_activation(uuid,uuid,uuid,bigint) TO dcontact_tenant_people_worker;

-- Core Team revision/captured effect is writable only by the trigger and no broad UPDATE is given back after a rerun
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON teams FROM dcontact_app;
GRANT UPDATE(name,is_active) ON teams TO dcontact_app;

-- transaction-local guard evidence belongs to the DB triggers only; the app must not forge/delete the baseline
REVOKE ALL ON TABLE dc_team_reference_checks FROM PUBLIC,dcontact_app;

GRANT SELECT,INSERT,UPDATE ON voice_managed_runtime_readiness,voice_managed_calls,voice_managed_offers,voice_managed_commands TO dcontact_app;
REVOKE DELETE,TRUNCATE,TRIGGER ON voice_managed_runtime_readiness,voice_managed_calls,voice_managed_offers,voice_managed_commands FROM dcontact_app;
REVOKE ALL ON FUNCTION dc_voice_managed_runtime_ready(uuid,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_voice_managed_runtime_ready(uuid,text) TO dcontact_app;
REVOKE ALL ON FUNCTION dc_voice_managed_cleanup_pending(uuid,uuid[],uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION dc_voice_managed_cleanup_pending(uuid,uuid[],uuid[]) TO dcontact_app;

-- M3-A: a repeated apply-rls does not give back privileges to edit the service evidence
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON int_service_principals FROM dcontact_app;
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON int_service_capability_grants FROM dcontact_app;
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON int_service_capability_revocations FROM dcontact_app;
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON int_service_contact_grants FROM dcontact_app;
REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON int_service_contact_revocations FROM dcontact_app;
GRANT UPDATE(active,authz_epoch,custodian_admin_id) ON int_service_principals TO dcontact_app;

REVOKE UPDATE,DELETE,TRUNCATE,TRIGGER ON int_service_command_evidence FROM dcontact_app;
