CREATE TABLE tenant_people_invitation_receipts (
  tenant_id uuid NOT NULL,
  provider_attempt_ref uuid NOT NULL,
  outcome text NOT NULL CHECK(outcome IN ('SENT','FAILED')),
  receipt_ref text NOT NULL CHECK(receipt_ref ~ '^[a-f0-9]{64}$'),
  quiescent boolean NOT NULL CHECK(quiescent),
  not_before_epoch bigint,
  issued_at_epoch bigint,
  expires_at_epoch bigint GENERATED ALWAYS AS (issued_at_epoch+259200) STORED,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(tenant_id,provider_attempt_ref),
  FOREIGN KEY(tenant_id,provider_attempt_ref)
    REFERENCES tenant_people_invitation_dispatches(tenant_id,provider_attempt_ref),
  CHECK((outcome='FAILED' AND issued_at_epoch IS NULL AND not_before_epoch IS NULL)
    OR (outcome='SENT' AND issued_at_epoch IS NOT NULL AND not_before_epoch IS NOT NULL
      AND not_before_epoch>0 AND issued_at_epoch>=not_before_epoch AND issued_at_epoch<=253402041599))
);
ALTER TABLE tenant_people_invitation_receipts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_people_invitation_receipts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_people_invitation_receipts
  USING(tenant_id=current_setting('app.tenant_id',true)::uuid)
  WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
CREATE POLICY worker_binding_required ON tenant_people_invitation_receipts AS RESTRICTIVE TO dcontact_tenant_people_worker
  USING(EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=tenant_people_invitation_receipts.tenant_id AND b.database_principal=session_user AND b.enabled))
  WITH CHECK(EXISTS(SELECT 1 FROM tenant_people_worker_bindings b WHERE b.tenant_id=tenant_people_invitation_receipts.tenant_id AND b.database_principal=session_user AND b.enabled));
CREATE TRIGGER invitation_receipt_immutable BEFORE UPDATE OR DELETE ON tenant_people_invitation_receipts
  FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();
