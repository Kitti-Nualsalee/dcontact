-- J3.3 (#214): Customer 360-owned membership stream, identity lineage,
-- immutable change/evidence records และ transactional canonical outbox.

CREATE TYPE "C360SegmentMembershipState" AS ENUM ('IN', 'OUT', 'INVALIDATED');
CREATE TYPE "C360SegmentMembershipChangeKind" AS ENUM (
  'ENTERED', 'LEFT', 'CORRECTED', 'REFILTER_REQUIRED', 'IDENTITY_INVALIDATED'
);
CREATE TYPE "C360SegmentMembershipOutboxState" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');
CREATE TYPE "C360MembershipCommandStatus" AS ENUM (
  'TRANSITIONED', 'NO_CHANGE', 'DUPLICATE_NO_OP', 'QUARANTINED'
);
CREATE TYPE "C360IdentityState" AS ENUM ('ACTIVE', 'MERGED', 'AMBIGUOUS');
CREATE TYPE "C360IdentityOperation" AS ENUM ('MERGE', 'SPLIT', 'UNMERGE');

CREATE TABLE "c360_segment_membership_heads" (
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "state" "C360SegmentMembershipState" NOT NULL,
  "membership_revision" INTEGER NOT NULL DEFAULT 0,
  "entry_id" TEXT,
  "segment_definition_version" INTEGER NOT NULL,
  "snapshot_version" INTEGER NOT NULL,
  "evaluation_id" UUID NOT NULL,
  "evaluated_at" TIMESTAMP(3) NOT NULL,
  "state_digest" CHAR(64) NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "lineage_revision" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "c360_segment_membership_heads_pkey"
    PRIMARY KEY ("tenant_id", "contact_id", "segment_id"),
  CONSTRAINT "c360_membership_heads_revision_check" CHECK ("membership_revision" >= 0),
  CONSTRAINT "c360_membership_heads_versions_check" CHECK (
    "segment_definition_version" >= 1 AND "snapshot_version" >= 1 AND "lineage_revision" >= 0
  ),
  CONSTRAINT "c360_membership_heads_digest_check" CHECK ("state_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_membership_heads_entry_check" CHECK (
    ("state" = 'IN' AND "membership_revision" >= 1 AND "entry_id" IS NOT NULL)
    OR ("state" = 'OUT' AND "entry_id" IS NULL)
    OR ("state" = 'INVALIDATED')
  ),
  CONSTRAINT "c360_membership_heads_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_heads_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_heads_definition_fkey"
    FOREIGN KEY ("tenant_id", "segment_id", "segment_definition_version")
    REFERENCES "c360_segment_definitions"("tenant_id", "segment_id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_heads_snapshot_fkey"
    FOREIGN KEY ("tenant_id", "contact_id", "snapshot_version")
    REFERENCES "c360_fact_snapshots"("tenant_id", "contact_id", "snapshot_version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_heads_evaluation_fkey"
    FOREIGN KEY ("tenant_id", "evaluation_id")
    REFERENCES "c360_segment_evaluations"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "c360_membership_heads_tenant_segment_state_revision_idx"
  ON "c360_segment_membership_heads"("tenant_id", "segment_id", "state", "membership_revision");
CREATE INDEX "c360_membership_heads_tenant_entry_idx"
  ON "c360_segment_membership_heads"("tenant_id", "entry_id");

CREATE TABLE "c360_segment_membership_changes" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "membership_revision" INTEGER NOT NULL,
  "change_kind" "C360SegmentMembershipChangeKind" NOT NULL,
  "entry_id" TEXT,
  "segment_definition_version" INTEGER NOT NULL,
  "snapshot_version" INTEGER NOT NULL,
  "evaluation_id" UUID NOT NULL,
  "evaluated_at" TIMESTAMP(3) NOT NULL,
  "state_digest" CHAR(64) NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "supersedes_revision" INTEGER,
  "lineage_revision" INTEGER NOT NULL DEFAULT 0,
  "correlation_id" TEXT NOT NULL,
  "causation_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "c360_segment_membership_changes_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_membership_changes_revision_check" CHECK (
    "membership_revision" >= 1
    AND "segment_definition_version" >= 1
    AND "snapshot_version" >= 1
    AND "lineage_revision" >= 0
    AND ("supersedes_revision" IS NULL OR (
      "supersedes_revision" >= 1 AND "supersedes_revision" < "membership_revision"
    ))
  ),
  CONSTRAINT "c360_membership_changes_digest_check" CHECK ("state_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_membership_changes_kind_check" CHECK (
    ("change_kind" IN ('ENTERED', 'LEFT') AND "entry_id" IS NOT NULL)
    OR ("change_kind" = 'CORRECTED' AND "supersedes_revision" IS NOT NULL)
    OR ("change_kind" IN ('REFILTER_REQUIRED', 'IDENTITY_INVALIDATED'))
  ),
  CONSTRAINT "c360_membership_changes_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_changes_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_changes_definition_fkey"
    FOREIGN KEY ("tenant_id", "segment_id", "segment_definition_version")
    REFERENCES "c360_segment_definitions"("tenant_id", "segment_id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_changes_snapshot_fkey"
    FOREIGN KEY ("tenant_id", "contact_id", "snapshot_version")
    REFERENCES "c360_fact_snapshots"("tenant_id", "contact_id", "snapshot_version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_changes_evaluation_fkey"
    FOREIGN KEY ("tenant_id", "evaluation_id")
    REFERENCES "c360_segment_evaluations"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_membership_changes_tenant_id_id_key"
  ON "c360_segment_membership_changes"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_membership_changes_stream_revision_key"
  ON "c360_segment_membership_changes"(
    "tenant_id", "contact_id", "segment_id", "membership_revision"
  );
CREATE INDEX "c360_membership_changes_tenant_entry_revision_idx"
  ON "c360_segment_membership_changes"("tenant_id", "entry_id", "membership_revision");

CREATE TABLE "c360_segment_membership_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "change_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "membership_revision" INTEGER NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "causation_id" TEXT,
  "state" "C360SegmentMembershipOutboxState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "broker_ref" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "c360_segment_membership_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_membership_outbox_revision_attempt_check" CHECK (
    "membership_revision" >= 1 AND "attempts" >= 0
  ),
  CONSTRAINT "c360_membership_outbox_hash_check" CHECK ("payload_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_membership_outbox_state_check" CHECK (
    ("state" IN ('PENDING', 'FAILED') AND "published_at" IS NULL)
    OR ("state" = 'PUBLISHED' AND "published_at" IS NOT NULL)
  ),
  CONSTRAINT "c360_membership_outbox_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_outbox_change_fkey"
    FOREIGN KEY ("tenant_id", "change_id")
    REFERENCES "c360_segment_membership_changes"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_membership_outbox_tenant_id_id_key"
  ON "c360_segment_membership_outbox"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_membership_outbox_tenant_change_key"
  ON "c360_segment_membership_outbox"("tenant_id", "change_id");
CREATE UNIQUE INDEX "c360_membership_outbox_tenant_event_key"
  ON "c360_segment_membership_outbox"("tenant_id", "event_id");
CREATE INDEX "c360_membership_outbox_ready_idx"
  ON "c360_segment_membership_outbox"("tenant_id", "state", "available_at", "created_at");
CREATE INDEX "c360_membership_outbox_stream_idx"
  ON "c360_segment_membership_outbox"(
    "tenant_id", "contact_id", "segment_id", "membership_revision"
  );

CREATE TABLE "c360_segment_evidence" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "evaluation_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "evidence_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "c360_segment_evidence_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_segment_evidence_digest_check" CHECK ("evidence_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_segment_evidence_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_segment_evidence_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_segment_evidence_evaluation_fkey"
    FOREIGN KEY ("tenant_id", "evaluation_id")
    REFERENCES "c360_segment_evaluations"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_segment_evidence_tenant_id_id_key"
  ON "c360_segment_evidence"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_segment_evidence_tenant_ref_key"
  ON "c360_segment_evidence"("tenant_id", "evidence_ref");
CREATE UNIQUE INDEX "c360_segment_evidence_tenant_evaluation_key"
  ON "c360_segment_evidence"("tenant_id", "evaluation_id");

CREATE TABLE "c360_evidence_access_audit" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "actor_class" TEXT NOT NULL,
  "actor_ref" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "accessed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "c360_evidence_access_audit_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_evidence_access_audit_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_evidence_access_audit_evidence_fkey"
    FOREIGN KEY ("tenant_id", "evidence_ref")
    REFERENCES "c360_segment_evidence"("tenant_id", "evidence_ref")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_evidence_access_audit_tenant_id_id_key"
  ON "c360_evidence_access_audit"("tenant_id", "id");
CREATE INDEX "c360_evidence_access_audit_ref_time_idx"
  ON "c360_evidence_access_audit"("tenant_id", "evidence_ref", "accessed_at");

CREATE TABLE "c360_membership_command_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "command_id" TEXT NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "status" "C360MembershipCommandStatus" NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "membership_revision" INTEGER NOT NULL,
  "change_id" UUID,
  "entry_id" TEXT,
  "response_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "c360_membership_command_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_membership_receipts_revision_check" CHECK ("membership_revision" >= 0),
  CONSTRAINT "c360_membership_receipts_hash_check" CHECK (
    "request_hash" ~ '^[a-f0-9]{64}$' AND "response_digest" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "c360_membership_receipts_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_membership_receipts_change_fkey"
    FOREIGN KEY ("tenant_id", "change_id")
    REFERENCES "c360_segment_membership_changes"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_membership_receipts_tenant_id_id_key"
  ON "c360_membership_command_receipts"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_membership_receipts_tenant_command_key"
  ON "c360_membership_command_receipts"("tenant_id", "command_id");
CREATE INDEX "c360_membership_receipts_stream_revision_idx"
  ON "c360_membership_command_receipts"(
    "tenant_id", "contact_id", "segment_id", "membership_revision"
  );

CREATE TABLE "c360_membership_quarantine" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "command_id" TEXT NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "attempted_revision" INTEGER NOT NULL,
  "attempted_hash" CHAR(64) NOT NULL,
  "canonical_hash" CHAR(64),
  "error_code" TEXT NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "c360_membership_quarantine_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_membership_quarantine_revision_check" CHECK ("attempted_revision" >= 0),
  CONSTRAINT "c360_membership_quarantine_hash_check" CHECK (
    "attempted_hash" ~ '^[a-f0-9]{64}$'
    AND ("canonical_hash" IS NULL OR "canonical_hash" ~ '^[a-f0-9]{64}$')
  ),
  CONSTRAINT "c360_membership_quarantine_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_membership_quarantine_tenant_id_id_key"
  ON "c360_membership_quarantine"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_membership_quarantine_attempt_key"
  ON "c360_membership_quarantine"("tenant_id", "command_id", "attempted_hash");
CREATE INDEX "c360_membership_quarantine_stream_revision_idx"
  ON "c360_membership_quarantine"(
    "tenant_id", "contact_id", "segment_id", "attempted_revision"
  );

CREATE TABLE "c360_identity_heads" (
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "state" "C360IdentityState" NOT NULL DEFAULT 'ACTIVE',
  "canonical_contact_id" UUID NOT NULL,
  "lineage_revision" INTEGER NOT NULL DEFAULT 0,
  "state_digest" CHAR(64) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "c360_identity_heads_pkey" PRIMARY KEY ("tenant_id", "contact_id"),
  CONSTRAINT "c360_identity_heads_revision_check" CHECK ("lineage_revision" >= 0),
  CONSTRAINT "c360_identity_heads_digest_check" CHECK ("state_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_identity_heads_state_check" CHECK (
    ("state" = 'MERGED' AND "canonical_contact_id" <> "contact_id")
    OR ("state" IN ('ACTIVE', 'AMBIGUOUS') AND "canonical_contact_id" = "contact_id")
  ),
  CONSTRAINT "c360_identity_heads_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_identity_heads_subject_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_identity_heads_canonical_fkey"
    FOREIGN KEY ("tenant_id", "canonical_contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "c360_identity_heads_tenant_canonical_state_idx"
  ON "c360_identity_heads"("tenant_id", "canonical_contact_id", "state");

CREATE TABLE "c360_identity_lineage" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "command_id" TEXT NOT NULL,
  "operation" "C360IdentityOperation" NOT NULL,
  "source_contact_id" UUID NOT NULL,
  "target_contact_id" UUID NOT NULL,
  "lineage_revision" INTEGER NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "state_digest" CHAR(64) NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "c360_identity_lineage_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_identity_lineage_revision_check" CHECK ("lineage_revision" >= 1),
  CONSTRAINT "c360_identity_lineage_contacts_check" CHECK ("source_contact_id" <> "target_contact_id"),
  CONSTRAINT "c360_identity_lineage_hash_check" CHECK (
    "request_hash" ~ '^[a-f0-9]{64}$' AND "state_digest" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "c360_identity_lineage_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_identity_lineage_source_fkey"
    FOREIGN KEY ("tenant_id", "source_contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_identity_lineage_target_fkey"
    FOREIGN KEY ("tenant_id", "target_contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_identity_lineage_tenant_id_id_key"
  ON "c360_identity_lineage"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_identity_lineage_tenant_command_key"
  ON "c360_identity_lineage"("tenant_id", "command_id");
CREATE INDEX "c360_identity_lineage_source_revision_idx"
  ON "c360_identity_lineage"("tenant_id", "source_contact_id", "lineage_revision");
CREATE INDEX "c360_identity_lineage_target_time_idx"
  ON "c360_identity_lineage"("tenant_id", "target_contact_id", "occurred_at");

CREATE FUNCTION c360_reject_membership_fact_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'c360 canonical membership fact is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "c360_membership_change_immutable"
BEFORE UPDATE ON "c360_segment_membership_changes"
FOR EACH ROW EXECUTE FUNCTION c360_reject_membership_fact_update();
CREATE TRIGGER "c360_segment_evidence_immutable"
BEFORE UPDATE ON "c360_segment_evidence"
FOR EACH ROW EXECUTE FUNCTION c360_reject_membership_fact_update();
CREATE TRIGGER "c360_evidence_access_audit_immutable"
BEFORE UPDATE ON "c360_evidence_access_audit"
FOR EACH ROW EXECUTE FUNCTION c360_reject_membership_fact_update();
CREATE TRIGGER "c360_membership_receipt_immutable"
BEFORE UPDATE ON "c360_membership_command_receipts"
FOR EACH ROW EXECUTE FUNCTION c360_reject_membership_fact_update();
CREATE TRIGGER "c360_membership_quarantine_immutable"
BEFORE UPDATE ON "c360_membership_quarantine"
FOR EACH ROW EXECUTE FUNCTION c360_reject_membership_fact_update();
CREATE TRIGGER "c360_identity_lineage_immutable"
BEFORE UPDATE ON "c360_identity_lineage"
FOR EACH ROW EXECUTE FUNCTION c360_reject_membership_fact_update();

CREATE FUNCTION c360_guard_membership_outbox_update() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.change_id IS DISTINCT FROM OLD.change_id
     OR NEW.event_id IS DISTINCT FROM OLD.event_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.segment_id IS DISTINCT FROM OLD.segment_id
     OR NEW.membership_revision IS DISTINCT FROM OLD.membership_revision
     OR NEW.payload IS DISTINCT FROM OLD.payload
     OR NEW.payload_hash IS DISTINCT FROM OLD.payload_hash
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.causation_id IS DISTINCT FROM OLD.causation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.attempts < OLD.attempts
     OR OLD.state = 'PUBLISHED'
     OR (OLD.state = 'PENDING' AND NEW.state NOT IN ('PUBLISHED', 'FAILED'))
     OR (OLD.state = 'FAILED' AND NEW.state NOT IN ('PUBLISHED', 'FAILED')) THEN
    RAISE EXCEPTION 'invalid c360 membership outbox update';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "c360_membership_outbox_guard"
BEFORE UPDATE ON "c360_segment_membership_outbox"
FOR EACH ROW EXECUTE FUNCTION c360_guard_membership_outbox_update();

CREATE FUNCTION c360_guard_membership_head_update() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.segment_id IS DISTINCT FROM OLD.segment_id
     OR NEW.membership_revision < OLD.membership_revision
     OR NEW.membership_revision > OLD.membership_revision + 1
     OR NEW.lineage_revision < OLD.lineage_revision THEN
    RAISE EXCEPTION 'invalid c360 membership head CAS update';
  END IF;
  IF NEW.membership_revision = OLD.membership_revision
     AND NOT (OLD.state = 'OUT' AND NEW.state = 'OUT' AND NEW.entry_id IS NULL) THEN
    RAISE EXCEPTION 'same-revision c360 membership update allowed only for OUT projection refresh';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "c360_membership_head_guard"
BEFORE UPDATE ON "c360_segment_membership_heads"
FOR EACH ROW EXECUTE FUNCTION c360_guard_membership_head_update();

CREATE FUNCTION c360_guard_identity_head_update() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
     OR NEW.lineage_revision <> OLD.lineage_revision + 1 THEN
    RAISE EXCEPTION 'invalid c360 identity head CAS update';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "c360_identity_head_guard"
BEFORE UPDATE ON "c360_identity_heads"
FOR EACH ROW EXECUTE FUNCTION c360_guard_identity_head_update();

-- ทุก table ผูก tenant ผ่าน transaction-local app.tenant_id; application role ไม่ bypass RLS.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'c360_segment_membership_heads', 'c360_segment_membership_changes',
    'c360_segment_membership_outbox', 'c360_segment_evidence',
    'c360_evidence_access_audit', 'c360_membership_command_receipts',
    'c360_membership_quarantine', 'c360_identity_heads', 'c360_identity_lineage'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO dcontact_app', t);
    EXECUTE format('REVOKE DELETE ON %I FROM dcontact_app', t);
  END LOOP;
END $$;

REVOKE UPDATE ON "c360_segment_membership_changes" FROM dcontact_app;
REVOKE UPDATE ON "c360_segment_evidence" FROM dcontact_app;
REVOKE UPDATE ON "c360_evidence_access_audit" FROM dcontact_app;
REVOKE UPDATE ON "c360_membership_command_receipts" FROM dcontact_app;
REVOKE UPDATE ON "c360_membership_quarantine" FROM dcontact_app;
REVOKE UPDATE ON "c360_identity_lineage" FROM dcontact_app;
