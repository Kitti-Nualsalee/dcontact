-- M2 #837: metadata เท่านั้น; raw CSV อยู่ใน purpose-bound private object storage
CREATE TABLE c360_import_jobs (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  owner_user_id uuid NOT NULL,
  actor_identity_key text NOT NULL,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  state text NOT NULL CHECK (state IN ('UPLOADING','DRAFT','READY','QUEUED','RUNNING','COMPLETED','COMPLETED_WITH_ERRORS','PAUSING','PAUSED_USER','PAUSED_AUTH','CANCEL_REQUESTED','CANCELLED','EXPIRED','FAILED_SYSTEM')),
  source_object_id uuid NOT NULL,
  source_digest char(64),
  source_bytes integer CHECK (source_bytes BETWEEN 0 AND 5242880),
  mapping jsonb,
  rules_version text,
  confirmed_plan_hash char(64),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  source_expires_at timestamptz(6) NOT NULL,
  terminal_at timestamptz(6),
  report_expires_at timestamptz(6),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT c360_import_jobs_owner_key UNIQUE (tenant_id, id, owner_user_id),
  FOREIGN KEY (tenant_id, owner_user_id) REFERENCES users (tenant_id, id),
  CHECK (source_digest IS NULL OR source_digest ~ '^[0-9a-f]{64}$'),
  CHECK (confirmed_plan_hash IS NULL OR confirmed_plan_hash ~ '^[0-9a-f]{64}$'),
  CHECK (source_expires_at <= created_at + interval '24 hours'),
  CHECK (report_expires_at IS NULL OR (terminal_at IS NOT NULL AND report_expires_at <= terminal_at + interval '7 days')),
  CHECK (mapping IS NULL OR jsonb_typeof(mapping) = 'object')
);
CREATE INDEX c360_import_jobs_owner_idx ON c360_import_jobs (tenant_id, owner_user_id, state, created_at, id);

CREATE TABLE c360_import_rows (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  row_no integer NOT NULL CHECK (row_no BETWEEN 1 AND 10000),
  child_command_id uuid NOT NULL,
  plan_version bigint NOT NULL DEFAULT 0 CHECK (plan_version >= 0),
  state text NOT NULL CHECK (state IN ('NOT_SELECTED','READY','CLAIMED','PENDING','APPLIED','REJECTED')),
  lease_epoch bigint NOT NULL DEFAULT 0 CHECK (lease_epoch >= 0),
  lease_expires_at timestamptz(6),
  terminal_ref jsonb,
  PRIMARY KEY (tenant_id, job_id, row_no),
  CONSTRAINT c360_import_rows_command_key UNIQUE (tenant_id, child_command_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES c360_import_jobs (tenant_id, id)
);
CREATE INDEX c360_import_rows_state_idx ON c360_import_rows (tenant_id, job_id, state, row_no);

CREATE TABLE c360_import_delegations (
  tenant_id uuid NOT NULL,
  job_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  confirmed_plan_hash char(64) NOT NULL CHECK (confirmed_plan_hash ~ '^[0-9a-f]{64}$'),
  authorization_epoch bigint NOT NULL CHECK (authorization_epoch >= 0),
  expires_at timestamptz(6) NOT NULL,
  revoked_at timestamptz(6),
  PRIMARY KEY (tenant_id, job_id, authorization_epoch),
  FOREIGN KEY (tenant_id, job_id, actor_user_id) REFERENCES c360_import_jobs (tenant_id, id, owner_user_id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id)
);

CREATE TABLE c360_import_control_audits (
  tenant_id uuid NOT NULL,
  id uuid NOT NULL,
  job_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  command_id uuid NOT NULL,
  action text NOT NULL,
  created_at timestamptz(6) NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, id),
  CONSTRAINT c360_import_control_command_key UNIQUE (tenant_id, job_id, command_id),
  FOREIGN KEY (tenant_id, job_id) REFERENCES c360_import_jobs (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id)
);

-- terminal row และ child command identity ห้ามเปลี่ยนภายหลัง ไม่ว่า worker รุ่นใดจะกลับมาช้า
CREATE FUNCTION c360_import_row_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.job_id, NEW.row_no, NEW.child_command_id) IS DISTINCT FROM
     (OLD.tenant_id, OLD.job_id, OLD.row_no, OLD.child_command_id) OR
     (OLD.state IN ('APPLIED', 'REJECTED') AND NEW IS DISTINCT FROM OLD) THEN
    RAISE EXCEPTION 'import row identity or terminal state is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c360_import_row_immutable BEFORE UPDATE ON c360_import_rows
  FOR EACH ROW EXECUTE FUNCTION c360_import_row_immutable();

CREATE FUNCTION c360_import_job_identity_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.id, NEW.owner_user_id, NEW.actor_identity_key, NEW.source_object_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.id, OLD.owner_user_id, OLD.actor_identity_key, OLD.source_object_id, OLD.created_at) THEN
    RAISE EXCEPTION 'import job identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.source_expires_at > OLD.source_expires_at OR
     (OLD.terminal_at IS NOT NULL AND NEW.terminal_at IS DISTINCT FROM OLD.terminal_at) OR
     (OLD.report_expires_at IS NOT NULL AND
       (NEW.report_expires_at IS NULL OR NEW.report_expires_at > OLD.report_expires_at)) THEN
    RAISE EXCEPTION 'import retention deadline cannot be extended' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c360_import_job_identity_immutable BEFORE UPDATE ON c360_import_jobs
  FOR EACH ROW EXECUTE FUNCTION c360_import_job_identity_immutable();

CREATE FUNCTION c360_import_delegation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.tenant_id, NEW.job_id, NEW.actor_user_id, NEW.confirmed_plan_hash, NEW.authorization_epoch, NEW.expires_at)
     IS DISTINCT FROM
     (OLD.tenant_id, OLD.job_id, OLD.actor_user_id, OLD.confirmed_plan_hash, OLD.authorization_epoch, OLD.expires_at)
     OR (OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS DISTINCT FROM OLD.revoked_at) THEN
    RAISE EXCEPTION 'import delegation is immutable except first revoke' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER c360_import_delegation_immutable BEFORE UPDATE ON c360_import_delegations
  FOR EACH ROW EXECUTE FUNCTION c360_import_delegation_immutable();

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['c360_import_jobs','c360_import_rows','c360_import_delegations','c360_import_control_audits'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')::uuid)', t);
  END LOOP;
END $$;
GRANT SELECT, INSERT, UPDATE, DELETE ON c360_import_jobs, c360_import_rows, c360_import_delegations, c360_import_control_audits TO dcontact_app;
REVOKE DELETE ON c360_import_jobs, c360_import_rows, c360_import_delegations FROM dcontact_app;
REVOKE UPDATE, DELETE ON c360_import_control_audits FROM dcontact_app;
