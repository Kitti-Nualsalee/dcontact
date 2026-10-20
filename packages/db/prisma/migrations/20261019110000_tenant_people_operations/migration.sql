CREATE UNIQUE INDEX IF NOT EXISTS users_tenant_id_id_key ON users(tenant_id,id);

CREATE TABLE tenant_people_operations (
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  id uuid NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  action text NOT NULL CHECK(action='CREATE_TENANT_USER'),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  request_payload jsonb NOT NULL CHECK(jsonb_typeof(request_payload)='object'),
  correlation_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
  state text NOT NULL DEFAULT 'QUEUED' CHECK(state IN ('QUEUED','RUNNING','WAITING_EXTERNAL','SUCCEEDED','REJECTED','ACTION_REQUIRED')),
  step text NOT NULL DEFAULT 'RESERVE' CHECK(step IN ('RESERVE','CREATE_IDENTITY','TENANT_ROLE','ORG_MEMBERSHIP','VERIFY_MAPPING','INVITATION_INTENT','VERIFY_PROVISIONED')),
  attempt integer NOT NULL DEFAULT 0 CHECK(attempt>=0),
  fencing_token bigint NOT NULL DEFAULT 0 CHECK(fencing_token>=0),
  lease_owner text,
  lease_expires_at timestamptz,
  error_code text CHECK(error_code IS NULL OR error_code ~ '^[A-Z][A-Z0-9_]{2,79}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,id),
  UNIQUE(tenant_id,command_id),
  UNIQUE(tenant_id,target_user_id),
  UNIQUE(tenant_id,id,target_user_id),
  FOREIGN KEY(tenant_id,actor_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,target_user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,command_id) REFERENCES voice_config_commands(tenant_id,command_id),
  CHECK((lease_owner IS NULL)=(lease_expires_at IS NULL))
);
CREATE INDEX tenant_people_operations_pending ON tenant_people_operations(tenant_id,state,created_at,id);

CREATE TABLE tenant_identity_reservations (
  tenant_id uuid NOT NULL,
  identity_kind text NOT NULL CHECK(identity_kind IN ('EMAIL','EXTENSION')),
  identity_hash text NOT NULL CHECK(identity_hash ~ '^[a-f0-9]{64}$'),
  operation_id uuid NOT NULL,
  target_user_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'RESERVED' CHECK(status IN ('RESERVED','BOUND','TOMBSTONED')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,identity_kind,identity_hash),
  UNIQUE(tenant_id,target_user_id,identity_kind),
  FOREIGN KEY(tenant_id,operation_id,target_user_id) REFERENCES tenant_people_operations(tenant_id,id,target_user_id)
);

CREATE TABLE tenant_user_lifecycles (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  creation_role text NOT NULL CHECK(creation_role IN ('AGENT','SUPERVISOR','ADMIN')),
  creation_team_id uuid NOT NULL,
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
  account_state text NOT NULL DEFAULT 'PROVISIONING' CHECK(account_state IN ('PROVISIONING','PENDING_ACTIVATION','ACTIVE','DISABLING','DISABLED','ATTENTION_REQUIRED')),
  provisioning_state text NOT NULL DEFAULT 'PENDING' CHECK(provisioning_state IN ('PENDING','PROVISIONED','UNKNOWN','REJECTED')),
  activation_state text NOT NULL DEFAULT 'PENDING' CHECK(activation_state IN ('PENDING','ACTIVATED','UNKNOWN')),
  verified_identity_id uuid,
  verified_at timestamptz,
  PRIMARY KEY(tenant_id,user_id),
  FOREIGN KEY(tenant_id,user_id) REFERENCES users(tenant_id,id),
  FOREIGN KEY(tenant_id,operation_id,user_id) REFERENCES tenant_people_operations(tenant_id,id,target_user_id),
  FOREIGN KEY(tenant_id,creation_team_id) REFERENCES teams(tenant_id,id),
  CHECK((verified_identity_id IS NULL)=(verified_at IS NULL))
);

CREATE TABLE tenant_people_step_receipts (
  tenant_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  step text NOT NULL,
  fencing_token bigint NOT NULL CHECK(fencing_token>=0),
  payload_digest text NOT NULL CHECK(payload_digest ~ '^[a-f0-9]{64}$'),
  outcome text NOT NULL CHECK(outcome IN ('SUCCEEDED','REJECTED_NO_EFFECT','UNKNOWN')),
  provider_receipt_ref text,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(tenant_id,operation_id,step,fencing_token),
  FOREIGN KEY(tenant_id,operation_id) REFERENCES tenant_people_operations(tenant_id,id)
);
CREATE TRIGGER tenant_people_step_receipt_immutable BEFORE UPDATE OR DELETE ON tenant_people_step_receipts
  FOR EACH ROW EXECUTE FUNCTION dc_voice_config_immutable();

DO $$ DECLARE table_name text; BEGIN
  FOREACH table_name IN ARRAY ARRAY['tenant_people_operations','tenant_identity_reservations','tenant_user_lifecycles','tenant_people_step_receipts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY',table_name);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id=current_setting(''app.tenant_id'',true)::uuid) WITH CHECK (tenant_id=current_setting(''app.tenant_id'',true)::uuid)',table_name);
  END LOOP;
