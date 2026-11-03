-- M3-A #841: principal ไม่ใช่ User และไม่มี implicit tenant-wide grant
CREATE TABLE int_service_principals (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES tenants(id),
 issuer text NOT NULL CHECK (length(issuer) BETWEEN 1 AND 512),
 subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 512),
 client_id text NOT NULL CHECK (length(client_id) BETWEEN 1 AND 256),
 service_actor_identity_key text NOT NULL CHECK(service_actor_identity_key ~ '^[0-9a-f]{64}$'),
 custodian_admin_id uuid NOT NULL, active boolean NOT NULL DEFAULT true,
 authz_epoch bigint NOT NULL DEFAULT 0 CHECK (authz_epoch >= 0),
 evidence_ref text NOT NULL CHECK (evidence_ref <> ''), actor_identity_key text NOT NULL,
 command_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,issuer,subject,client_id),
 FOREIGN KEY(tenant_id,custodian_admin_id) REFERENCES users(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_identity_key,command_id) REFERENCES c360_profile_commands(tenant_id,actor_identity_key,command_id)
);
CREATE FUNCTION int_service_principal_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.service_actor_identity_key,NEW.id,NEW.tenant_id,NEW.issuer,NEW.subject,NEW.client_id,NEW.created_at,NEW.actor_identity_key,NEW.command_id,NEW.evidence_ref)
 IS DISTINCT FROM (OLD.service_actor_identity_key,OLD.id,OLD.tenant_id,OLD.issuer,OLD.subject,OLD.client_id,OLD.created_at,OLD.actor_identity_key,OLD.command_id,OLD.evidence_ref)
 OR NEW.authz_epoch <> OLD.authz_epoch + 1 OR (NOT OLD.active AND NEW.active) THEN
 RAISE EXCEPTION 'SERVICE_PRINCIPAL_IMMUTABLE_OR_EPOCH'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER int_service_principal_guard BEFORE UPDATE ON int_service_principals FOR EACH ROW EXECUTE FUNCTION int_service_principal_guard();
