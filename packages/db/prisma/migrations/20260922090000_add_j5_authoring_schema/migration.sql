-- J5.1 (#339): authoring/template/review/receipt/audit/outbox/rollout และ IAM authoring store
-- ตาม Phase Spec #337 §2
--
-- Expand ล้วน: `jr_journey_definitions` ยังเป็น immutable runtime-version store เดิมและไม่ถูกแตะ
-- ไม่มีการ backfill ใน migration นี้ — การสร้าง head/draft จาก definition เดิมต้องใช้ importer
-- ของ compiler (J5.2) และไม่มี row ใด = feature ปิดอยู่ (rollout ไม่มี row = DISABLED)
--
-- กติกาทั้งไฟล์:
-- - FK ข้าม entity ใช้ (tenant_id, ...) เสมอ ไม่ใช้ id เดี่ยว
-- - ทุกตาราง ENABLE RLS + policy tenant_isolation ทั้ง USING/WITH CHECK
-- - dcontact_app ลบไม่ได้ทุกตาราง; ตาราง append-only แก้ไม่ได้ทั้งที่ grant และ trigger
-- - platform built-in template ไม่มี tenant row แบบ nullable/sentinel ใน DB

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "JrJourneyLifecycle" AS ENUM ('DRAFT_ONLY', 'ACTIVE', 'PAUSED', 'DEPRECATED');
CREATE TYPE "JrAuthoringResourceKind" AS ENUM ('JOURNEY', 'TEMPLATE');
CREATE TYPE "JrAuthoringReceiptState" AS ENUM ('PENDING', 'COMMITTED', 'FAILED');
CREATE TYPE "JrReviewState" AS ENUM ('IN_REVIEW', 'APPROVED', 'CHANGES_REQUESTED', 'REJECTED', 'SUPERSEDED');
CREATE TYPE "JrReviewDecision" AS ENUM ('APPROVE', 'REQUEST_CHANGES', 'REJECT');
CREATE TYPE "JrTemplateLifecycle" AS ENUM ('DRAFT_ONLY', 'ACTIVE', 'DEPRECATED', 'ARCHIVED');
CREATE TYPE "JrTemplateVisibility" AS ENUM ('TEAM', 'TENANT');
CREATE TYPE "JrTemplateOrigin" AS ENUM ('TENANT', 'PLATFORM_BUILTIN');
CREATE TYPE "JrTemplateUpgradeState" AS ENUM ('PROPOSED', 'APPLIED', 'STALE');
CREATE TYPE "JrAuthoringOutboxState" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');
CREATE TYPE "JrAuthoringRolloutStage" AS ENUM ('DISABLED', 'INTERNAL_SYNTHETIC', 'SELECTED_TENANT', 'CONTROLLED_AUTHORING');

-- ── 1. jr_journey_heads ──────────────────────────────────────────────────────

CREATE TABLE "jr_journey_heads" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "journey_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "owner_team_id" UUID NOT NULL,
  "lifecycle" "JrJourneyLifecycle" NOT NULL DEFAULT 'DRAFT_ONLY',
  "version" INTEGER NOT NULL DEFAULT 1,
  "current_draft_id" UUID NOT NULL,
  "current_draft_revision" INTEGER NOT NULL,
  "current_draft_digest" CHAR(64) NOT NULL,
  "active_definition_id" UUID,
  "active_version" INTEGER,
  "active_runtime_hash" CHAR(64),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "jr_journey_heads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_journey_heads_version_check" CHECK ("version" >= 1 AND "current_draft_revision" >= 1),
  CONSTRAINT "jr_journey_heads_digest_check" CHECK (
    "current_draft_digest" ~ '^[a-f0-9]{64}$'
    AND ("active_runtime_hash" IS NULL OR "active_runtime_hash" ~ '^[a-f0-9]{64}$')
  ),
  -- active ทั้งชุดต้องมีครบหรือไม่มีเลย และ DRAFT_ONLY คือยังไม่เคย publish
  CONSTRAINT "jr_journey_heads_active_check" CHECK (
    (
      "active_definition_id" IS NULL AND "active_version" IS NULL AND "active_runtime_hash" IS NULL
      AND "lifecycle" = 'DRAFT_ONLY'
    )
    OR (
      "active_definition_id" IS NOT NULL AND "active_version" IS NOT NULL
      AND "active_runtime_hash" IS NOT NULL AND "active_version" >= 1
      AND "lifecycle" <> 'DRAFT_ONLY'
    )
  )
);
CREATE UNIQUE INDEX "jr_journey_heads_tenant_id_id_key" ON "jr_journey_heads"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_journey_heads_tenant_journey_key" ON "jr_journey_heads"("tenant_id", "journey_id");
CREATE INDEX "jr_journey_heads_team_lifecycle_idx" ON "jr_journey_heads"("tenant_id", "owner_team_id", "lifecycle");

-- ── 2. jr_journey_drafts (append-only revision) ──────────────────────────────

CREATE TABLE "jr_journey_drafts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "journey_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "base_published_version" INTEGER,
  "schema_version" TEXT NOT NULL,
  "registry_version" TEXT NOT NULL,
  "document" JSONB NOT NULL,
  "content_digest" CHAR(64) NOT NULL,
  "created_by_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_journey_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_journey_drafts_revision_check" CHECK (
    "revision" >= 1 AND ("base_published_version" IS NULL OR "base_published_version" >= 1)
  ),
  CONSTRAINT "jr_journey_drafts_digest_check" CHECK ("content_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "jr_journey_drafts_document_check" CHECK (jsonb_typeof("document") = 'object')
);
CREATE UNIQUE INDEX "jr_journey_drafts_tenant_id_id_key" ON "jr_journey_drafts"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_journey_drafts_revision_key" ON "jr_journey_drafts"("tenant_id", "journey_id", "revision");
-- target ของ FK จาก head: บังคับว่า draft ที่ head ชี้เป็นของ journey เดียวกันและ revision/digest ตรงจริง
CREATE UNIQUE INDEX "jr_journey_drafts_binding_key" ON "jr_journey_drafts"("tenant_id", "journey_id", "id", "revision", "content_digest");
CREATE INDEX "jr_journey_drafts_created_idx" ON "jr_journey_drafts"("tenant_id", "journey_id", "created_at");

