-- ผูก effect ของ revision ที่ foundation เปิดให้ app เขียน กับหลักฐานใน transaction เดียวกัน
-- ใช้ top-level transaction ID เพราะ xmin เปลี่ยนได้เมื่อ effect อยู่ใน SAVEPOINT
ALTER TABLE tenant_core_config_audits ADD COLUMN transaction_id bigint NOT NULL DEFAULT txid_current();
CREATE FUNCTION dc_core_audit_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN NEW.transaction_id := txid_current(); RETURN NEW; END $$;
CREATE TRIGGER core_audit_transaction BEFORE INSERT ON tenant_core_config_audits
  FOR EACH ROW EXECUTE FUNCTION dc_core_audit_transaction();
CREATE FUNCTION dc_core_profile_effect_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE prior_revision bigint; BEGIN
  prior_revision := CASE WHEN TG_OP='INSERT' THEN 0 ELSE OLD.revision END;
  IF NOT EXISTS (
    SELECT 1 FROM tenant_core_config_audits a
    JOIN tenant_core_command_receipts r USING(tenant_id,actor_identity_key,command_id)
    JOIN tenant_core_commands c USING(tenant_id,actor_identity_key,command_id)
    WHERE a.tenant_id=NEW.tenant_id AND a.resource_type='ORGANIZATION'
      AND a.resource_id=NEW.tenant_id AND a.action='ORGANIZATION_UPDATE'
      AND a.before_revision=prior_revision AND a.after_revision=NEW.revision
      AND c.expected_revision=prior_revision AND r.outcome='APPLIED'
      AND r.committed_revision=NEW.revision
      AND a.transaction_id=txid_current()
  ) THEN
    RAISE EXCEPTION 'CORE_PROFILE_EFFECT_RECEIPT_REQUIRED' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER core_profile_effect_receipt
  AFTER INSERT OR UPDATE ON tenant_core_profile_revisions
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION dc_core_profile_effect_receipt();
