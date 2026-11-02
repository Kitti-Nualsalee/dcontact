-- Cus360 C1 (#791) S3: "Cus360 create capability" ตาม R1 C — สิทธิ์ระดับผู้ใช้ที่ operator ให้พร้อมหลักฐาน
-- ไม่มี self-grant และไม่ได้มาจาก role; ถอนด้วย revocation แบบ append-only

CREATE TABLE c360_actor_capability_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  grantee_user_id uuid NOT NULL,
  capability text NOT NULL,
  evidence_ref text NOT NULL,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT c360_actor_capability_grants_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT c360_actor_capability_grants_grantee_fkey FOREIGN KEY (tenant_id, grantee_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_actor_capability_grants_actor_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_actor_capability_grants_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_actor_capability_grants_capability_check CHECK (capability IN ('CONTACT_CREATE')),
  CONSTRAINT c360_actor_capability_grants_evidence_check CHECK (evidence_ref <> ''),
  CONSTRAINT c360_actor_capability_grants_self_check CHECK (actor_user_id IS DISTINCT FROM grantee_user_id)
);
CREATE INDEX c360_actor_capability_grants_grantee_idx
  ON c360_actor_capability_grants (tenant_id, grantee_user_id, capability);

CREATE TABLE c360_actor_capability_revocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid,
  reason text NOT NULL,
  evidence_ref text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT c360_actor_capability_revocations_grant_key UNIQUE (tenant_id, grant_id),
  CONSTRAINT c360_actor_capability_revocations_grant_fkey FOREIGN KEY (tenant_id, grant_id)
    REFERENCES c360_actor_capability_grants (tenant_id, id),
  CONSTRAINT c360_actor_capability_revocations_actor_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_actor_capability_revocations_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_actor_capability_revocations_reason_check CHECK (reason <> '' AND evidence_ref <> '')
);

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['c360_actor_capability_grants', 'c360_actor_capability_revocations']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT ON %I TO dcontact_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON c360_actor_capability_grants, c360_actor_capability_revocations FROM dcontact_app;