END $$;

CREATE FUNCTION dc_tenant_people_operation_descriptor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PEOPLE_OPERATION_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.tenant_id,NEW.id,NEW.command_id,NEW.actor_user_id,NEW.target_user_id,NEW.action,NEW.payload_digest,NEW.request_payload,NEW.correlation_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.id,OLD.command_id,OLD.actor_user_id,OLD.target_user_id,OLD.action,OLD.payload_digest,OLD.request_payload,OLD.correlation_id,OLD.created_at)
    THEN RAISE EXCEPTION 'PEOPLE_OPERATION_DESCRIPTOR_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.revision<>OLD.revision+1 OR NEW.fencing_token<OLD.fencing_token
    THEN RAISE EXCEPTION 'PEOPLE_OPERATION_FENCE_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_people_operation_descriptor BEFORE UPDATE OR DELETE ON tenant_people_operations
  FOR EACH ROW EXECUTE FUNCTION dc_tenant_people_operation_descriptor();

CREATE FUNCTION dc_tenant_identity_reservation_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PEOPLE_RESERVATION_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.tenant_id,NEW.identity_kind,NEW.identity_hash,NEW.operation_id,NEW.target_user_id,NEW.created_at)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.identity_kind,OLD.identity_hash,OLD.operation_id,OLD.target_user_id,OLD.created_at)
    THEN RAISE EXCEPTION 'PEOPLE_RESERVATION_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF OLD.status='TOMBSTONED' AND NEW.status<>'TOMBSTONED'
    THEN RAISE EXCEPTION 'PEOPLE_RESERVATION_TOMBSTONED' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_identity_reservation_guard BEFORE UPDATE OR DELETE ON tenant_identity_reservations
  FOR EACH ROW EXECUTE FUNCTION dc_tenant_identity_reservation_guard();

CREATE FUNCTION dc_tenant_people_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:voice-config:'||OLD.tenant_id::text,0))
    OR NOT pg_try_advisory_xact_lock(hashtextextended('dc:v1:tenant-people:'||OLD.tenant_id::text,0))
    THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  IF EXISTS(SELECT 1 FROM tenant_people_operations WHERE tenant_id=OLD.tenant_id AND state IN ('QUEUED','RUNNING','WAITING_EXTERNAL','ACTION_REQUIRED'))
    THEN RAISE EXCEPTION 'CONFIG_BUSY' USING ERRCODE='55P03'; END IF;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_people_policy_guard BEFORE UPDATE OR DELETE ON tenant_voice_provisioning_policies
  FOR EACH ROW EXECUTE FUNCTION dc_tenant_people_policy_guard();

CREATE FUNCTION dc_tenant_people_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'PEOPLE_LIFECYCLE_DELETE_FORBIDDEN' USING ERRCODE='23514'; END IF;
  IF ROW(NEW.tenant_id,NEW.user_id,NEW.operation_id,NEW.creation_role,NEW.creation_team_id)
    IS DISTINCT FROM ROW(OLD.tenant_id,OLD.user_id,OLD.operation_id,OLD.creation_role,OLD.creation_team_id)
    THEN RAISE EXCEPTION 'PEOPLE_LIFECYCLE_DESCRIPTOR_IMMUTABLE' USING ERRCODE='23514'; END IF;
  IF NEW.revision<>OLD.revision+1 THEN RAISE EXCEPTION 'REVISION_CONFLICT' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER tenant_people_lifecycle_guard BEFORE UPDATE OR DELETE ON tenant_user_lifecycles
  FOR EACH ROW EXECUTE FUNCTION dc_tenant_people_lifecycle_guard();