-- ── 3. jr_authoring_command_receipts ─────────────────────────────────────────

CREATE TABLE "jr_authoring_command_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "command_name" TEXT NOT NULL,
  "resource_kind" "JrAuthoringResourceKind" NOT NULL,
  "resource_id" UUID NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "state" "JrAuthoringReceiptState" NOT NULL DEFAULT 'PENDING',
  "http_status" INTEGER,
  "response" JSONB,
  "error_code" TEXT,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3),
  CONSTRAINT "jr_authoring_command_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_authoring_command_receipts_hash_check" CHECK ("request_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "jr_authoring_command_receipts_state_check" CHECK (
    ("state" = 'PENDING' AND "completed_at" IS NULL AND "http_status" IS NULL AND "error_code" IS NULL)
    OR ("state" = 'COMMITTED' AND "completed_at" IS NOT NULL AND "http_status" BETWEEN 200 AND 299 AND "error_code" IS NULL)
    OR ("state" = 'FAILED' AND "completed_at" IS NOT NULL AND "http_status" BETWEEN 400 AND 599 AND "error_code" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "jr_authoring_command_receipts_tenant_id_id_key" ON "jr_authoring_command_receipts"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_authoring_command_receipts_idempotency_key" ON "jr_authoring_command_receipts"("tenant_id", "idempotency_key");
CREATE INDEX "jr_authoring_command_receipts_resource_idx" ON "jr_authoring_command_receipts"("tenant_id", "resource_kind", "resource_id", "created_at");

-- ── 4. jr_review_candidates ──────────────────────────────────────────────────

CREATE TABLE "jr_review_candidates" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "resource_kind" "JrAuthoringResourceKind" NOT NULL,
  "resource_id" UUID NOT NULL,
  "draft_revision" INTEGER NOT NULL,
  "draft_digest" CHAR(64) NOT NULL,
  "compile_digest" CHAR(64) NOT NULL,
  "runtime_hash" CHAR(64) NOT NULL,
  "base_head_version" INTEGER NOT NULL,
  "base_head_digest" CHAR(64),
  "reference_digest" CHAR(64) NOT NULL,
  "capability_digest" CHAR(64) NOT NULL,
  "maker_subject_id" TEXT NOT NULL,
  "maker_authorization_epoch" INTEGER NOT NULL,
  "maker_scope_version" INTEGER NOT NULL,
  "state" "JrReviewState" NOT NULL DEFAULT 'IN_REVIEW',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "jr_review_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_review_candidates_version_check" CHECK (
    "draft_revision" >= 1 AND "base_head_version" >= 1
    AND "maker_authorization_epoch" >= 0 AND "maker_scope_version" >= 0
  ),
  CONSTRAINT "jr_review_candidates_digest_check" CHECK (
    "draft_digest" ~ '^[a-f0-9]{64}$' AND "compile_digest" ~ '^[a-f0-9]{64}$'
    AND "runtime_hash" ~ '^[a-f0-9]{64}$' AND "reference_digest" ~ '^[a-f0-9]{64}$'
    AND "capability_digest" ~ '^[a-f0-9]{64}$'
    AND ("base_head_digest" IS NULL OR "base_head_digest" ~ '^[a-f0-9]{64}$')
  )
);
CREATE UNIQUE INDEX "jr_review_candidates_tenant_id_id_key" ON "jr_review_candidates"("tenant_id", "id");
-- resource หนึ่งตัวมี candidate ที่กำลัง review ได้ใบเดียว
CREATE UNIQUE INDEX "jr_review_candidates_one_in_review_key"
  ON "jr_review_candidates"("tenant_id", "resource_kind", "resource_id") WHERE "state" = 'IN_REVIEW';
CREATE INDEX "jr_review_candidates_resource_idx" ON "jr_review_candidates"("tenant_id", "resource_kind", "resource_id", "state");

-- ── 5. jr_review_decisions (append-only) ─────────────────────────────────────

CREATE TABLE "jr_review_decisions" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "candidate_id" UUID NOT NULL,
  "decision" "JrReviewDecision" NOT NULL,
  "reviewer_subject_id" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "capability_source" TEXT NOT NULL,
  "delegation_id" UUID,
  "authorization_epoch" INTEGER NOT NULL,
  "scope_version" INTEGER NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "decided_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_review_decisions_pkey" PRIMARY KEY ("id"),
  -- vote นับได้เฉพาะ capability review; delegation ใช้ approve ไม่ได้ (#331 §6)
  CONSTRAINT "jr_review_decisions_capability_check" CHECK (
    "capability" IN ('journey.review', 'template.review') AND "delegation_id" IS NULL
  ),
  CONSTRAINT "jr_review_decisions_version_check" CHECK ("authorization_epoch" >= 0 AND "scope_version" >= 0),
  CONSTRAINT "jr_review_decisions_reason_check" CHECK ("reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
CREATE UNIQUE INDEX "jr_review_decisions_tenant_id_id_key" ON "jr_review_decisions"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_review_decisions_reviewer_key" ON "jr_review_decisions"("tenant_id", "candidate_id", "reviewer_subject_id");
CREATE INDEX "jr_review_decisions_decided_idx" ON "jr_review_decisions"("tenant_id", "candidate_id", "decided_at");

-- ── 6. jr_authoring_audit (append-only) ──────────────────────────────────────

CREATE TABLE "jr_authoring_audit" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "resource_kind" "JrAuthoringResourceKind" NOT NULL,
  "resource_id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "actor_subject_id" TEXT NOT NULL,
  "reason_code" TEXT NOT NULL,
  "before_digest" CHAR(64),
  "after_digest" CHAR(64),
  "correlation_id" TEXT NOT NULL,
  "evidence_ref" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_authoring_audit_pkey" PRIMARY KEY ("id"),
  -- action/reason เป็น closed code เท่านั้น ห้าม free text ที่อาจมี PII
  CONSTRAINT "jr_authoring_audit_code_check" CHECK (
    "action" ~ '^[A-Z][A-Z0-9_]*$' AND "reason_code" ~ '^[A-Z][A-Z0-9_]*$'
  ),
  CONSTRAINT "jr_authoring_audit_digest_check" CHECK (
    ("before_digest" IS NULL OR "before_digest" ~ '^[a-f0-9]{64}$')
    AND ("after_digest" IS NULL OR "after_digest" ~ '^[a-f0-9]{64}$')
  )
);
CREATE UNIQUE INDEX "jr_authoring_audit_tenant_id_id_key" ON "jr_authoring_audit"("tenant_id", "id");
CREATE INDEX "jr_authoring_audit_resource_idx" ON "jr_authoring_audit"("tenant_id", "resource_kind", "resource_id", "occurred_at");

-- ── 7. jr_authoring_outbox ───────────────────────────────────────────────────

CREATE TABLE "jr_authoring_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "resource_kind" "JrAuthoringResourceKind" NOT NULL,
  "resource_id" UUID NOT NULL,
  "aggregate_version" INTEGER NOT NULL,
  "event_type" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "state" "JrAuthoringOutboxState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "sent_at" TIMESTAMP(3),
  "last_error" TEXT,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_authoring_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_authoring_outbox_values_check" CHECK (
    "aggregate_version" >= 1 AND "attempts" >= 0 AND "payload_hash" ~ '^[a-f0-9]{64}$'
    AND jsonb_typeof("payload") = 'object'
  ),
  -- lease มาเป็นคู่ และ SENT ต้องมีเวลาส่ง
  CONSTRAINT "jr_authoring_outbox_state_check" CHECK (
    (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL))
    AND (("state" = 'SENT') = ("sent_at" IS NOT NULL))
    AND ("state" = 'PROCESSING' OR "lease_owner" IS NULL)
  )
);
CREATE UNIQUE INDEX "jr_authoring_outbox_tenant_id_id_key" ON "jr_authoring_outbox"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_authoring_outbox_event_key" ON "jr_authoring_outbox"("tenant_id", "event_id");
CREATE INDEX "jr_authoring_outbox_state_idx" ON "jr_authoring_outbox"("tenant_id", "state", "available_at");

