-- Cus360 C1 (#791): schema ตาม Phase Contract E1 ข้อ A และ H
-- คง legacy profile/linkage เดิม; ทุกอย่างเป็น additive และ API เก่ายังทำงานได้กับ schema ใหม่

ALTER TABLE contacts
  ADD COLUMN company text,
  ADD COLUMN vip boolean NOT NULL DEFAULT false,
  ADD COLUMN vip_source text NOT NULL DEFAULT 'LEGACY_DEFAULT',
  ADD COLUMN profile_revision bigint NOT NULL DEFAULT 0,
  ADD COLUMN tag_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT contacts_vip_source_check CHECK (vip_source IN ('LEGACY_DEFAULT', 'PROFILE_COMMAND')),
  ADD CONSTRAINT contacts_profile_revision_check CHECK (profile_revision >= 0),
  ADD CONSTRAINT contacts_tag_revision_check CHECK (tag_revision >= 0);

CREATE INDEX contacts_tenant_created_id_idx ON contacts (tenant_id, created_at, id);

ALTER TABLE interactions
  ADD COLUMN customer_link_revision bigint NOT NULL DEFAULT 0,
  ADD CONSTRAINT interactions_customer_link_revision_check CHECK (customer_link_revision >= 0);

-- prerequisites ของ composite FK: child ต้องพิสูจน์ tenant (และ owner) เดียวกันจาก constraint ไม่ใช่จาก app
CREATE UNIQUE INDEX contact_identities_tenant_id_contact_key
  ON contact_identities (tenant_id, id, contact_id);
CREATE UNIQUE INDEX agent_work_session_leases_tenant_user_id_key
  ON agent_work_session_leases (tenant_id, user_id, id);

-- ---------------------------------------------------------------------------
-- Command admission / receipt (E1 B): ไม่มี raw payload, PII หรือ credential snapshot
-- ---------------------------------------------------------------------------
CREATE TABLE c360_profile_commands (
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid,
  action text,
  resource_type text,
  resource_id uuid,
  payload_digest char(64),
  normalization_contract_version text,
  expected_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  is_tombstone boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_profile_commands_actor_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_profile_commands_actor_key_check CHECK (char_length(actor_identity_key) BETWEEN 1 AND 512),
  CONSTRAINT c360_profile_commands_digest_check CHECK (payload_digest IS NULL OR payload_digest ~ '^[0-9a-f]{64}$'),
  CONSTRAINT c360_profile_commands_revisions_check CHECK (jsonb_typeof(expected_revisions) = 'object'),
  -- tombstone ปิด key ที่ไม่เคยถูก admit จึงไม่มี payload; admission จริงต้องมีครบ
  CONSTRAINT c360_profile_commands_admission_check CHECK (
    (is_tombstone AND action IS NULL AND payload_digest IS NULL AND expected_revisions = '{}'::jsonb)
    OR (NOT is_tombstone AND action IS NOT NULL AND resource_type IS NOT NULL
        AND payload_digest IS NOT NULL AND normalization_contract_version IS NOT NULL)
  )
);

CREATE TABLE c360_profile_command_receipts (
  tenant_id uuid NOT NULL,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  outcome text NOT NULL,
  code text,
  http_status integer NOT NULL,
  committed_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  resource_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  committed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_profile_command_receipts_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_profile_command_receipts_outcome_check CHECK (outcome IN ('APPLIED', 'NO_OP', 'REJECTED')),
  CONSTRAINT c360_profile_command_receipts_code_check CHECK (outcome <> 'REJECTED' OR code IS NOT NULL),
  CONSTRAINT c360_profile_command_receipts_status_check CHECK (http_status BETWEEN 200 AND 599),
  CONSTRAINT c360_profile_command_receipts_revisions_check CHECK (jsonb_typeof(committed_revisions) = 'object'),
  CONSTRAINT c360_profile_command_receipts_refs_check CHECK (jsonb_typeof(resource_refs) = 'array')
);

CREATE TABLE c360_profile_audits (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  event_ordinal integer NOT NULL DEFAULT 0,
  actor_user_id uuid,
  operation text NOT NULL,
  resource_type text NOT NULL,
  resource_id uuid NOT NULL,
  changed_fields text[] NOT NULL DEFAULT '{}',
  before_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_revisions jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence_refs text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT c360_profile_audits_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_profile_audits_actor_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_profile_audits_ordinal_key UNIQUE (tenant_id, actor_identity_key, command_id, event_ordinal),
  CONSTRAINT c360_profile_audits_ordinal_check CHECK (event_ordinal >= 0)
);
CREATE INDEX c360_profile_audits_resource_idx
  ON c360_profile_audits (tenant_id, resource_type, resource_id, created_at, id);

-- ---------------------------------------------------------------------------
-- Contact points (E1 A, R1 B.3–B.5): retire+insert; ไม่แก้ค่าทับและไม่มี unique ข้าม contact
-- ---------------------------------------------------------------------------
CREATE TABLE c360_contact_points (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  kind text NOT NULL,
  raw_value text NOT NULL,
  normalized_value text COLLATE "C",
  normalization_version text,
  explicit_country text,
  state text NOT NULL,
  source_kind text NOT NULL,
  source_identity_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_actor_identity_key text NOT NULL,
  created_command_id uuid NOT NULL,
  retired_at timestamptz,
  retired_actor_identity_key text,
  retired_command_id uuid,
  CONSTRAINT c360_contact_points_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT c360_contact_points_contact_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  -- identity ต้นทางต้องเป็นของ contact เดียวกันจริง ไม่เดา provenance
  CONSTRAINT c360_contact_points_source_identity_fkey FOREIGN KEY (tenant_id, source_identity_id, contact_id)
    REFERENCES contact_identities (tenant_id, id, contact_id),
  CONSTRAINT c360_contact_points_created_command_fkey FOREIGN KEY (tenant_id, created_actor_identity_key, created_command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_contact_points_retired_command_fkey FOREIGN KEY (tenant_id, retired_actor_identity_key, retired_command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_contact_points_kind_check CHECK (kind IN ('PHONE', 'EMAIL')),
  CONSTRAINT c360_contact_points_state_check CHECK (state IN ('ACTIVE', 'RETIRED', 'REVIEW_REQUIRED')),
  CONSTRAINT c360_contact_points_source_check CHECK (
    (source_kind = 'PROFILE_COMMAND' AND source_identity_id IS NULL)
    OR (source_kind = 'LEGACY_IDENTITY' AND source_identity_id IS NOT NULL)
  ),
  CONSTRAINT c360_contact_points_raw_check CHECK (raw_value <> ''),
  CONSTRAINT c360_contact_points_country_check CHECK (explicit_country IS NULL OR explicit_country ~ '^[A-Z]{2}$'),
  CONSTRAINT c360_contact_points_normalized_check CHECK (
    (normalized_value IS NULL) = (normalization_version IS NULL)
  ),
  CONSTRAINT c360_contact_points_active_check CHECK (state <> 'ACTIVE' OR normalized_value IS NOT NULL),
  -- REVIEW_REQUIRED ไม่มี key จับคู่ จึงไม่มีทางหลุดเข้า lookup/dispatch
  CONSTRAINT c360_contact_points_review_check CHECK (state <> 'REVIEW_REQUIRED' OR normalized_value IS NULL),
  CONSTRAINT c360_contact_points_retired_check CHECK (
    (state = 'RETIRED') = (retired_at IS NOT NULL)
    AND (retired_at IS NULL) = (retired_command_id IS NULL)
    AND (retired_command_id IS NULL) = (retired_actor_identity_key IS NULL)
  )
);
CREATE UNIQUE INDEX c360_contact_points_active_value_key
  ON c360_contact_points (tenant_id, contact_id, kind, normalization_version, normalized_value)
  WHERE state = 'ACTIVE';
CREATE INDEX c360_contact_points_lookup_idx
  ON c360_contact_points (tenant_id, kind, normalization_version, normalized_value, contact_id)
  WHERE state = 'ACTIVE';
CREATE INDEX c360_contact_points_contact_idx
  ON c360_contact_points (tenant_id, contact_id, state, created_at, id);
CREATE UNIQUE INDEX c360_contact_points_legacy_source_key
  ON c360_contact_points (tenant_id, source_identity_id)
  WHERE source_kind = 'LEGACY_IDENTITY';

CREATE FUNCTION c360_contact_points_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.kind IS DISTINCT FROM OLD.kind
     OR NEW.raw_value IS DISTINCT FROM OLD.raw_value
     OR NEW.normalized_value IS DISTINCT FROM OLD.normalized_value
     OR NEW.normalization_version IS DISTINCT FROM OLD.normalization_version
     OR NEW.explicit_country IS DISTINCT FROM OLD.explicit_country
     OR NEW.source_kind IS DISTINCT FROM OLD.source_kind
     OR NEW.source_identity_id IS DISTINCT FROM OLD.source_identity_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.created_actor_identity_key IS DISTINCT FROM OLD.created_actor_identity_key
     OR NEW.created_command_id IS DISTINCT FROM OLD.created_command_id THEN
    RAISE EXCEPTION 'C360_POINT_IMMUTABLE: contact point attributes are immutable';
  END IF;
  -- เปลี่ยนได้ทางเดียวคือ retire จาก ACTIVE/REVIEW_REQUIRED
  IF NOT (OLD.state <> 'RETIRED' AND NEW.state = 'RETIRED') THEN
    RAISE EXCEPTION 'C360_POINT_IMMUTABLE: only retiring a non-retired point is allowed';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER c360_contact_points_immutable
BEFORE UPDATE ON c360_contact_points
FOR EACH ROW EXECUTE FUNCTION c360_contact_points_guard();

-- ---------------------------------------------------------------------------
-- Custodian capability (R1 C): append-only grant + revocation; ไม่ UPDATE/DELETE หลักฐาน
-- ---------------------------------------------------------------------------
CREATE TABLE c360_contact_custodian_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  grantee_user_id uuid NOT NULL,
  permission text NOT NULL,
  origin text NOT NULL,
  evidence_ref text,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid,
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT c360_contact_custodian_grants_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT c360_contact_custodian_grants_contact_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  CONSTRAINT c360_contact_custodian_grants_grantee_fkey FOREIGN KEY (tenant_id, grantee_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_contact_custodian_grants_actor_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_contact_custodian_grants_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_contact_custodian_grants_permission_check CHECK (permission IN ('READ', 'MANAGE')),
  CONSTRAINT c360_contact_custodian_grants_origin_check CHECK (origin IN ('CREATOR', 'OPERATOR')),
  -- creator ได้สิทธิ์จาก create command ของตัวเองเท่านั้น; operator ต้องมีหลักฐาน
  CONSTRAINT c360_contact_custodian_grants_creator_check CHECK (
    origin <> 'CREATOR' OR (permission = 'MANAGE' AND actor_user_id = grantee_user_id)
  ),
  CONSTRAINT c360_contact_custodian_grants_evidence_check CHECK (
    origin <> 'OPERATOR' OR (evidence_ref IS NOT NULL AND evidence_ref <> '')
  )
);
CREATE INDEX c360_contact_custodian_grants_grantee_idx
  ON c360_contact_custodian_grants (tenant_id, grantee_user_id, contact_id);
CREATE INDEX c360_contact_custodian_grants_contact_idx
  ON c360_contact_custodian_grants (tenant_id, contact_id);

CREATE TABLE c360_contact_custodian_revocations (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  grant_id uuid NOT NULL,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  actor_user_id uuid,
  reason text NOT NULL,
  evidence_ref text NOT NULL,
  revoked_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT c360_contact_custodian_revocations_grant_key UNIQUE (tenant_id, grant_id),
  CONSTRAINT c360_contact_custodian_revocations_grant_fkey FOREIGN KEY (tenant_id, grant_id)
    REFERENCES c360_contact_custodian_grants (tenant_id, id),
  CONSTRAINT c360_contact_custodian_revocations_actor_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_contact_custodian_revocations_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_contact_custodian_revocations_reason_check CHECK (reason <> '' AND evidence_ref <> '')
);

-- ---------------------------------------------------------------------------
-- Interaction linkage history (E1 A): contactId เดิมยังเป็น current link
-- ---------------------------------------------------------------------------
CREATE TABLE c360_interaction_customer_changes (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  interaction_id uuid NOT NULL,
  action text NOT NULL,
  before_contact_id uuid,
  after_contact_id uuid,
  before_link_revision bigint NOT NULL,
  after_link_revision bigint NOT NULL,
  actor_user_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT c360_interaction_customer_changes_revision_key UNIQUE (tenant_id, interaction_id, after_link_revision),
  CONSTRAINT c360_interaction_customer_changes_interaction_fkey FOREIGN KEY (tenant_id, interaction_id)
    REFERENCES interactions (tenant_id, id),
  CONSTRAINT c360_interaction_customer_changes_before_fkey FOREIGN KEY (tenant_id, before_contact_id) REFERENCES contacts (tenant_id, id),
  CONSTRAINT c360_interaction_customer_changes_after_fkey FOREIGN KEY (tenant_id, after_contact_id) REFERENCES contacts (tenant_id, id),
  CONSTRAINT c360_interaction_customer_changes_actor_fkey FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_interaction_customer_changes_lease_fkey FOREIGN KEY (tenant_id, actor_user_id, lease_id)
    REFERENCES agent_work_session_leases (tenant_id, user_id, id),
  CONSTRAINT c360_interaction_customer_changes_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_interaction_customer_changes_action_check CHECK (
    (action = 'LINK' AND before_contact_id IS NULL AND after_contact_id IS NOT NULL)
    OR (action = 'RELINK' AND before_contact_id IS NOT NULL AND after_contact_id IS NOT NULL
        AND before_contact_id <> after_contact_id)
    OR (action = 'DETACH' AND before_contact_id IS NOT NULL AND after_contact_id IS NULL)
  ),
  CONSTRAINT c360_interaction_customer_changes_revisions_check CHECK (
    before_link_revision >= 0 AND after_link_revision = before_link_revision + 1
  ),
  -- R1 E: relink/detach ต้องมีเหตุผล 1–500; LINK ไม่ต้องมี
  CONSTRAINT c360_interaction_customer_changes_reason_check CHECK (
    (action = 'LINK' AND reason IS NULL)
    OR (action <> 'LINK' AND reason IS NOT NULL AND char_length(reason) BETWEEN 1 AND 500 AND reason = btrim(reason))
  )
);
CREATE INDEX c360_interaction_customer_changes_interaction_idx
  ON c360_interaction_customer_changes (tenant_id, interaction_id, created_at, id);

-- ---------------------------------------------------------------------------
-- Tags (E1 A): nameKey เทียบแบบ binary และสงวนชื่อที่ RETIRED แล้ว
-- ---------------------------------------------------------------------------
CREATE TABLE c360_tags (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants (id),
  name text NOT NULL,
  name_key text COLLATE "C" NOT NULL,
  state text NOT NULL DEFAULT 'ACTIVE',
  revision bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  evidence_ref text,
  CONSTRAINT c360_tags_tenant_id_key UNIQUE (tenant_id, id),
  CONSTRAINT c360_tags_name_key UNIQUE (tenant_id, name_key),
  CONSTRAINT c360_tags_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id),
  CONSTRAINT c360_tags_state_check CHECK (state IN ('ACTIVE', 'RETIRED')),
  CONSTRAINT c360_tags_retired_check CHECK ((state = 'RETIRED') = (retired_at IS NOT NULL)),
  CONSTRAINT c360_tags_revision_check CHECK (revision >= 0),
  CONSTRAINT c360_tags_name_check CHECK (name <> '' AND name_key <> '')
);

CREATE FUNCTION c360_tags_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.name IS DISTINCT FROM OLD.name
     OR NEW.name_key IS DISTINCT FROM OLD.name_key
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.actor_identity_key IS DISTINCT FROM OLD.actor_identity_key
     OR NEW.command_id IS DISTINCT FROM OLD.command_id THEN
    RAISE EXCEPTION 'C360_TAG_IMMUTABLE: tag identity is immutable';
  END IF;
  IF OLD.state = 'RETIRED' THEN
    RAISE EXCEPTION 'C360_TAG_RETIRED: retired tag cannot change';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'C360_TAG_REVISION: tag revision must advance by one';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER c360_tags_immutable
BEFORE UPDATE ON c360_tags
FOR EACH ROW EXECUTE FUNCTION c360_tags_guard();

CREATE TABLE c360_contact_tags (
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  tag_id uuid NOT NULL,
  actor_identity_key text NOT NULL,
  command_id uuid NOT NULL,
  attached_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, contact_id, tag_id),
  CONSTRAINT c360_contact_tags_contact_fkey FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  CONSTRAINT c360_contact_tags_tag_fkey FOREIGN KEY (tenant_id, tag_id) REFERENCES c360_tags (tenant_id, id),
  CONSTRAINT c360_contact_tags_command_fkey FOREIGN KEY (tenant_id, actor_identity_key, command_id)
    REFERENCES c360_profile_commands (tenant_id, actor_identity_key, command_id)
);
CREATE INDEX c360_contact_tags_tag_idx ON c360_contact_tags (tenant_id, tag_id);

-- backstop ของ retired-tag guard; command หลักยังต้องตรวจใต้ tag lock (E1 A)
CREATE FUNCTION c360_contact_tags_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    RAISE EXCEPTION 'C360_CONTACT_TAG_IMMUTABLE: detach and attach instead of update';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM c360_tags t
    WHERE t.tenant_id = NEW.tenant_id AND t.id = NEW.tag_id AND t.state = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'C360_TAG_RETIRED: cannot attach a retired tag';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER c360_contact_tags_guard
BEFORE INSERT OR UPDATE ON c360_contact_tags
FOR EACH ROW EXECUTE FUNCTION c360_contact_tags_guard();

-- ---------------------------------------------------------------------------
-- Work mutation auth (E1 H): durable auth state ต่อ lease; ไม่เก็บ access/refresh token
-- ---------------------------------------------------------------------------
CREATE TABLE c360_work_mutation_auth (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  lease_id uuid NOT NULL,
  auth_epoch bigint NOT NULL DEFAULT 0,
  auth_state text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  sid text NOT NULL,
  token_fingerprint char(64) NOT NULL,
  token_expires_at timestamptz NOT NULL,
  last_online_check_started_at timestamptz,
  invalidation_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, lease_id),
  CONSTRAINT c360_work_mutation_auth_lease_fkey FOREIGN KEY (tenant_id, user_id, lease_id)
    REFERENCES agent_work_session_leases (tenant_id, user_id, id),
  CONSTRAINT c360_work_mutation_auth_user_fkey FOREIGN KEY (tenant_id, user_id) REFERENCES users (tenant_id, id),
  CONSTRAINT c360_work_mutation_auth_epoch_check CHECK (auth_epoch >= 0),
  CONSTRAINT c360_work_mutation_auth_state_check CHECK (auth_state IN ('ACTIVE', 'REAUTH_REQUIRED')),
  CONSTRAINT c360_work_mutation_auth_fingerprint_check CHECK (token_fingerprint ~ '^[0-9a-f]{64}$'),
  CONSTRAINT c360_work_mutation_auth_identity_check CHECK (issuer <> '' AND subject <> '' AND sid <> ''),
  CONSTRAINT c360_work_mutation_auth_reason_check CHECK (
    (auth_state = 'REAUTH_REQUIRED') = (invalidation_reason IS NOT NULL)
  )
);