CREATE FUNCTION int_service_evidence_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'SERVICE_EVIDENCE_APPEND_ONLY'; END $$;
CREATE TABLE int_service_capability_grants (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL, capability text NOT NULL CHECK (capability = 'CONTACT_CREATE'),
 evidence_ref text NOT NULL CHECK(evidence_ref<>''), actor_identity_key text NOT NULL, command_id uuid NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES int_service_principals(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_identity_key,command_id) REFERENCES c360_profile_commands(tenant_id,actor_identity_key,command_id)
);
CREATE INDEX int_service_capability_grantee_idx ON int_service_capability_grants(tenant_id,principal_id);
CREATE TABLE int_service_capability_revocations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, grant_id uuid NOT NULL,
 evidence_ref text NOT NULL CHECK(evidence_ref<>''), reason_code text NOT NULL,
 actor_identity_key text NOT NULL, command_id uuid NOT NULL, revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,grant_id), FOREIGN KEY(tenant_id,grant_id) REFERENCES int_service_capability_grants(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_identity_key,command_id) REFERENCES c360_profile_commands(tenant_id,actor_identity_key,command_id)
);
CREATE TABLE int_service_contact_grants (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, principal_id uuid NOT NULL, contact_id uuid NOT NULL, permission text NOT NULL CHECK (permission = 'READ'),
 evidence_ref text NOT NULL CHECK(evidence_ref<>''), actor_identity_key text NOT NULL, command_id uuid NOT NULL,
 granted_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,id),
 FOREIGN KEY(tenant_id,principal_id) REFERENCES int_service_principals(tenant_id,id), FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_identity_key,command_id) REFERENCES c360_profile_commands(tenant_id,actor_identity_key,command_id)
);
CREATE INDEX int_service_contact_grantee_idx ON int_service_contact_grants(tenant_id,principal_id);
CREATE TABLE int_service_contact_revocations (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, grant_id uuid NOT NULL,
 evidence_ref text NOT NULL CHECK(evidence_ref<>''), reason_code text NOT NULL,
 actor_identity_key text NOT NULL, command_id uuid NOT NULL, revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,grant_id), FOREIGN KEY(tenant_id,grant_id) REFERENCES int_service_contact_grants(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_identity_key,command_id) REFERENCES c360_profile_commands(tenant_id,actor_identity_key,command_id)
);
ALTER TABLE c360_contact_custodian_grants DROP CONSTRAINT c360_contact_custodian_grants_origin_check;
ALTER TABLE c360_contact_custodian_grants ADD CONSTRAINT c360_contact_custodian_grants_origin_check CHECK(origin IN ('CREATOR','OPERATOR','INTEGRATION'));
ALTER TABLE c360_contact_custodian_grants ADD COLUMN integration_principal_id uuid;
ALTER TABLE c360_contact_custodian_grants ADD CONSTRAINT c360_integration_principal_fkey FOREIGN KEY(tenant_id,integration_principal_id) REFERENCES int_service_principals(tenant_id,id);
ALTER TABLE c360_contact_custodian_grants ADD CONSTRAINT c360_integration_provenance_check CHECK((origin='INTEGRATION')=(integration_principal_id IS NOT NULL));
ALTER TABLE int_service_principals ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON int_service_principals USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON int_service_principals TO dcontact_app;
GRANT UPDATE(active,authz_epoch,custodian_admin_id) ON int_service_principals TO dcontact_app;
REVOKE DELETE,TRUNCATE,TRIGGER ON int_service_principals FROM dcontact_app;
ALTER TABLE int_service_capability_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON int_service_capability_grants USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON int_service_capability_grants TO dcontact_app;
CREATE TRIGGER int_service_capability_grants_immutable BEFORE UPDATE OR DELETE ON int_service_capability_grants FOR EACH ROW EXECUTE FUNCTION int_service_evidence_immutable();
REVOKE DELETE,TRUNCATE,TRIGGER ON int_service_capability_grants FROM dcontact_app;
ALTER TABLE int_service_capability_revocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON int_service_capability_revocations USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON int_service_capability_revocations TO dcontact_app;
CREATE TRIGGER int_service_capability_revocations_immutable BEFORE UPDATE OR DELETE ON int_service_capability_revocations FOR EACH ROW EXECUTE FUNCTION int_service_evidence_immutable();
REVOKE DELETE,TRUNCATE,TRIGGER ON int_service_capability_revocations FROM dcontact_app;
ALTER TABLE int_service_contact_grants ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON int_service_contact_grants USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON int_service_contact_grants TO dcontact_app;
CREATE TRIGGER int_service_contact_grants_immutable BEFORE UPDATE OR DELETE ON int_service_contact_grants FOR EACH ROW EXECUTE FUNCTION int_service_evidence_immutable();
REVOKE DELETE,TRUNCATE,TRIGGER ON int_service_contact_grants FROM dcontact_app;
ALTER TABLE int_service_contact_revocations ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON int_service_contact_revocations USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON int_service_contact_revocations TO dcontact_app;
CREATE TRIGGER int_service_contact_revocations_immutable BEFORE UPDATE OR DELETE ON int_service_contact_revocations FOR EACH ROW EXECUTE FUNCTION int_service_evidence_immutable();
REVOKE DELETE,TRUNCATE,TRIGGER ON int_service_contact_revocations FROM dcontact_app;

