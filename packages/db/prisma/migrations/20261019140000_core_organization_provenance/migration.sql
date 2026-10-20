ALTER TABLE tenant_settings
  ADD COLUMN initialization_source text NOT NULL DEFAULT 'PROVISIONING',
  ADD COLUMN initialized_by_user_id uuid,
  ADD COLUMN initialized_by_identity_key char(64),
  ADD COLUMN initialized_by_command_id uuid,
  ALTER COLUMN bootstrap_template_version DROP NOT NULL,
  ALTER COLUMN bootstrap_template_digest DROP NOT NULL,
  ALTER COLUMN provisioning_request_id DROP NOT NULL;
ALTER TABLE tenant_settings ADD CONSTRAINT core_settings_provenance CHECK (
  (initialization_source='PROVISIONING' AND bootstrap_template_version IS NOT NULL AND bootstrap_template_digest IS NOT NULL
    AND provisioning_request_id IS NOT NULL AND initialized_by_user_id IS NULL AND initialized_by_identity_key IS NULL AND initialized_by_command_id IS NULL)
  OR (initialization_source='CORE_ADMIN' AND bootstrap_template_version IS NULL AND bootstrap_template_digest IS NULL AND provisioning_request_id IS NULL
    AND initialized_by_user_id IS NOT NULL AND initialized_by_identity_key IS NOT NULL AND initialized_by_command_id IS NOT NULL));
ALTER TABLE tenant_settings ADD CONSTRAINT core_settings_initializer_user FOREIGN KEY(tenant_id,initialized_by_user_id) REFERENCES users(tenant_id,id);
ALTER TABLE tenant_settings ADD CONSTRAINT core_settings_initializer_command FOREIGN KEY(tenant_id,initialized_by_identity_key,initialized_by_command_id)
  REFERENCES tenant_core_commands(tenant_id,actor_identity_key,command_id);
CREATE FUNCTION dc_core_settings_origin_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF TG_OP='DELETE' OR ROW(NEW.tenant_id,NEW.initialization_source,NEW.bootstrap_template_version,NEW.bootstrap_template_digest,NEW.provisioning_request_id,NEW.initialized_by_user_id,NEW.initialized_by_identity_key,NEW.initialized_by_command_id)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.initialization_source,OLD.bootstrap_template_version,OLD.bootstrap_template_digest,OLD.provisioning_request_id,OLD.initialized_by_user_id,OLD.initialized_by_identity_key,OLD.initialized_by_command_id) THEN
    RAISE EXCEPTION 'CORE_PROVENANCE_IMMUTABLE' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER core_settings_origin_immutable BEFORE UPDATE OR DELETE ON tenant_settings FOR EACH ROW EXECUTE FUNCTION dc_core_settings_origin_immutable();
CREATE FUNCTION dc_core_settings_initializer_proof() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.initialization_source='CORE_ADMIN' AND NOT EXISTS (
    SELECT 1 FROM tenant_core_commands c JOIN tenant_core_command_receipts r USING(tenant_id,actor_identity_key,command_id)
    WHERE c.tenant_id=NEW.tenant_id AND c.actor_identity_key=NEW.initialized_by_identity_key AND c.command_id=NEW.initialized_by_command_id
      AND c.actor_user_id=NEW.initialized_by_user_id AND c.action='ORGANIZATION_UPDATE' AND c.resource_id=NEW.tenant_id AND r.outcome='APPLIED'
  ) THEN RAISE EXCEPTION 'CORE_INITIALIZER_PROOF_REQUIRED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER core_settings_initializer_proof AFTER INSERT ON tenant_settings DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_core_settings_initializer_proof();
REVOKE DELETE,TRUNCATE ON tenant_settings FROM dcontact_app;
