-- B1: positive binding ของ bootstrap/enrollment เดิม; ไม่ adopt จาก Org หรือ role เพียงอย่างเดียว
CREATE TABLE tenant_voice_identity_bindings (
  tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL REFERENCES users(id),
  issuer text NOT NULL CHECK(length(btrim(issuer))>0), subject_id text NOT NULL CHECK(length(btrim(subject_id))>0),
  client_id text NOT NULL CHECK(length(btrim(client_id))>0), tenant_slug text NOT NULL CHECK(length(btrim(tenant_slug))>0),
  organization_id uuid NOT NULL,
  identity_class text NOT NULL CHECK(identity_class='TENANT_USER'),
  source_kind text NOT NULL CHECK(source_kind IN ('BOOTSTRAP_MANIFEST','VERIFIED_ENROLLMENT')),
  evidence_ref text NOT NULL CHECK(length(btrim(evidence_ref))>0),
  evidence_digest text NOT NULL CHECK(evidence_digest ~ '^[a-f0-9]{64}$'),
  verified_by_operator_subject text NOT NULL CHECK(length(btrim(verified_by_operator_subject))>0),
  verified_at timestamptz NOT NULL, revision integer NOT NULL CHECK(revision>=1), is_active boolean NOT NULL,
  PRIMARY KEY(tenant_id,user_id), UNIQUE(issuer,subject_id)
);
CREATE TABLE tenant_voice_identity_binding_audit (
  tenant_id uuid NOT NULL REFERENCES tenants(id), user_id uuid NOT NULL, revision integer NOT NULL,
  binding jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(tenant_id,user_id,revision)
);
ALTER TABLE tenant_voice_identity_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_voice_identity_binding_audit ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_voice_identity_bindings USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
CREATE POLICY tenant_isolation ON tenant_voice_identity_binding_audit USING(tenant_id=current_setting('app.tenant_id',true)::uuid) WITH CHECK(tenant_id=current_setting('app.tenant_id',true)::uuid);
CREATE TRIGGER voice_identity_audit_immutable BEFORE UPDATE OR DELETE ON tenant_voice_identity_binding_audit FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();
CREATE FUNCTION dc_voice_identity_binding_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'VOICE_IDENTITY_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||NEW.tenant_id::text,0)) THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  IF TG_OP='UPDATE' THEN
    IF NEW.tenant_id<>OLD.tenant_id OR NEW.user_id<>OLD.user_id OR NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  ELSIF NEW.revision<>1 THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  PERFORM id FROM users WHERE tenant_id=NEW.tenant_id AND id=NEW.user_id AND keycloak_id::text=NEW.subject_id FOR UPDATE NOWAIT;
  IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM tenants WHERE id=NEW.tenant_id AND slug=NEW.tenant_slug) THEN RAISE EXCEPTION 'REFERENCE_SCOPE_MISMATCH' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM interactions WHERE tenant_id=NEW.tenant_id AND channel='VOICE' AND state IN ('QUEUED','ASSIGNED','ACTIVE','WRAPUP')) THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  INSERT INTO tenant_voice_identity_binding_audit(tenant_id,user_id,revision,binding) VALUES(NEW.tenant_id,NEW.user_id,NEW.revision,to_jsonb(NEW));
  RETURN NEW;
END $$;
CREATE TRIGGER voice_identity_binding_change BEFORE INSERT OR UPDATE OR DELETE ON tenant_voice_identity_bindings FOR EACH ROW EXECUTE FUNCTION dc_voice_identity_binding_change();