-- ── 8. jr_template_heads ─────────────────────────────────────────────────────

CREATE TABLE "jr_template_heads" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "template_id" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "owner_team_id" UUID NOT NULL,
  "visibility" "JrTemplateVisibility" NOT NULL DEFAULT 'TEAM',
  "lifecycle" "JrTemplateLifecycle" NOT NULL DEFAULT 'DRAFT_ONLY',
  "version" INTEGER NOT NULL DEFAULT 1,
  "current_draft_id" UUID NOT NULL,
  "current_draft_revision" INTEGER NOT NULL,
  "current_draft_digest" CHAR(64) NOT NULL,
  "active_version" INTEGER,
  "active_version_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "jr_template_heads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_template_heads_version_check" CHECK ("version" >= 1 AND "current_draft_revision" >= 1),
  CONSTRAINT "jr_template_heads_digest_check" CHECK ("current_draft_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "jr_template_heads_active_check" CHECK (
    ("active_version" IS NULL AND "active_version_id" IS NULL AND "lifecycle" = 'DRAFT_ONLY')
    OR ("active_version" IS NOT NULL AND "active_version_id" IS NOT NULL AND "active_version" >= 1
        AND "lifecycle" <> 'DRAFT_ONLY')
  )
);
CREATE UNIQUE INDEX "jr_template_heads_tenant_id_id_key" ON "jr_template_heads"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_template_heads_tenant_template_key" ON "jr_template_heads"("tenant_id", "template_id");
CREATE INDEX "jr_template_heads_team_visibility_idx" ON "jr_template_heads"("tenant_id", "owner_team_id", "visibility", "lifecycle");

-- ── 9. jr_template_drafts (append-only revision) ─────────────────────────────

CREATE TABLE "jr_template_drafts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "template_id" UUID NOT NULL,
  "revision" INTEGER NOT NULL,
  "schema_version" TEXT NOT NULL,
  "registry_version" TEXT NOT NULL,
  "document" JSONB NOT NULL,
  "parameter_schema" JSONB NOT NULL,
  "content_digest" CHAR(64) NOT NULL,
  "created_by_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_template_drafts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_template_drafts_revision_check" CHECK ("revision" >= 1),
  CONSTRAINT "jr_template_drafts_digest_check" CHECK ("content_digest" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "jr_template_drafts_document_check" CHECK (
    jsonb_typeof("document") = 'object' AND jsonb_typeof("parameter_schema") = 'array'
  )
);
CREATE UNIQUE INDEX "jr_template_drafts_tenant_id_id_key" ON "jr_template_drafts"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_template_drafts_revision_key" ON "jr_template_drafts"("tenant_id", "template_id", "revision");
CREATE UNIQUE INDEX "jr_template_drafts_binding_key" ON "jr_template_drafts"("tenant_id", "template_id", "id", "revision", "content_digest");
CREATE INDEX "jr_template_drafts_created_idx" ON "jr_template_drafts"("tenant_id", "template_id", "created_at");

-- ── 10. jr_template_versions (immutable) ─────────────────────────────────────

