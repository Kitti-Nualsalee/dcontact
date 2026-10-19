-- Core Settings งานฐาน: ไม่มี raw draft/token/secret ใน durable command admission
CREATE UNIQUE INDEX users_tenant_id_id_key ON users(tenant_id,id);
CREATE TABLE tenant_core_commands (
  tenant_id uuid NOT NULL REFERENCES tenants(id), actor_identity_key char(64) NOT NULL CHECK(actor_identity_key ~ '^[a-f0-9]{64}$'),
  command_id uuid NOT NULL, actor_user_id uuid NOT NULL, schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1),
  action text, resource_type text, resource_id uuid, payload_digest char(64), expected_revision bigint,
  is_tombstone boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,actor_identity_key,command_id),
  FOREIGN KEY(tenant_id,actor_user_id) REFERENCES users(tenant_id,id),
  CHECK ((is_tombstone AND action IS NULL AND resource_type IS NULL AND resource_id IS NULL AND payload_digest IS NULL AND expected_revision IS NULL)
    OR (NOT is_tombstone AND action IS NOT NULL AND resource_type IS NOT NULL AND resource_id IS NOT NULL AND payload_digest IS NOT NULL
      AND payload_digest ~ '^[a-f0-9]{64}$' AND (
        (action='ORGANIZATION_UPDATE' AND resource_type='ORGANIZATION' AND resource_id=tenant_id AND expected_revision IS NOT NULL AND expected_revision>=0)
        OR (action='TEAM_CREATE' AND resource_type='TEAM' AND expected_revision IS NULL)
        OR (action IN ('TEAM_RENAME','TEAM_DEACTIVATE') AND resource_type='TEAM' AND expected_revision IS NOT NULL AND expected_revision>=1))))
);
CREATE INDEX tenant_core_commands_resource ON tenant_core_commands(tenant_id,resource_type,resource_id,created_at);
CREATE TABLE tenant_core_command_receipts (
  tenant_id uuid NOT NULL, actor_identity_key char(64) NOT NULL, command_id uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('APPLIED','NO_OP','REJECTED','NOT_APPLIED')),
  committed_revision bigint, resource_snapshot jsonb, http_status integer NOT NULL, error jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,actor_identity_key,command_id),
  FOREIGN KEY(tenant_id,actor_identity_key,command_id) REFERENCES tenant_core_commands(tenant_id,actor_identity_key,command_id),
  CHECK((outcome IN ('APPLIED','NO_OP') AND committed_revision IS NOT NULL AND committed_revision>=0 AND resource_snapshot IS NOT NULL AND jsonb_typeof(resource_snapshot)='object' AND error IS NULL AND http_status IN (200,201))
    OR (outcome='REJECTED' AND committed_revision IS NULL AND resource_snapshot IS NULL AND error IS NOT NULL AND http_status IN (404,409,422))
    OR (outcome='NOT_APPLIED' AND committed_revision IS NULL AND resource_snapshot IS NULL AND error IS NULL AND http_status=409))
);
CREATE TABLE tenant_core_config_audits (
  id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id), actor_identity_key char(64) NOT NULL,
  command_id uuid NOT NULL, actor_user_id uuid NOT NULL, action text NOT NULL, resource_type text NOT NULL, resource_id uuid NOT NULL,
  before_revision bigint, after_revision bigint NOT NULL, before_values jsonb, after_values jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(tenant_id,actor_identity_key,command_id),
  FOREIGN KEY(tenant_id,actor_identity_key,command_id) REFERENCES tenant_core_commands(tenant_id,actor_identity_key,command_id),
  CHECK ((before_revision IS NULL AND after_revision=1 AND before_values IS NULL)
    OR (before_revision IS NOT NULL AND before_revision>=0 AND after_revision=before_revision+1 AND before_values IS NOT NULL)),
  CHECK(jsonb_typeof(after_values)='object' AND after_values IS DISTINCT FROM before_values)
);
CREATE INDEX tenant_core_audit_resource ON tenant_core_config_audits(tenant_id,resource_type,resource_id,created_at,id);
CREATE TABLE tenant_core_profile_revisions (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id), revision bigint NOT NULL CHECK(revision>0)
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['tenant_core_commands','tenant_core_command_receipts','tenant_core_config_audits','tenant_core_profile_revisions'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid) WITH CHECK(tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')::uuid)',t);
  END LOOP;
