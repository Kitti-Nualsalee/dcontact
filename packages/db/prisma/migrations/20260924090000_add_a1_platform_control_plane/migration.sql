-- A1.1 (#406): Platform control-plane foundation — provisioning intent, step ledger, idempotency,
-- slug/domain/email reservation + tombstone 30 วัน และ append-only Action history
--
-- Authority: Phase Contract #388, lifecycle #389, saga #390, bootstrap #392, acceptance #393,
-- decision บน #406 (sipDomain derive จาก slug; `tenants.primary_domain`)
--
-- expand-only: enum/ตารางใหม่ + คอลัมน์ใหม่ของ tenants ที่มี default (tenant เดิมเป็น ACTIVE/NULL)
-- ไม่มี backfill และไม่แตะตาราง business ของ tenant; rollback = ปิด mutation ไม่ใช่ drop schema

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_platform') THEN
    -- control-plane service role: เห็นเฉพาะ metadata ของ platform และตาราง tenants
    CREATE ROLE dcontact_platform LOGIN PASSWORD 'dcontact_platform' NOBYPASSRLS;
  END IF;
END $$;

CREATE TYPE "TenantLifecycleStatus" AS ENUM ('PROVISIONING', 'ACTIVE');

CREATE TYPE "PfProvisioningStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'ACTION_REQUIRED', 'FAILED_FINAL', 'CANCELLED');

CREATE TYPE "PfStepKey" AS ENUM ('TENANT_RECORD', 'KEYCLOAK_ORGANIZATION', 'PLAN_BOOTSTRAP', 'FIRST_ADMIN', 'INVITATION', 'READINESS');

CREATE TYPE "PfStepState" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'ACTION_REQUIRED');

CREATE TYPE "PfReservationKind" AS ENUM ('SLUG', 'PRIMARY_DOMAIN', 'FIRST_ADMIN_EMAIL');

CREATE TYPE "PfReservationState" AS ENUM ('HELD', 'CONSUMED', 'TOMBSTONED');

CREATE TYPE "PfBootstrapTemplateStatus" AS ENUM ('ACTIVE', 'DEPRECATED', 'REVOKED');

CREATE TYPE "PfActionKind" AS ENUM ('REQUEST_ACCEPTED', 'COMMAND_REPLAYED', 'STATE_CHANGED', 'STEP_STARTED', 'STEP_SUCCEEDED', 'STEP_ACTION_REQUIRED', 'RECONCILE', 'RETRY_STEP', 'RESEND_INVITATION', 'SAFE_COMPENSATE', 'MARK_FAILED_FINAL', 'CANCEL', 'RESERVATION_TOMBSTONED', 'SECURITY_DENIED');

CREATE TYPE "PfActorKind" AS ENUM ('PLATFORM_OPERATOR', 'PLATFORM_AUDITOR', 'SYSTEM');

ALTER TABLE "tenants" ADD COLUMN     "lifecycle_status" "TenantLifecycleStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "primary_domain" TEXT;

CREATE TABLE "pf_bootstrap_templates" (
    "version" TEXT NOT NULL,
    "content_digest" CHAR(64) NOT NULL,
    "status" "PfBootstrapTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
    "manifest" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_bootstrap_templates_pkey" PRIMARY KEY ("version")
);

CREATE TABLE "pf_provisioning_requests" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "idempotency_key_hash" CHAR(64) NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "status" "PfProvisioningStatus" NOT NULL DEFAULT 'PENDING',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "display_name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "primary_domain" TEXT NOT NULL,
    "sip_domain" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "plan_code" TEXT NOT NULL,
    "plan_version" INTEGER NOT NULL,
    "plan_snapshot_digest" CHAR(64) NOT NULL,
    "bootstrap_template_version" TEXT NOT NULL,
    "bootstrap_template_digest" CHAR(64) NOT NULL,
    "first_admin_email" TEXT NOT NULL,
    "first_admin_email_hash" CHAR(64) NOT NULL,
    "first_admin_display_name" TEXT NOT NULL,
    "requested_by" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "failure_code" TEXT,
    "accepted_at" TIMESTAMP(3) NOT NULL,
    "deadline_at" TIMESTAMP(3) NOT NULL,
    "terminal_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_provisioning_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pf_provisioning_steps" (
    "request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "step_key" "PfStepKey" NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "state" "PfStepState" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "input_digest" CHAR(64),
    "output_digest" CHAR(64),
    "external_ref" TEXT,
    "error_code" TEXT,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_provisioning_steps_pkey" PRIMARY KEY ("request_id","step_key")
);