CREATE FUNCTION c360_work_mutation_auth_guard() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.user_id IS DISTINCT FROM OLD.user_id
     OR NEW.lease_id IS DISTINCT FROM OLD.lease_id
     OR NEW.issuer IS DISTINCT FROM OLD.issuer
     OR NEW.subject IS DISTINCT FROM OLD.subject THEN
    RAISE EXCEPTION 'C360_WORK_AUTH_IDENTITY: auth row identity is immutable';
  END IF;
  -- ทุกการเปลี่ยน binding/state ต้อง CAS เพิ่ม epoch; การบันทึกเวลา online check ไม่เปลี่ยน epoch
  IF NEW.auth_epoch < OLD.auth_epoch
     OR (NEW.auth_epoch = OLD.auth_epoch AND (
       NEW.auth_state IS DISTINCT FROM OLD.auth_state
       OR NEW.sid IS DISTINCT FROM OLD.sid
       OR NEW.token_fingerprint IS DISTINCT FROM OLD.token_fingerprint
       OR NEW.token_expires_at IS DISTINCT FROM OLD.token_expires_at
       OR NEW.invalidation_reason IS DISTINCT FROM OLD.invalidation_reason)) THEN
    RAISE EXCEPTION 'C360_WORK_AUTH_EPOCH: auth change must advance epoch';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER c360_work_mutation_auth_guard
BEFORE UPDATE ON c360_work_mutation_auth
FOR EACH ROW EXECUTE FUNCTION c360_work_mutation_auth_guard();

-- ---------------------------------------------------------------------------
-- Tenant RLS ทั้ง USING และ WITH CHECK (rls.sql ติดตั้งซ้ำได้)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'c360_profile_commands', 'c360_profile_command_receipts', 'c360_profile_audits',
    'c360_contact_points', 'c360_contact_custodian_grants', 'c360_contact_custodian_revocations',
    'c360_interaction_customer_changes', 'c360_tags', 'c360_contact_tags', 'c360_work_mutation_auth'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO dcontact_app', t);
  END LOOP;
END $$;

-- หลักฐานเป็น append-only สำหรับ application role (rls.sql ถอนซ้ำหลัง bootstrap)
REVOKE UPDATE, DELETE ON c360_profile_commands, c360_profile_command_receipts, c360_profile_audits,
  c360_contact_custodian_grants, c360_contact_custodian_revocations,
  c360_interaction_customer_changes FROM dcontact_app;
REVOKE DELETE ON c360_contact_points, c360_tags, c360_work_mutation_auth FROM dcontact_app;
REVOKE UPDATE ON c360_contact_tags FROM dcontact_app;