CREATE TABLE "jr_template_versions" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "template_id" UUID NOT NULL,
  "version" INTEGER NOT NULL,
  "origin" "JrTemplateOrigin" NOT NULL DEFAULT 'TENANT',
  "visibility" "JrTemplateVisibility" NOT NULL,
  "owner_team_id" UUID NOT NULL,
  "schema_version" TEXT NOT NULL,
  "registry_version" TEXT NOT NULL,
  "document" JSONB NOT NULL,
  "parameter_schema" JSONB NOT NULL,
  "content_digest" CHAR(64) NOT NULL,
  "compile_digest" CHAR(64) NOT NULL,
  "node_mapping_digest" CHAR(64) NOT NULL,
  "published_by_ref" TEXT NOT NULL,
  "published_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_template_versions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_template_versions_version_check" CHECK ("version" >= 1),
  -- built-in resolve จาก release asset เท่านั้น ห้ามมีแถวในตาราง tenant (Phase Spec §2 ข้อ 10)
  CONSTRAINT "jr_template_versions_origin_check" CHECK ("origin" = 'TENANT'),
  CONSTRAINT "jr_template_versions_digest_check" CHECK (
    "content_digest" ~ '^[a-f0-9]{64}$' AND "compile_digest" ~ '^[a-f0-9]{64}$'
    AND "node_mapping_digest" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "jr_template_versions_document_check" CHECK (
    jsonb_typeof("document") = 'object' AND jsonb_typeof("parameter_schema") = 'array'
  )
);
CREATE UNIQUE INDEX "jr_template_versions_tenant_id_id_key" ON "jr_template_versions"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_template_versions_version_key" ON "jr_template_versions"("tenant_id", "template_id", "version");
CREATE INDEX "jr_template_versions_visibility_idx" ON "jr_template_versions"("tenant_id", "visibility", "published_at");

-- ── 11. jr_template_provenance (append-only) ─────────────────────────────────

CREATE TABLE "jr_template_provenance" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "journey_id" UUID NOT NULL,
  "draft_revision" INTEGER NOT NULL,
  "template_origin" "JrTemplateOrigin" NOT NULL,
  "source_template_id" UUID NOT NULL,
  "source_template_version" INTEGER NOT NULL,
  "source_content_digest" CHAR(64) NOT NULL,
  "binding_digest" CHAR(64) NOT NULL,
  "node_mapping" JSONB NOT NULL,
  "node_mapping_digest" CHAR(64) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_template_provenance_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_template_provenance_version_check" CHECK ("draft_revision" >= 1 AND "source_template_version" >= 1),
  CONSTRAINT "jr_template_provenance_digest_check" CHECK (
    "source_content_digest" ~ '^[a-f0-9]{64}$' AND "binding_digest" ~ '^[a-f0-9]{64}$'
    AND "node_mapping_digest" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "jr_template_provenance_mapping_check" CHECK (jsonb_typeof("node_mapping") = 'object')
);
CREATE UNIQUE INDEX "jr_template_provenance_tenant_id_id_key" ON "jr_template_provenance"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_template_provenance_draft_key" ON "jr_template_provenance"("tenant_id", "journey_id", "draft_revision");
CREATE INDEX "jr_template_provenance_source_idx" ON "jr_template_provenance"("tenant_id", "source_template_id", "source_template_version");

-- ── 12. jr_template_upgrade_applications ─────────────────────────────────────

CREATE TABLE "jr_template_upgrade_applications" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "journey_id" UUID NOT NULL,
  "from_template_version" INTEGER NOT NULL,
  "to_template_version" INTEGER NOT NULL,
  "base_draft_digest" CHAR(64) NOT NULL,
  "local_draft_digest" CHAR(64) NOT NULL,
  "proposed_draft_digest" CHAR(64) NOT NULL,
  "conflict_digest" CHAR(64) NOT NULL,
  "state" "JrTemplateUpgradeState" NOT NULL DEFAULT 'PROPOSED',
  "request_hash" CHAR(64) NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_at" TIMESTAMP(3),
  CONSTRAINT "jr_template_upgrade_applications_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_template_upgrade_applications_version_check" CHECK (
    "from_template_version" >= 1 AND "to_template_version" > "from_template_version"
  ),
  CONSTRAINT "jr_template_upgrade_applications_digest_check" CHECK (
    "base_draft_digest" ~ '^[a-f0-9]{64}$' AND "local_draft_digest" ~ '^[a-f0-9]{64}$'
    AND "proposed_draft_digest" ~ '^[a-f0-9]{64}$' AND "conflict_digest" ~ '^[a-f0-9]{64}$'
    AND "request_hash" ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT "jr_template_upgrade_applications_state_check" CHECK (
    ("state" = 'APPLIED') = ("applied_at" IS NOT NULL)
  )
);
CREATE UNIQUE INDEX "jr_template_upgrade_applications_tenant_id_id_key" ON "jr_template_upgrade_applications"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_template_upgrade_applications_idempotency_key" ON "jr_template_upgrade_applications"("tenant_id", "idempotency_key");
CREATE INDEX "jr_template_upgrade_applications_journey_idx" ON "jr_template_upgrade_applications"("tenant_id", "journey_id", "created_at");

-- ── 13. jr_authoring_rollout_state ───────────────────────────────────────────

CREATE TABLE "jr_authoring_rollout_state" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "stage" "JrAuthoringRolloutStage" NOT NULL DEFAULT 'DISABLED',
  "canvas_write_enabled" BOOLEAN NOT NULL DEFAULT false,
  "template_catalog_enabled" BOOLEAN NOT NULL DEFAULT false,
  "template_upgrade_enabled" BOOLEAN NOT NULL DEFAULT false,
  "publish_ui_enabled" BOOLEAN NOT NULL DEFAULT false,
  "mutation_frozen" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_ref" TEXT NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "jr_authoring_rollout_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_authoring_rollout_state_version_check" CHECK ("version" >= 1),
  -- DISABLED เปิด feature ใดไม่ได้เลย
  CONSTRAINT "jr_authoring_rollout_state_stage_check" CHECK (
    "stage" <> 'DISABLED'
    OR NOT ("canvas_write_enabled" OR "template_catalog_enabled" OR "template_upgrade_enabled" OR "publish_ui_enabled")
  )
);
CREATE UNIQUE INDEX "jr_authoring_rollout_state_tenant_id_id_key" ON "jr_authoring_rollout_state"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_authoring_rollout_state_tenant_key" ON "jr_authoring_rollout_state"("tenant_id");