CREATE TABLE "pf_provisioning_step_receipts" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "step_key" "PfStepKey" NOT NULL,
    "attempt" INTEGER NOT NULL,
    "outcome" "PfStepState" NOT NULL,
    "input_digest" CHAR(64),
    "output_digest" CHAR(64),
    "external_ref_hash" CHAR(64),
    "error_code" TEXT,
    "recorded_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_provisioning_step_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pf_command_receipts" (
    "id" UUID NOT NULL,
    "idempotency_key_hash" CHAR(64) NOT NULL,
    "command_kind" TEXT NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_subject" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pf_command_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "pf_identity_reservations" (
    "kind" "PfReservationKind" NOT NULL,
    "value_key" TEXT NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "state" "PfReservationState" NOT NULL DEFAULT 'HELD',
    "tombstoned_until" TIMESTAMP(3),
    "revision" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_identity_reservations_pkey" PRIMARY KEY ("kind","value_key")
);

CREATE TABLE "pf_action_history" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "action" "PfActionKind" NOT NULL,
    "actor_kind" "PfActorKind" NOT NULL,
    "actor_subject" TEXT NOT NULL,
    "actor_role" TEXT,
    "session_ref" TEXT,
    "reason_code" TEXT,
    "comment" TEXT,
    "correlation_id" TEXT NOT NULL,
    "idempotency_key_hash" CHAR(64),
    "before_state" TEXT,
    "after_state" TEXT,
    "outcome" TEXT NOT NULL,
    "error_code" TEXT,
    "step_key" "PfStepKey",
    "attempt" INTEGER,
    "input_digest" CHAR(64),
    "output_digest" CHAR(64),
    "external_ref_hash" CHAR(64),
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_action_history_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pf_bootstrap_templates_pin_key" ON "pf_bootstrap_templates"("version", "content_digest");

CREATE UNIQUE INDEX "pf_provisioning_requests_tenant_id_key" ON "pf_provisioning_requests"("tenant_id");

CREATE UNIQUE INDEX "pf_provisioning_requests_idempotency_key_hash_key" ON "pf_provisioning_requests"("idempotency_key_hash");

CREATE INDEX "pf_provisioning_requests_status_idx" ON "pf_provisioning_requests"("status", "updated_at");

CREATE UNIQUE INDEX "pf_provisioning_requests_binding_key" ON "pf_provisioning_requests"("tenant_id", "id");

CREATE UNIQUE INDEX "pf_provisioning_steps_ordinal_key" ON "pf_provisioning_steps"("request_id", "ordinal");

CREATE UNIQUE INDEX "pf_provisioning_step_receipts_attempt_key" ON "pf_provisioning_step_receipts"("request_id", "step_key", "attempt");

CREATE UNIQUE INDEX "pf_command_receipts_idempotency_key_hash_key" ON "pf_command_receipts"("idempotency_key_hash");

CREATE INDEX "pf_identity_reservations_request_idx" ON "pf_identity_reservations"("request_id");

CREATE INDEX "pf_action_history_timeline_idx" ON "pf_action_history"("tenant_id", "occurred_at", "id");

CREATE UNIQUE INDEX "tenants_primary_domain_key" ON "tenants"("primary_domain");

ALTER TABLE "pf_provisioning_requests" ADD CONSTRAINT "pf_provisioning_requests_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_provisioning_requests" ADD CONSTRAINT "pf_provisioning_requests_template_pin_fkey" FOREIGN KEY ("bootstrap_template_version", "bootstrap_template_digest") REFERENCES "pf_bootstrap_templates"("version", "content_digest") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_provisioning_steps" ADD CONSTRAINT "pf_provisioning_steps_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_provisioning_step_receipts" ADD CONSTRAINT "pf_provisioning_step_receipts_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_command_receipts" ADD CONSTRAINT "pf_command_receipts_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_identity_reservations" ADD CONSTRAINT "pf_identity_reservations_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_action_history" ADD CONSTRAINT "pf_action_history_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── Value constraints ────────────────────────────────────────────────────────

ALTER TABLE "pf_bootstrap_templates" ADD CONSTRAINT "pf_bootstrap_templates_values_check" CHECK (
  "version" ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$'
  AND "content_digest" ~ '^[a-f0-9]{64}$'
);

