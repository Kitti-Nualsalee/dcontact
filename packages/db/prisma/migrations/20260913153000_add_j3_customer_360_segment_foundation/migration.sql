-- J3.2 (#213): Customer 360-owned immutable segment definitions, typed fact snapshots
-- และ durable deterministic evaluation checkpoints. ยังไม่มี membership/outbox/Journey effect.

CREATE TYPE "C360SegmentDefinitionStatus" AS ENUM ('DRAFT', 'PUBLISHED', 'SUPERSEDED');
CREATE TYPE "C360SegmentEvaluationOutcome" AS ENUM ('MATCH', 'NO_MATCH', 'ERROR');

CREATE TABLE "c360_segment_definitions" (
  "id"                UUID NOT NULL,
  "tenant_id"         UUID NOT NULL,
  "segment_id"        TEXT NOT NULL,
  "version"           INTEGER NOT NULL,
  "status"            "C360SegmentDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
  "definition"        JSONB NOT NULL,
  "content_digest"    CHAR(64) NOT NULL,
  "evaluator_version" TEXT NOT NULL,
  "correlation_id"    TEXT NOT NULL,
  "effective_from"    TIMESTAMP(3),
  "effective_to"      TIMESTAMP(3),
  "published_at"      TIMESTAMP(3),
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "c360_segment_definitions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_segment_definitions_version_check" CHECK ("version" >= 1),
  CONSTRAINT "c360_segment_definitions_digest_check" CHECK ("content_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_segment_definitions_interval_check" CHECK ("effective_to" IS NULL OR "effective_from" < "effective_to"),
  CONSTRAINT "c360_segment_definitions_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_segment_definitions_tenant_id_id_key"
  ON "c360_segment_definitions"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_segment_definitions_tenant_id_segment_id_version_key"
  ON "c360_segment_definitions"("tenant_id", "segment_id", "version");
CREATE INDEX "c360_segment_definitions_tenant_segment_status_version_idx"
  ON "c360_segment_definitions"("tenant_id", "segment_id", "status", "version" DESC);
CREATE UNIQUE INDEX "c360_segment_definitions_one_published_per_segment"
  ON "c360_segment_definitions"("tenant_id", "segment_id") WHERE "status" = 'PUBLISHED';

CREATE TABLE "c360_segment_definition_heads" (
  "tenant_id"       UUID NOT NULL,
  "segment_id"      TEXT NOT NULL,
  "head_version"    INTEGER NOT NULL DEFAULT 0,
  "current_version" INTEGER,
  "current_digest"  CHAR(64),
  "updated_at"      TIMESTAMP(3) NOT NULL,

  CONSTRAINT "c360_segment_definition_heads_pkey" PRIMARY KEY ("tenant_id", "segment_id"),
  CONSTRAINT "c360_segment_definition_heads_version_check" CHECK ("head_version" >= 0),
  CONSTRAINT "c360_segment_definition_heads_binding_check"
    CHECK (("current_version" IS NULL) = ("current_digest" IS NULL)),
  CONSTRAINT "c360_segment_definition_heads_digest_check"
    CHECK ("current_digest" IS NULL OR "current_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_segment_definition_heads_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_segment_definition_heads_current_definition_fkey"
    FOREIGN KEY ("tenant_id", "segment_id", "current_version")
    REFERENCES "c360_segment_definitions"("tenant_id", "segment_id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "c360_fact_snapshots" (
  "id"               UUID NOT NULL,
  "tenant_id"        UUID NOT NULL,
  "contact_id"       UUID NOT NULL,
  "snapshot_version" INTEGER NOT NULL,
  "attributes"       JSONB NOT NULL,
  "computed"         JSONB NOT NULL,
  "source_cutoff_at" TIMESTAMP(3) NOT NULL,
  "content_digest"   CHAR(64) NOT NULL,
  "correlation_id"   TEXT NOT NULL,
  "captured_at"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "c360_fact_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_fact_snapshots_version_check" CHECK ("snapshot_version" >= 1),
  CONSTRAINT "c360_fact_snapshots_digest_check" CHECK ("content_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_fact_snapshots_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_fact_snapshots_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_fact_snapshots_tenant_id_id_key"
  ON "c360_fact_snapshots"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_fact_snapshots_tenant_id_contact_id_snapshot_version_key"
  ON "c360_fact_snapshots"("tenant_id", "contact_id", "snapshot_version");
CREATE INDEX "c360_fact_snapshots_tenant_contact_captured_idx"
  ON "c360_fact_snapshots"("tenant_id", "contact_id", "captured_at" DESC);

CREATE TABLE "c360_segment_evaluations" (
  "id"                         UUID NOT NULL,
  "tenant_id"                  UUID NOT NULL,
  "contact_id"                 UUID NOT NULL,
  "segment_id"                 TEXT NOT NULL,
  "segment_definition_version" INTEGER NOT NULL,
  "snapshot_version"           INTEGER NOT NULL,
  "outcome"                    "C360SegmentEvaluationOutcome" NOT NULL,
  "matched"                    BOOLEAN,
  "error_code"                 TEXT,
  "input_digest"               CHAR(64) NOT NULL,
  "evaluation_digest"          CHAR(64) NOT NULL,
  "evaluator_version"          TEXT NOT NULL,
  "evaluated_at"               TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "c360_segment_evaluations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "c360_segment_evaluations_versions_check"
    CHECK ("segment_definition_version" >= 1 AND "snapshot_version" >= 1),
  CONSTRAINT "c360_segment_evaluations_digest_check"
    CHECK ("input_digest" ~ '^[a-f0-9]{64}$' AND "evaluation_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "c360_segment_evaluations_outcome_check" CHECK (
    ("outcome" IN ('MATCH', 'NO_MATCH') AND "matched" IS NOT NULL AND "error_code" IS NULL)
    OR ("outcome" = 'ERROR' AND "matched" IS NULL AND "error_code" IS NOT NULL)
  ),
  CONSTRAINT "c360_segment_evaluations_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_segment_evaluations_definition_fkey"
    FOREIGN KEY ("tenant_id", "segment_id", "segment_definition_version")
    REFERENCES "c360_segment_definitions"("tenant_id", "segment_id", "version")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "c360_segment_evaluations_snapshot_fkey"
    FOREIGN KEY ("tenant_id", "contact_id", "snapshot_version")
    REFERENCES "c360_fact_snapshots"("tenant_id", "contact_id", "snapshot_version")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "c360_segment_evaluations_tenant_id_id_key"
  ON "c360_segment_evaluations"("tenant_id", "id");
CREATE UNIQUE INDEX "c360_segment_evaluations_exact_input_key"
  ON "c360_segment_evaluations"(
    "tenant_id", "contact_id", "segment_id", "segment_definition_version", "snapshot_version"
  );
CREATE INDEX "c360_segment_evaluations_tenant_segment_definition_evaluated_idx"
  ON "c360_segment_evaluations"("tenant_id", "segment_id", "segment_definition_version", "evaluated_at");

-- Definition content immutable ตั้งแต่สร้าง; UPDATE ใช้ได้เฉพาะ publish/supersede interval
CREATE FUNCTION c360_reject_invalid_segment_definition_update() RETURNS trigger AS $$
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.segment_id IS DISTINCT FROM OLD.segment_id
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.definition IS DISTINCT FROM OLD.definition
     OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
     OR NEW.evaluator_version IS DISTINCT FROM OLD.evaluator_version
     OR NEW.correlation_id IS DISTINCT FROM OLD.correlation_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'c360 segment definition content is immutable';
  END IF;

  IF OLD.status = 'DRAFT'
     AND NEW.status = 'PUBLISHED'
     AND OLD.effective_from IS NULL
     AND NEW.effective_from IS NOT NULL
     AND NEW.effective_to IS NULL
     AND NEW.published_at IS NOT NULL THEN
    RETURN NEW;
  END IF;

  IF OLD.status = 'PUBLISHED'
     AND NEW.status = 'SUPERSEDED'
     AND NEW.effective_from IS NOT DISTINCT FROM OLD.effective_from
     AND NEW.published_at IS NOT DISTINCT FROM OLD.published_at
     AND OLD.effective_to IS NULL
     AND NEW.effective_to IS NOT NULL THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'c360 segment definition allows only DRAFT -> PUBLISHED -> SUPERSEDED';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "c360_segment_definition_immutable"
BEFORE UPDATE ON "c360_segment_definitions"
FOR EACH ROW EXECUTE FUNCTION c360_reject_invalid_segment_definition_update();

CREATE FUNCTION c360_reject_immutable_row_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'c360 owner fact is immutable';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "c360_fact_snapshot_immutable"
BEFORE UPDATE ON "c360_fact_snapshots"
FOR EACH ROW EXECUTE FUNCTION c360_reject_immutable_row_update();

CREATE TRIGGER "c360_segment_evaluation_immutable"
BEFORE UPDATE ON "c360_segment_evaluations"
FOR EACH ROW EXECUTE FUNCTION c360_reject_immutable_row_update();

-- Tenant RLS ผูกกับ app.tenant_id; cross-tenant read จึงคืน NOT_FOUND โดยไม่รั่ว existence
ALTER TABLE "c360_segment_definitions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "c360_segment_definition_heads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "c360_fact_snapshots" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "c360_segment_evaluations" ENABLE ROW LEVEL SECURITY;

CREATE POLICY "tenant_isolation" ON "c360_segment_definitions"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY "tenant_isolation" ON "c360_segment_definition_heads"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY "tenant_isolation" ON "c360_fact_snapshots"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY "tenant_isolation" ON "c360_segment_evaluations"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "c360_segment_definitions" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "c360_segment_definition_heads" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "c360_fact_snapshots" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "c360_segment_evaluations" TO dcontact_app;

REVOKE DELETE ON "c360_segment_definitions" FROM dcontact_app;
REVOKE DELETE ON "c360_segment_definition_heads" FROM dcontact_app;
REVOKE UPDATE, DELETE ON "c360_fact_snapshots" FROM dcontact_app;
REVOKE UPDATE, DELETE ON "c360_segment_evaluations" FROM dcontact_app;