-- ── 15. IAM authoring store ──────────────────────────────────────────────────

CREATE TABLE "iam_authoring_subjects" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "subject_id" TEXT NOT NULL,
  "authentication_strength" TEXT NOT NULL,
  "direct_review_authority" BOOLEAN NOT NULL DEFAULT false,
  "is_service_principal" BOOLEAN NOT NULL DEFAULT false,
  "authorization_epoch" INTEGER NOT NULL DEFAULT 1,
  "scope_version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "iam_authoring_subjects_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iam_authoring_subjects_values_check" CHECK (
    "authentication_strength" IN ('STANDARD', 'STRONG')
    AND "authorization_epoch" >= 1 AND "scope_version" >= 1
    -- service principal ไม่มีสิทธิ์ review ตรง (นับ quorum ไม่ได้)
    AND NOT ("is_service_principal" AND "direct_review_authority")
  )
);
CREATE UNIQUE INDEX "iam_authoring_subjects_tenant_id_id_key" ON "iam_authoring_subjects"("tenant_id", "id");
CREATE UNIQUE INDEX "iam_authoring_subjects_subject_key" ON "iam_authoring_subjects"("tenant_id", "subject_id");

CREATE TABLE "iam_authoring_capability_grants" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "subject_id" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "scope_kind" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "expires_at" TIMESTAMP(3),
  "granted_by_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_authoring_capability_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iam_authoring_capability_grants_capability_check" CHECK ("capability" IN (
    'journey.read', 'journey.edit', 'journey.review', 'journey.publish', 'journey.lifecycle',
    'journey.transfer', 'template.read', 'template.edit', 'template.review', 'template.publish',
    'template.lifecycle', 'template.visibility', 'template.upgrade'
  )),
  -- scope TENANT อ้าง tenant ตัวเองเท่านั้น จึงไม่ต้องใช้ scope_id แบบ null หรือ wildcard
  CONSTRAINT "iam_authoring_capability_grants_scope_check" CHECK (
    ("scope_kind" = 'TENANT' AND "scope_id" = "tenant_id"::text)
    OR ("scope_kind" IN ('TEAM', 'JOURNEY', 'TEMPLATE')
        AND "scope_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')
  )
);
CREATE UNIQUE INDEX "iam_authoring_capability_grants_tenant_id_id_key" ON "iam_authoring_capability_grants"("tenant_id", "id");
CREATE UNIQUE INDEX "iam_authoring_capability_grants_scope_key"
  ON "iam_authoring_capability_grants"("tenant_id", "subject_id", "capability", "scope_kind", "scope_id");

CREATE TABLE "iam_authoring_delegations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "delegator_subject_id" TEXT NOT NULL,
  "delegate_subject_id" TEXT NOT NULL,
  "capability" TEXT NOT NULL,
  "scope_kind" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "starts_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_authoring_delegations_pkey" PRIMARY KEY ("id"),
  -- จำกัด read/edit(+submit), exact resource/team scope, ไม่เกิน 8 ชั่วโมง, มอบให้ตัวเองไม่ได้ (#331 §6)
  CONSTRAINT "iam_authoring_delegations_capability_check" CHECK (
    "capability" IN ('journey.read', 'journey.edit', 'template.read', 'template.edit')
  ),
  CONSTRAINT "iam_authoring_delegations_scope_check" CHECK (
    "scope_kind" IN ('TEAM', 'JOURNEY', 'TEMPLATE')
    AND "scope_id" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ),
  CONSTRAINT "iam_authoring_delegations_window_check" CHECK (
    "expires_at" > "starts_at" AND "expires_at" <= "starts_at" + INTERVAL '8 hours'
    AND "delegator_subject_id" <> "delegate_subject_id"
  )
);
CREATE UNIQUE INDEX "iam_authoring_delegations_tenant_id_id_key" ON "iam_authoring_delegations"("tenant_id", "id");
CREATE INDEX "iam_authoring_delegations_delegate_idx" ON "iam_authoring_delegations"("tenant_id", "delegate_subject_id", "expires_at");

CREATE TABLE "iam_authoring_delegation_revocations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "delegation_id" UUID NOT NULL,
  "reason_code" TEXT NOT NULL,
  "revoked_by_ref" TEXT NOT NULL,
  "revoked_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "iam_authoring_delegation_revocations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iam_authoring_delegation_revocations_reason_check" CHECK ("reason_code" ~ '^[A-Z][A-Z0-9_]*$')
);
CREATE UNIQUE INDEX "iam_authoring_delegation_revocations_tenant_id_id_key" ON "iam_authoring_delegation_revocations"("tenant_id", "id");
CREATE UNIQUE INDEX "iam_authoring_delegation_revocations_delegation_key" ON "iam_authoring_delegation_revocations"("tenant_id", "delegation_id");

CREATE TABLE "iam_authoring_scope_versions" (
  "tenant_id" UUID NOT NULL,
  "scope_kind" TEXT NOT NULL,
  "scope_id" TEXT NOT NULL,
  "scope_version" INTEGER NOT NULL DEFAULT 1,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "iam_authoring_scope_versions_pkey" PRIMARY KEY ("tenant_id", "scope_kind", "scope_id"),
  CONSTRAINT "iam_authoring_scope_versions_values_check" CHECK (
    "scope_kind" IN ('TENANT', 'TEAM', 'JOURNEY', 'TEMPLATE') AND "scope_version" >= 1
  )
);

-- ── Foreign keys (composite ทุกเส้น) ─────────────────────────────────────────
-- เส้นที่ต้อง defer (head↔draft, version→head) ใช้ NO ACTION เพราะ RESTRICT ถูกตรวจทันทีแม้ประกาศ
-- DEFERRABLE; การลบถูกกันที่ grant ของ dcontact_app อยู่แล้ว