ALTER TABLE "pf_provisioning_requests" ADD CONSTRAINT "pf_provisioning_requests_values_check" CHECK (
  "idempotency_key_hash" ~ '^[a-f0-9]{64}$'
  AND "payload_digest" ~ '^[a-f0-9]{64}$'
  AND "plan_snapshot_digest" ~ '^[a-f0-9]{64}$'
  AND "bootstrap_template_digest" ~ '^[a-f0-9]{64}$'
  AND "first_admin_email_hash" ~ '^[a-f0-9]{64}$'
  AND "slug" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$'
  AND "primary_domain" ~ '^[a-z0-9.-]{3,253}$'
  -- decision บน #406: sipDomain = <slug>.<platform SIP base domain>
  AND starts_with("sip_domain", "slug" || '.')
  AND char_length("sip_domain") > char_length("slug") + 1
  AND "plan_code" IN ('starter', 'growth', 'enterprise')
  AND "plan_version" > 0
  AND "revision" >= 1
  AND "deadline_at" > "accepted_at"
  AND char_length("display_name") BETWEEN 2 AND 120
  AND char_length("first_admin_display_name") BETWEEN 1 AND 120
  AND ("failure_code" IS NULL OR "failure_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

-- terminal_at มีค่าเมื่อจบแล้วเท่านั้น (#389: SUCCEEDED/FAILED_FINAL/CANCELLED เป็น terminal)
ALTER TABLE "pf_provisioning_requests" ADD CONSTRAINT "pf_provisioning_requests_terminal_check" CHECK (
  ("status" IN ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED')) = ("terminal_at" IS NOT NULL)
);

ALTER TABLE "pf_provisioning_steps" ADD CONSTRAINT "pf_provisioning_steps_values_check" CHECK (
  "ordinal" BETWEEN 1 AND 6
  AND "attempt" >= 0
  AND "revision" >= 1
  AND (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL))
  AND ("state" <> 'SUCCEEDED' OR "finished_at" IS NOT NULL)
  AND ("input_digest" IS NULL OR "input_digest" ~ '^[a-f0-9]{64}$')
  AND ("output_digest" IS NULL OR "output_digest" ~ '^[a-f0-9]{64}$')
  AND ("error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

ALTER TABLE "pf_provisioning_step_receipts" ADD CONSTRAINT "pf_provisioning_step_receipts_values_check" CHECK (
  "attempt" >= 1
  AND "outcome" IN ('SUCCEEDED', 'ACTION_REQUIRED')
  AND ("input_digest" IS NULL OR "input_digest" ~ '^[a-f0-9]{64}$')
  AND ("output_digest" IS NULL OR "output_digest" ~ '^[a-f0-9]{64}$')
  AND ("external_ref_hash" IS NULL OR "external_ref_hash" ~ '^[a-f0-9]{64}$')
  AND ("error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
);

ALTER TABLE "pf_command_receipts" ADD CONSTRAINT "pf_command_receipts_values_check" CHECK (
  "idempotency_key_hash" ~ '^[a-f0-9]{64}$'
  AND "payload_digest" ~ '^[a-f0-9]{64}$'
  AND "command_kind" ~ '^[A-Z][A-Z0-9_]{2,63}$'
);

-- email เก็บเป็น hash เท่านั้น; tombstone มีวันหมดอายุเสมอ
ALTER TABLE "pf_identity_reservations" ADD CONSTRAINT "pf_identity_reservations_values_check" CHECK (
  (("state" = 'TOMBSTONED') = ("tombstoned_until" IS NOT NULL))
  AND "revision" >= 1
  AND char_length("value_key") BETWEEN 1 AND 253
  AND ("kind" <> 'FIRST_ADMIN_EMAIL' OR "value_key" ~ '^[a-f0-9]{64}$')
  AND ("kind" <> 'SLUG' OR "value_key" ~ '^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$')
);

ALTER TABLE "pf_action_history" ADD CONSTRAINT "pf_action_history_values_check" CHECK (
  "outcome" IN ('SUCCEEDED', 'REJECTED', 'REPLAYED')
  AND ("comment" IS NULL OR char_length("comment") <= 500)
  AND ("reason_code" IS NULL OR "reason_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  AND ("error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  AND ("attempt" IS NULL OR "attempt" >= 0)
  AND ("idempotency_key_hash" IS NULL OR "idempotency_key_hash" ~ '^[a-f0-9]{64}$')
  AND ("external_ref_hash" IS NULL OR "external_ref_hash" ~ '^[a-f0-9]{64}$')
);

-- ── Append-only / retention guards (ทุก role รวม owner) ──────────────────────

CREATE FUNCTION "pf_forbid_mutation"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PF_APPEND_ONLY: % แก้หรือลบไม่ได้', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_provisioning_step_receipts_append_only" BEFORE UPDATE OR DELETE ON "pf_provisioning_step_receipts"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_mutation"();
CREATE TRIGGER "pf_command_receipts_append_only" BEFORE UPDATE OR DELETE ON "pf_command_receipts"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_mutation"();
CREATE TRIGGER "pf_action_history_append_only" BEFORE UPDATE OR DELETE ON "pf_action_history"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_mutation"();

-- ledger/reservation/template เก็บตลอด (#390 FAILED_FINAL ยังเก็บ ledger + tombstone) — ไม่มี delete
CREATE FUNCTION "pf_forbid_delete"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'PF_RETAINED: % ลบไม่ได้', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_provisioning_requests_retained" BEFORE DELETE ON "pf_provisioning_requests"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_delete"();
CREATE TRIGGER "pf_provisioning_steps_retained" BEFORE DELETE ON "pf_provisioning_steps"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_delete"();
CREATE TRIGGER "pf_identity_reservations_retained" BEFORE DELETE ON "pf_identity_reservations"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_delete"();
CREATE TRIGGER "pf_bootstrap_templates_retained" BEFORE DELETE ON "pf_bootstrap_templates"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_delete"();

-- ── Provisioning request: immutable binding + transition table + completion invariant ──

CREATE FUNCTION "pf_provisioning_requests_guard"() RETURNS trigger AS $$
DECLARE
  incomplete integer;
BEGIN
  IF (NEW."id", NEW."tenant_id", NEW."idempotency_key_hash", NEW."payload_digest", NEW."slug",
      NEW."primary_domain", NEW."sip_domain", NEW."plan_code", NEW."plan_version",
      NEW."plan_snapshot_digest", NEW."bootstrap_template_version", NEW."bootstrap_template_digest",
      NEW."first_admin_email_hash", NEW."requested_by", NEW."correlation_id", NEW."accepted_at")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."idempotency_key_hash", OLD."payload_digest", OLD."slug",
      OLD."primary_domain", OLD."sip_domain", OLD."plan_code", OLD."plan_version",
      OLD."plan_snapshot_digest", OLD."bootstrap_template_version", OLD."bootstrap_template_digest",
      OLD."first_admin_email_hash", OLD."requested_by", OLD."correlation_id", OLD."accepted_at") THEN
    RAISE EXCEPTION 'PF_REQUEST_IDENTITY_IMMUTABLE: identity/pin ของ provisioning request แก้ไม่ได้';
  END IF;
  IF OLD."status" IN ('SUCCEEDED', 'FAILED_FINAL', 'CANCELLED') THEN
    RAISE EXCEPTION 'PF_REQUEST_TERMINAL: request ที่จบแล้วแก้ไม่ได้';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'PF_REQUEST_REVISION: revision ต้องเพิ่มทีละหนึ่ง (CAS)';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'PENDING' AND NEW."status" IN ('RUNNING', 'CANCELLED'))
    OR (OLD."status" = 'RUNNING' AND NEW."status" IN ('SUCCEEDED', 'ACTION_REQUIRED'))
    OR (OLD."status" = 'ACTION_REQUIRED' AND NEW."status" IN ('RUNNING', 'FAILED_FINAL'))
  ) THEN
    RAISE EXCEPTION 'PF_REQUEST_TRANSITION: % -> % ไม่อนุญาต', OLD."status", NEW."status";
  END IF;
  IF NEW."status" = 'SUCCEEDED' THEN
    SELECT count(*) INTO incomplete FROM "pf_provisioning_steps"
      WHERE "request_id" = NEW."id" AND "state" <> 'SUCCEEDED';
    IF incomplete > 0 OR (SELECT count(*) FROM "pf_provisioning_steps" WHERE "request_id" = NEW."id") <> 6 THEN
      RAISE EXCEPTION 'PF_REQUEST_INCOMPLETE: SUCCEEDED ต้องมี step receipt ครบทุก step';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_provisioning_requests_guard" BEFORE UPDATE ON "pf_provisioning_requests"
  FOR EACH ROW EXECUTE FUNCTION "pf_provisioning_requests_guard"();

-- ── Step ledger head ─────────────────────────────────────────────────────────

CREATE FUNCTION "pf_provisioning_steps_guard"() RETURNS trigger AS $$
BEGIN
  IF (NEW."request_id", NEW."tenant_id", NEW."step_key", NEW."ordinal")
     IS DISTINCT FROM (OLD."request_id", OLD."tenant_id", OLD."step_key", OLD."ordinal") THEN
    RAISE EXCEPTION 'PF_STEP_IDENTITY_IMMUTABLE: step identity แก้ไม่ได้';
  END IF;
  IF OLD."state" = 'SUCCEEDED' THEN
    RAISE EXCEPTION 'PF_STEP_SUCCEEDED: step ที่สำเร็จแล้วแก้ไม่ได้ (replay ต้องเป็น no-op)';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'PF_STEP_REVISION: revision ต้องเพิ่มทีละหนึ่ง (CAS)';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_provisioning_steps_guard" BEFORE UPDATE ON "pf_provisioning_steps"
  FOR EACH ROW EXECUTE FUNCTION "pf_provisioning_steps_guard"();

-- ── Identity reservation: owner เปลี่ยนได้ทางเดียวคือรับช่วง tombstone ที่หมดอายุแล้ว ─────

CREATE FUNCTION "pf_identity_reservations_guard"() RETURNS trigger AS $$
BEGIN
  IF (NEW."kind", NEW."value_key") IS DISTINCT FROM (OLD."kind", OLD."value_key") THEN
    RAISE EXCEPTION 'PF_RESERVATION_IDENTITY_IMMUTABLE: ค่า reservation แก้ไม่ได้';
  END IF;
  IF OLD."state" = 'CONSUMED' THEN
    RAISE EXCEPTION 'PF_RESERVATION_CONSUMED: identity ของ tenant ACTIVE ใช้ซ้ำไม่ได้';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'PF_RESERVATION_REVISION: revision ต้องเพิ่มทีละหนึ่ง';
  END IF;
  IF (NEW."tenant_id", NEW."request_id") IS DISTINCT FROM (OLD."tenant_id", OLD."request_id") THEN
    IF NOT (OLD."state" = 'TOMBSTONED' AND OLD."tombstoned_until" <= now() AND NEW."state" = 'HELD') THEN
      RAISE EXCEPTION 'PF_RESERVATION_HELD: reservation ยังไม่พ้น tombstone จึงเปลี่ยนเจ้าของไม่ได้';
    END IF;
  ELSIF NEW."state" <> OLD."state" AND NOT (
    OLD."state" = 'HELD' AND NEW."state" IN ('CONSUMED', 'TOMBSTONED')
  ) THEN
    RAISE EXCEPTION 'PF_RESERVATION_TRANSITION: % -> % ไม่อนุญาต', OLD."state", NEW."state";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_identity_reservations_guard" BEFORE UPDATE ON "pf_identity_reservations"
  FOR EACH ROW EXECUTE FUNCTION "pf_identity_reservations_guard"();

-- ── Bootstrap template: content immutable, status ไปข้างหน้าเท่านั้น ─────────

CREATE FUNCTION "pf_bootstrap_templates_guard"() RETURNS trigger AS $$
BEGIN
  IF (NEW."version", NEW."content_digest", NEW."manifest")
     IS DISTINCT FROM (OLD."version", OLD."content_digest", OLD."manifest") THEN
    RAISE EXCEPTION 'PF_TEMPLATE_IMMUTABLE: bootstrap manifest แก้ไม่ได้ ต้องออก version ใหม่';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'ACTIVE' AND NEW."status" IN ('DEPRECATED', 'REVOKED'))
    OR (OLD."status" = 'DEPRECATED' AND NEW."status" = 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'PF_TEMPLATE_TRANSITION: % -> % ไม่อนุญาต', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_bootstrap_templates_guard" BEFORE UPDATE ON "pf_bootstrap_templates"
  FOR EACH ROW EXECUTE FUNCTION "pf_bootstrap_templates_guard"();

-- ── Tenant lifecycle ─────────────────────────────────────────────────────────
-- tenant ที่ยัง PROVISIONING ถือค่า placeholder (`~pv-<uuid>`) ที่ชนกับ slug จริงไม่ได้ เพราะแถว tenant
-- ถูกสร้างตั้งแต่รับคำขอ (#390) แต่ slug/domain ของคำขอที่ FAILED_FINAL/CANCELLED ต้องกลับมาใช้ได้หลัง
-- tombstone 30 วัน (#389) — ระหว่างนั้น reservation เป็นผู้คุม uniqueness; ค่าจริงถูกตั้งตอน ACTIVE เท่านั้น
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_provisioning_placeholder_check" CHECK (
  "lifecycle_status" <> 'PROVISIONING'
  OR ("slug" LIKE '~pv-%' AND "sip_domain" LIKE '~pv-%' AND "primary_domain" IS NULL)
);

-- ACTIVE ได้เมื่อ request SUCCEEDED แล้ว และค่าที่ตั้งต้องตรง binding ของ request นั้นทุกตัว
-- (ห้าม premature ACTIVE และห้ามตั้ง slug/domain อื่นนอกจากที่ reserve ไว้)
CREATE FUNCTION "tenants_lifecycle_guard"() RETURNS trigger AS $$
DECLARE
  request record;
BEGIN
  IF OLD."lifecycle_status" = 'ACTIVE' THEN
    IF NEW."lifecycle_status" <> 'ACTIVE' THEN
      RAISE EXCEPTION 'TENANT_LIFECYCLE_TRANSITION: ACTIVE ย้อนกลับไม่ได้ใน A1';
    END IF;
    IF OLD."primary_domain" IS NOT NULL AND NEW."primary_domain" IS DISTINCT FROM OLD."primary_domain" THEN
      RAISE EXCEPTION 'TENANT_PRIMARY_DOMAIN_IMMUTABLE: primary domain แก้ไม่ได้ใน A1';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."lifecycle_status" = 'PROVISIONING' THEN
    IF (NEW."slug", NEW."sip_domain", NEW."primary_domain")
       IS DISTINCT FROM (OLD."slug", OLD."sip_domain", OLD."primary_domain") THEN
      RAISE EXCEPTION 'TENANT_PROVISIONING_IDENTITY: identity ของ tenant ที่ยัง PROVISIONING แก้ไม่ได้';
    END IF;
    RETURN NEW;
  END IF;
  SELECT "slug", "sip_domain", "primary_domain" INTO request FROM "pf_provisioning_requests"
    WHERE "tenant_id" = NEW."id" AND "status" = 'SUCCEEDED';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TENANT_NOT_READY: tenant เป็น ACTIVE ได้เมื่อ provisioning request SUCCEEDED แล้วเท่านั้น';
  END IF;
  IF (NEW."slug", NEW."sip_domain", NEW."primary_domain")
     IS DISTINCT FROM (request."slug", request."sip_domain", request."primary_domain") THEN
    RAISE EXCEPTION 'TENANT_BINDING_MISMATCH: slug/domain ของ tenant ต้องตรงกับ provisioning request';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "tenants_lifecycle_guard" BEFORE UPDATE ON "tenants"
  FOR EACH ROW EXECUTE FUNCTION "tenants_lifecycle_guard"();

-- ── Grants: control plane เห็นแค่ metadata; tenant application ไม่เห็น control plane ─────

GRANT USAGE ON SCHEMA public TO dcontact_platform;
GRANT SELECT, INSERT ON "tenants" TO dcontact_platform;
-- activation ตั้ง slug/domain จริงแทน placeholder; trigger บังคับว่าต้องตรง request ที่ SUCCEEDED
GRANT UPDATE ("lifecycle_status", "slug", "sip_domain", "primary_domain") ON "tenants" TO dcontact_platform;
GRANT SELECT, INSERT, UPDATE ON "pf_bootstrap_templates" TO dcontact_platform;
GRANT SELECT, INSERT, UPDATE ON "pf_provisioning_requests" TO dcontact_platform;
GRANT SELECT, INSERT, UPDATE ON "pf_provisioning_steps" TO dcontact_platform;
GRANT SELECT, INSERT, UPDATE ON "pf_identity_reservations" TO dcontact_platform;
GRANT SELECT, INSERT ON "pf_provisioning_step_receipts" TO dcontact_platform;
GRANT SELECT, INSERT ON "pf_command_receipts" TO dcontact_platform;
GRANT SELECT, INSERT ON "pf_action_history" TO dcontact_platform;

REVOKE ALL ON "pf_bootstrap_templates", "pf_provisioning_requests", "pf_provisioning_steps",
  "pf_provisioning_step_receipts", "pf_command_receipts", "pf_identity_reservations",
  "pf_action_history" FROM dcontact_app;