CREATE TRIGGER int_service_principal_no_delete BEFORE DELETE ON int_service_principals FOR EACH ROW EXECUTE FUNCTION int_service_evidence_immutable();
CREATE TABLE int_service_command_evidence (
 tenant_id uuid NOT NULL, actor_identity_key text NOT NULL, command_id uuid NOT NULL,
 principal_id uuid NOT NULL, contact_id uuid NOT NULL, purpose text NOT NULL CHECK(purpose='CONTACT_CREATE'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,actor_identity_key,command_id),
 UNIQUE(tenant_id,contact_id), FOREIGN KEY(tenant_id,principal_id) REFERENCES int_service_principals(tenant_id,id),
 FOREIGN KEY(tenant_id,contact_id) REFERENCES contacts(tenant_id,id),
 FOREIGN KEY(tenant_id,actor_identity_key,command_id) REFERENCES c360_profile_commands(tenant_id,actor_identity_key,command_id)
);
ALTER TABLE int_service_command_evidence ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON int_service_command_evidence USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
GRANT SELECT,INSERT ON int_service_command_evidence TO dcontact_app;
CREATE TRIGGER int_service_command_evidence_immutable BEFORE UPDATE OR DELETE ON int_service_command_evidence FOR EACH ROW EXECUTE FUNCTION int_service_evidence_immutable();
CREATE FUNCTION int_service_command_purpose_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM int_service_principals p JOIN c360_profile_commands c
 ON c.tenant_id=p.tenant_id AND c.actor_identity_key=p.service_actor_identity_key
 WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.principal_id AND p.active
 AND c.command_id=NEW.command_id AND c.actor_identity_key=NEW.actor_identity_key AND c.actor_user_id IS NULL
 AND NOT c.is_tombstone AND c.action='CONTACT_CREATE' AND c.resource_type='CONTACT'
 AND (c.resource_id IS NULL OR c.resource_id=NEW.contact_id)) THEN
 RAISE EXCEPTION 'SERVICE_CREATE_PURPOSE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER int_service_command_purpose_guard BEFORE INSERT ON int_service_command_evidence FOR EACH ROW EXECUTE FUNCTION int_service_command_purpose_guard();
CREATE FUNCTION c360_integration_custody_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.origin='INTEGRATION' AND NOT EXISTS (
  SELECT 1 FROM int_service_principals p JOIN c360_profile_commands c
   ON c.tenant_id=p.tenant_id AND c.actor_identity_key=p.service_actor_identity_key
  WHERE p.tenant_id=NEW.tenant_id AND p.id=NEW.integration_principal_id AND p.active
   AND p.custodian_admin_id=NEW.grantee_user_id AND NEW.permission='MANAGE'
   AND NEW.actor_user_id IS NULL AND c.actor_user_id IS NULL
   AND c.command_id=NEW.command_id AND c.actor_identity_key=NEW.actor_identity_key
   AND NOT c.is_tombstone AND c.action='CONTACT_CREATE' AND c.resource_type='CONTACT'
   AND (c.resource_id IS NULL OR c.resource_id=NEW.contact_id)
   AND EXISTS(SELECT 1 FROM int_service_command_evidence e WHERE e.tenant_id=NEW.tenant_id AND e.actor_identity_key=NEW.actor_identity_key AND e.command_id=NEW.command_id AND e.principal_id=p.id AND e.contact_id=NEW.contact_id AND e.purpose='CONTACT_CREATE')
   AND EXISTS(SELECT 1 FROM users u WHERE u.tenant_id=p.tenant_id AND u.id=p.custodian_admin_id AND u.is_active AND u.role::text='ADMIN')
   AND EXISTS(SELECT 1 FROM int_service_capability_grants g WHERE g.tenant_id=p.tenant_id AND g.principal_id=p.id
    AND NOT EXISTS(SELECT 1 FROM int_service_capability_revocations r WHERE r.tenant_id=g.tenant_id AND r.grant_id=g.id))
 ) THEN RAISE EXCEPTION 'INTEGRATION_CUSTODY_EVIDENCE_REQUIRED'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER c360_integration_custody_guard BEFORE INSERT ON c360_contact_custodian_grants FOR EACH ROW EXECUTE FUNCTION c360_integration_custody_guard();