ALTER TABLE "jr_journey_heads"
  ADD CONSTRAINT "jr_journey_heads_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_journey_heads_owner_team_fkey" FOREIGN KEY ("tenant_id", "owner_team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  -- head กับ draft แรกเกิดใน transaction เดียวกัน จึง defer การตรวจไว้ถึง commit
  -- ผูกทั้ง journey/revision/digest: head ชี้ draft ของ journey อื่นหรือ cache revision ผิดไม่ได้
  ADD CONSTRAINT "jr_journey_heads_current_draft_fkey" FOREIGN KEY ("tenant_id", "journey_id", "current_draft_id", "current_draft_revision", "current_draft_digest") REFERENCES "jr_journey_drafts"("tenant_id", "journey_id", "id", "revision", "content_digest") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "jr_journey_heads_active_definition_fkey" FOREIGN KEY ("tenant_id", "active_definition_id") REFERENCES "jr_journey_definitions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_journey_heads_active_version_fkey" FOREIGN KEY ("tenant_id", "journey_id", "active_version") REFERENCES "jr_journey_definitions"("tenant_id", "journey_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_journey_drafts"
  ADD CONSTRAINT "jr_journey_drafts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_journey_drafts_head_fkey" FOREIGN KEY ("tenant_id", "journey_id") REFERENCES "jr_journey_heads"("tenant_id", "journey_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "jr_authoring_command_receipts"
  ADD CONSTRAINT "jr_authoring_command_receipts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_review_candidates"
  ADD CONSTRAINT "jr_review_candidates_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_review_decisions"
  ADD CONSTRAINT "jr_review_decisions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_review_decisions_candidate_fkey" FOREIGN KEY ("tenant_id", "candidate_id") REFERENCES "jr_review_candidates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_authoring_audit"
  ADD CONSTRAINT "jr_authoring_audit_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_authoring_outbox"
  ADD CONSTRAINT "jr_authoring_outbox_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_template_heads"
  ADD CONSTRAINT "jr_template_heads_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_template_heads_owner_team_fkey" FOREIGN KEY ("tenant_id", "owner_team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_template_heads_current_draft_fkey" FOREIGN KEY ("tenant_id", "template_id", "current_draft_id", "current_draft_revision", "current_draft_digest") REFERENCES "jr_template_drafts"("tenant_id", "template_id", "id", "revision", "content_digest") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "jr_template_heads_active_version_id_fkey" FOREIGN KEY ("tenant_id", "active_version_id") REFERENCES "jr_template_versions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_template_heads_active_version_fkey" FOREIGN KEY ("tenant_id", "template_id", "active_version") REFERENCES "jr_template_versions"("tenant_id", "template_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_template_drafts"
  ADD CONSTRAINT "jr_template_drafts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_template_drafts_head_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "jr_template_heads"("tenant_id", "template_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED;

ALTER TABLE "jr_template_versions"
  ADD CONSTRAINT "jr_template_versions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_template_versions_head_fkey" FOREIGN KEY ("tenant_id", "template_id") REFERENCES "jr_template_heads"("tenant_id", "template_id") ON DELETE NO ACTION ON UPDATE NO ACTION DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT "jr_template_versions_owner_team_fkey" FOREIGN KEY ("tenant_id", "owner_team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_template_provenance"
  ADD CONSTRAINT "jr_template_provenance_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_template_provenance_draft_fkey" FOREIGN KEY ("tenant_id", "journey_id", "draft_revision") REFERENCES "jr_journey_drafts"("tenant_id", "journey_id", "revision") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_template_upgrade_applications"
  ADD CONSTRAINT "jr_template_upgrade_applications_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_template_upgrade_applications_head_fkey" FOREIGN KEY ("tenant_id", "journey_id") REFERENCES "jr_journey_heads"("tenant_id", "journey_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_authoring_rollout_state"
  ADD CONSTRAINT "jr_authoring_rollout_state_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "iam_authoring_subjects"
  ADD CONSTRAINT "iam_authoring_subjects_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "iam_authoring_capability_grants"
  ADD CONSTRAINT "iam_authoring_capability_grants_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "iam_authoring_capability_grants_subject_fkey" FOREIGN KEY ("tenant_id", "subject_id") REFERENCES "iam_authoring_subjects"("tenant_id", "subject_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "iam_authoring_delegations"
  ADD CONSTRAINT "iam_authoring_delegations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "iam_authoring_delegations_delegator_fkey" FOREIGN KEY ("tenant_id", "delegator_subject_id") REFERENCES "iam_authoring_subjects"("tenant_id", "subject_id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "iam_authoring_delegations_delegate_fkey" FOREIGN KEY ("tenant_id", "delegate_subject_id") REFERENCES "iam_authoring_subjects"("tenant_id", "subject_id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "iam_authoring_delegation_revocations"
  ADD CONSTRAINT "iam_authoring_delegation_revocations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "iam_authoring_delegation_revocations_delegation_fkey" FOREIGN KEY ("tenant_id", "delegation_id") REFERENCES "iam_authoring_delegations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "iam_authoring_scope_versions"
  ADD CONSTRAINT "iam_authoring_scope_versions_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Triggers ─────────────────────────────────────────────────────────────────

-- append-only: ของที่แก้ย้อนหลังได้ก็ไม่ใช่หลักฐาน
CREATE FUNCTION jr_authoring_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% เป็น append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_journey_drafts_immutable" BEFORE UPDATE ON "jr_journey_drafts"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_reject_update();
CREATE TRIGGER "jr_review_decisions_immutable" BEFORE UPDATE ON "jr_review_decisions"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_reject_update();
CREATE TRIGGER "jr_authoring_audit_immutable" BEFORE UPDATE ON "jr_authoring_audit"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_reject_update();
CREATE TRIGGER "jr_template_drafts_immutable" BEFORE UPDATE ON "jr_template_drafts"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_reject_update();
CREATE TRIGGER "jr_template_versions_immutable" BEFORE UPDATE ON "jr_template_versions"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_reject_update();
CREATE TRIGGER "jr_template_provenance_immutable" BEFORE UPDATE ON "jr_template_provenance"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_reject_update();
CREATE TRIGGER "iam_authoring_delegations_immutable" BEFORE UPDATE ON "iam_authoring_delegations"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_reject_update();
CREATE TRIGGER "iam_authoring_delegation_revocations_immutable" BEFORE UPDATE ON "iam_authoring_delegation_revocations"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_reject_update();

-- head เดินหน้าแบบ CAS: identity เปลี่ยนไม่ได้, version +1 ทุกครั้ง, draft revision ไม่ถอยหลัง
CREATE FUNCTION jr_authoring_guard_head() RETURNS trigger AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION '% แก้ identity ไม่ได้', TG_TABLE_NAME;
  END IF;
  IF TG_TABLE_NAME = 'jr_journey_heads' THEN
    IF NEW.journey_id <> OLD.journey_id THEN
      RAISE EXCEPTION 'jr_journey_heads แก้ journey_id ไม่ได้';
    END IF;
  ELSIF NEW.template_id <> OLD.template_id THEN
    RAISE EXCEPTION 'jr_template_heads แก้ template_id ไม่ได้';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION '% version ต้องเพิ่มทีละหนึ่ง (CAS)', TG_TABLE_NAME;
  END IF;
  IF NEW.current_draft_revision < OLD.current_draft_revision THEN
    RAISE EXCEPTION '% draft revision ถอยหลังไม่ได้', TG_TABLE_NAME;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_journey_heads_guard" BEFORE UPDATE ON "jr_journey_heads"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_guard_head();
CREATE TRIGGER "jr_template_heads_guard" BEFORE UPDATE ON "jr_template_heads"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_guard_head();

-- receipt เปลี่ยนได้ครั้งเดียวจาก PENDING และแก้ได้เฉพาะผลลัพธ์ ไม่ใช่ key/hash ที่ใช้ตัดสิน idempotency
CREATE FUNCTION jr_authoring_guard_receipt() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'jr_authoring_command_receipts ที่จบแล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.idempotency_key, NEW.command_name, NEW.resource_kind,
      NEW.resource_id, NEW.request_hash, NEW.correlation_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.idempotency_key, OLD.command_name, OLD.resource_kind,
      OLD.resource_id, OLD.request_hash, OLD.correlation_id, OLD.created_at) THEN
    RAISE EXCEPTION 'jr_authoring_command_receipts แก้ key/hash/resource ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_authoring_command_receipts_guard" BEFORE UPDATE ON "jr_authoring_command_receipts"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_guard_receipt();

-- candidate pin ทุก digest ไว้ตอน submit — เปลี่ยนได้แค่สถานะ และเฉพาะตอนยัง IN_REVIEW
CREATE FUNCTION jr_authoring_guard_review_candidate() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'IN_REVIEW' THEN
    RAISE EXCEPTION 'jr_review_candidates ที่ปิดแล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.resource_kind, NEW.resource_id, NEW.draft_revision,
      NEW.draft_digest, NEW.compile_digest, NEW.runtime_hash, NEW.base_head_version,
      NEW.base_head_digest, NEW.reference_digest, NEW.capability_digest, NEW.maker_subject_id,
      NEW.maker_authorization_epoch, NEW.maker_scope_version, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.resource_kind, OLD.resource_id, OLD.draft_revision,
      OLD.draft_digest, OLD.compile_digest, OLD.runtime_hash, OLD.base_head_version,
      OLD.base_head_digest, OLD.reference_digest, OLD.capability_digest, OLD.maker_subject_id,
      OLD.maker_authorization_epoch, OLD.maker_scope_version, OLD.created_at) THEN
    RAISE EXCEPTION 'jr_review_candidates แก้ binding ที่ pin ไว้ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_review_candidates_guard" BEFORE UPDATE ON "jr_review_candidates"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_guard_review_candidate();

-- เนื้อหาของ outbox คงที่ เดินได้แค่ state/lease/attempts
CREATE FUNCTION jr_authoring_guard_outbox() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.event_id, NEW.resource_kind, NEW.resource_id,
      NEW.aggregate_version, NEW.event_type, NEW.payload, NEW.payload_hash, NEW.correlation_id,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.event_id, OLD.resource_kind, OLD.resource_id,
      OLD.aggregate_version, OLD.event_type, OLD.payload, OLD.payload_hash, OLD.correlation_id,
      OLD.created_at) THEN
    RAISE EXCEPTION 'jr_authoring_outbox แก้เนื้อหา event ไม่ได้';
  END IF;
  IF OLD.state = 'SENT' THEN
    RAISE EXCEPTION 'jr_authoring_outbox ที่ส่งแล้วแก้ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_authoring_outbox_guard" BEFORE UPDATE ON "jr_authoring_outbox"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_guard_outbox();

-- upgrade เปลี่ยนได้ครั้งเดียวจาก PROPOSED และแก้ได้แค่ state/applied_at
CREATE FUNCTION jr_authoring_guard_upgrade() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'PROPOSED' THEN
    RAISE EXCEPTION 'jr_template_upgrade_applications ที่จบแล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.journey_id, NEW.from_template_version, NEW.to_template_version,
      NEW.base_draft_digest, NEW.local_draft_digest, NEW.proposed_draft_digest,
      NEW.conflict_digest, NEW.request_hash, NEW.idempotency_key, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.journey_id, OLD.from_template_version, OLD.to_template_version,
      OLD.base_draft_digest, OLD.local_draft_digest, OLD.proposed_draft_digest,
      OLD.conflict_digest, OLD.request_hash, OLD.idempotency_key, OLD.created_at) THEN
    RAISE EXCEPTION 'jr_template_upgrade_applications แก้ proposal ที่ pin ไว้ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_template_upgrade_applications_guard" BEFORE UPDATE ON "jr_template_upgrade_applications"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_guard_upgrade();

-- rollout: version +1, tenant เปลี่ยนไม่ได้ และ stage เดินหน้าอย่างเดียว
-- rollback คือ mutation_frozen/ปิด flag ไม่ใช่ถอย stage (Phase Spec §9)
CREATE FUNCTION jr_authoring_guard_rollout() RETURNS trigger AS $$
DECLARE
  stages TEXT[] := ARRAY['DISABLED','INTERNAL_SYNTHETIC','SELECTED_TENANT','CONTROLLED_AUTHORING'];
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id THEN
    RAISE EXCEPTION 'jr_authoring_rollout_state แก้ tenant ไม่ได้';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'jr_authoring_rollout_state version ต้องเพิ่มทีละหนึ่ง';
  END IF;
  IF array_position(stages, NEW.stage::text) < array_position(stages, OLD.stage::text) THEN
    RAISE EXCEPTION 'jr_authoring_rollout_state ย้อน stage ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_authoring_rollout_guard" BEFORE UPDATE ON "jr_authoring_rollout_state"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_guard_rollout();

-- provenance ของ tenant อ้าง source version ใน tenant เดียวกันเท่านั้น; built-in ไม่มีแถวใน DB
-- จึงตรวจกับ release allowlist ที่ชั้น application (J5.4)
CREATE FUNCTION jr_authoring_guard_provenance() RETURNS trigger AS $$
BEGIN
  IF NEW.template_origin = 'TENANT' AND NOT EXISTS (
    SELECT 1 FROM "jr_template_versions" AS version
    WHERE version.tenant_id = NEW.tenant_id
      AND version.template_id = NEW.source_template_id
      AND version.version = NEW.source_template_version
      AND version.content_digest = NEW.source_content_digest
  ) THEN
    RAISE EXCEPTION 'jr_template_provenance อ้าง template version ที่ไม่มีใน tenant นี้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_template_provenance_source_guard" BEFORE INSERT ON "jr_template_provenance"
  FOR EACH ROW EXECUTE FUNCTION jr_authoring_guard_provenance();

-- delegation เป็น human-to-human เท่านั้น (#331 §6)
CREATE FUNCTION iam_authoring_guard_delegation() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "iam_authoring_subjects" AS subject
    WHERE subject.tenant_id = NEW.tenant_id
      AND subject.subject_id IN (NEW.delegator_subject_id, NEW.delegate_subject_id)
      AND subject.is_service_principal
  ) THEN
    RAISE EXCEPTION 'iam_authoring_delegations ใช้กับ service principal ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "iam_authoring_delegations_human_guard" BEFORE INSERT ON "iam_authoring_delegations"
  FOR EACH ROW EXECUTE FUNCTION iam_authoring_guard_delegation();

-- ── RLS ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'jr_journey_heads', 'jr_journey_drafts', 'jr_authoring_command_receipts',
    'jr_review_candidates', 'jr_review_decisions', 'jr_authoring_audit', 'jr_authoring_outbox',
    'jr_template_heads', 'jr_template_drafts', 'jr_template_versions', 'jr_template_provenance',
    'jr_template_upgrade_applications', 'jr_authoring_rollout_state',
    'iam_authoring_subjects', 'iam_authoring_capability_grants', 'iam_authoring_delegations',
    'iam_authoring_delegation_revocations', 'iam_authoring_scope_versions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- ── Grants ───────────────────────────────────────────────────────────────────
-- REVOKE ทีละตารางเพื่อให้ rls.integration อ่านจาก migration แล้วตรวจกับ bootstrap ได้ครบ

-- state ที่เดินได้แต่ห้ามหาย
GRANT SELECT, INSERT, UPDATE ON "jr_journey_heads" TO dcontact_app;
REVOKE DELETE ON "jr_journey_heads" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "jr_authoring_command_receipts" TO dcontact_app;
REVOKE DELETE ON "jr_authoring_command_receipts" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "jr_review_candidates" TO dcontact_app;
REVOKE DELETE ON "jr_review_candidates" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "jr_authoring_outbox" TO dcontact_app;
REVOKE DELETE ON "jr_authoring_outbox" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "jr_template_heads" TO dcontact_app;
REVOKE DELETE ON "jr_template_heads" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "jr_template_upgrade_applications" TO dcontact_app;
REVOKE DELETE ON "jr_template_upgrade_applications" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "jr_authoring_rollout_state" TO dcontact_app;
REVOKE DELETE ON "jr_authoring_rollout_state" FROM dcontact_app;

-- append-only
GRANT SELECT, INSERT ON "jr_journey_drafts" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_journey_drafts" FROM dcontact_app;
GRANT SELECT, INSERT ON "jr_review_decisions" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_review_decisions" FROM dcontact_app;
GRANT SELECT, INSERT ON "jr_authoring_audit" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_authoring_audit" FROM dcontact_app;
GRANT SELECT, INSERT ON "jr_template_drafts" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_template_drafts" FROM dcontact_app;
GRANT SELECT, INSERT ON "jr_template_versions" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_template_versions" FROM dcontact_app;
GRANT SELECT, INSERT ON "jr_template_provenance" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_template_provenance" FROM dcontact_app;
GRANT SELECT, INSERT ON "iam_authoring_delegations" TO dcontact_app;
REVOKE UPDATE, DELETE ON "iam_authoring_delegations" FROM dcontact_app;
GRANT SELECT, INSERT ON "iam_authoring_delegation_revocations" TO dcontact_app;
REVOKE UPDATE, DELETE ON "iam_authoring_delegation_revocations" FROM dcontact_app;

-- authorization state อ่านได้อย่างเดียว: app ที่ถูกยึดต้องขยายสิทธิ์ตัวเองไม่ได้ (แบบเดียวกับ CG4.7)
GRANT SELECT ON "iam_authoring_subjects" TO dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON "iam_authoring_subjects" FROM dcontact_app;
GRANT SELECT ON "iam_authoring_capability_grants" TO dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON "iam_authoring_capability_grants" FROM dcontact_app;
GRANT SELECT ON "iam_authoring_scope_versions" TO dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON "iam_authoring_scope_versions" FROM dcontact_app;