END $$;
CREATE FUNCTION dc_core_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'CORE_APPEND_ONLY' USING ERRCODE='23514'; END $$;
CREATE TRIGGER core_command_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON tenant_core_commands FOR EACH STATEMENT EXECUTE FUNCTION dc_core_append_only();
CREATE TRIGGER core_receipt_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON tenant_core_command_receipts FOR EACH STATEMENT EXECUTE FUNCTION dc_core_append_only();
CREATE TRIGGER core_audit_immutable BEFORE UPDATE OR DELETE OR TRUNCATE ON tenant_core_config_audits FOR EACH STATEMENT EXECUTE FUNCTION dc_core_append_only();
-- ADMITTED command ไม่มี receipt ได้; tombstone และ resource/audit effects ต้องมี terminal proof
CREATE FUNCTION dc_core_terminal_invariant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c tenant_core_commands; r tenant_core_command_receipts; a tenant_core_config_audits; BEGIN
  SELECT * INTO c FROM tenant_core_commands WHERE tenant_id=NEW.tenant_id AND actor_identity_key=NEW.actor_identity_key AND command_id=NEW.command_id;
  SELECT * INTO r FROM tenant_core_command_receipts WHERE tenant_id=NEW.tenant_id AND actor_identity_key=NEW.actor_identity_key AND command_id=NEW.command_id;
  SELECT * INTO a FROM tenant_core_config_audits WHERE tenant_id=NEW.tenant_id AND actor_identity_key=NEW.actor_identity_key AND command_id=NEW.command_id;
  IF c.is_tombstone AND (r.outcome IS DISTINCT FROM 'NOT_APPLIED' OR a.id IS NOT NULL) THEN RAISE EXCEPTION 'CORE_TOMBSTONE_RECEIPT_REQUIRED' USING ERRCODE='23514'; END IF;
  IF a.id IS NOT NULL AND (r.outcome IS DISTINCT FROM 'APPLIED' OR c.actor_user_id IS DISTINCT FROM a.actor_user_id
    OR c.action IS DISTINCT FROM a.action OR c.resource_type IS DISTINCT FROM a.resource_type OR c.resource_id IS DISTINCT FROM a.resource_id
    OR c.expected_revision IS DISTINCT FROM a.before_revision OR r.committed_revision IS DISTINCT FROM a.after_revision OR r.resource_snapshot IS DISTINCT FROM a.after_values) THEN
    RAISE EXCEPTION 'CORE_AUDIT_RECEIPT_MISMATCH' USING ERRCODE='23514'; END IF;
  IF r.outcome='APPLIED' AND a.id IS NULL THEN RAISE EXCEPTION 'CORE_AUDIT_REQUIRED' USING ERRCODE='23514'; END IF;
  IF r.outcome='NO_OP' AND (c.action='TEAM_CREATE' OR r.committed_revision IS DISTINCT FROM c.expected_revision OR a.id IS NOT NULL) THEN RAISE EXCEPTION 'CORE_NO_OP_REVISION_MISMATCH' USING ERRCODE='23514'; END IF;
  IF r.outcome IN ('APPLIED','NO_OP') AND (r.resource_snapshot->>'revision') IS DISTINCT FROM r.committed_revision::text THEN RAISE EXCEPTION 'CORE_SNAPSHOT_REVISION_MISMATCH' USING ERRCODE='23514'; END IF;
  IF r.outcome IN ('APPLIED','NO_OP') AND (r.resource_snapshot->>'id') IS DISTINCT FROM c.resource_id::text THEN RAISE EXCEPTION 'CORE_SNAPSHOT_RESOURCE_MISMATCH' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER core_command_terminal AFTER INSERT ON tenant_core_commands DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_core_terminal_invariant();
CREATE CONSTRAINT TRIGGER core_receipt_terminal AFTER INSERT ON tenant_core_command_receipts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_core_terminal_invariant();
CREATE CONSTRAINT TRIGGER core_audit_terminal AFTER INSERT ON tenant_core_config_audits DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_core_terminal_invariant();
CREATE FUNCTION dc_core_profile_revision_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' OR (TG_OP='UPDATE' AND (NEW.tenant_id<>OLD.tenant_id OR NEW.revision<>OLD.revision+1)) OR (TG_OP='INSERT' AND NEW.revision<>1) THEN
    RAISE EXCEPTION 'CORE_REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_profile_revision_guard BEFORE INSERT OR UPDATE OR DELETE ON tenant_core_profile_revisions FOR EACH ROW EXECUTE FUNCTION dc_core_profile_revision_guard();
DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='dcontact_app') THEN
  GRANT SELECT,INSERT ON tenant_core_commands,tenant_core_command_receipts,tenant_core_config_audits TO dcontact_app;
  GRANT SELECT,INSERT,UPDATE ON tenant_core_profile_revisions TO dcontact_app;
END IF; END $$;
