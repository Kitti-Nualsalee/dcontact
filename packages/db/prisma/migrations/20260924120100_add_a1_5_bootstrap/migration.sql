-- A1.5 (#410): plan catalog + operational baseline ของ tenant ใหม่ + payload revision
--
-- Authority: #392 (Bootstrap scope, template authority/versioning, plan binding,
-- Correcting non-identity input, Readiness evidence), #388 decision "Tenant bootstrap write boundary"
--
-- expand-only: ตาราง/enum/policy ใหม่ + FK แบบ NOT VALID บน request (ตรวจเฉพาะแถวใหม่)

CREATE TYPE "BusinessHoursStatus" AS ENUM ('DRAFT', 'ACTIVE');

-- ── Plan catalog: snapshot immutable ต่อ (code, version) ────────────────────
CREATE TABLE "pf_plan_versions" (
    "plan_code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "PfBootstrapTemplateStatus" NOT NULL DEFAULT 'ACTIVE',
    "entitlements" JSONB NOT NULL,
    "snapshot_digest" CHAR(64) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_plan_versions_pkey" PRIMARY KEY ("plan_code", "version")
);

CREATE UNIQUE INDEX "pf_plan_versions_pin_key" ON "pf_plan_versions"("plan_code", "version", "snapshot_digest");

ALTER TABLE "pf_plan_versions" ADD CONSTRAINT "pf_plan_versions_values_check" CHECK (
  "plan_code" IN ('starter', 'growth', 'enterprise')
  AND "version" >= 1
  AND "snapshot_digest" ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof("entitlements") = 'object'
);

CREATE TRIGGER "pf_plan_versions_retained" BEFORE DELETE ON "pf_plan_versions"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_delete"();

CREATE FUNCTION "pf_plan_versions_guard"() RETURNS trigger AS $$
BEGIN
  IF (NEW."plan_code", NEW."version", NEW."entitlements", NEW."snapshot_digest")
     IS DISTINCT FROM (OLD."plan_code", OLD."version", OLD."entitlements", OLD."snapshot_digest") THEN
    RAISE EXCEPTION 'PF_PLAN_IMMUTABLE: plan snapshot แก้ไม่ได้ ต้องออก version ใหม่';
  END IF;
  IF NEW."status" <> OLD."status" AND NOT (
       (OLD."status" = 'ACTIVE' AND NEW."status" IN ('DEPRECATED', 'REVOKED'))
    OR (OLD."status" = 'DEPRECATED' AND NEW."status" = 'REVOKED')
  ) THEN
    RAISE EXCEPTION 'PF_PLAN_TRANSITION: % -> % ไม่อนุญาต', OLD."status", NEW."status";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_plan_versions_guard" BEFORE UPDATE ON "pf_plan_versions"
  FOR EACH ROW EXECUTE FUNCTION "pf_plan_versions_guard"();

-- request ต้องชี้ plan snapshot ที่มีจริงใน catalog; NOT VALID = ไม่ตรวจแถว dev/test เก่าย้อนหลัง
ALTER TABLE "pf_provisioning_requests" ADD CONSTRAINT "pf_provisioning_requests_plan_pin_fkey" FOREIGN KEY ("plan_code", "plan_version", "plan_snapshot_digest") REFERENCES "pf_plan_versions"("plan_code", "version", "snapshot_digest") ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

-- ── Payload revision: การแก้ field ที่ไม่ใช่ identity หลัง submit (append-only) ──
CREATE TABLE "pf_request_payload_revisions" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_revision" INTEGER NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "changed_fields" TEXT[] NOT NULL,
    "actor_kind" "PfActorKind" NOT NULL,
    "actor_subject" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_request_payload_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pf_request_payload_revisions_revision_key" ON "pf_request_payload_revisions"("request_id", "request_revision");

ALTER TABLE "pf_request_payload_revisions" ADD CONSTRAINT "pf_request_payload_revisions_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_request_payload_revisions" ADD CONSTRAINT "pf_request_payload_revisions_values_check" CHECK (
  "request_revision" >= 2
  AND "payload_digest" ~ '^[a-f0-9]{64}$'
  AND cardinality("changed_fields") >= 1
  AND "changed_fields" <@ ARRAY['displayName', 'locale', 'timezone', 'firstAdminDisplayName']::TEXT[]
  AND "reason_code" ~ '^[A-Z][A-Z0-9_]{2,63}$'
  AND "actor_kind" = 'PLATFORM_OPERATOR'
);

CREATE TRIGGER "pf_request_payload_revisions_append_only" BEFORE UPDATE OR DELETE ON "pf_request_payload_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_mutation"();

GRANT SELECT, INSERT, UPDATE ON "pf_plan_versions" TO dcontact_platform;
GRANT SELECT, INSERT ON "pf_request_payload_revisions" TO dcontact_platform;
-- displayName แก้ได้ก่อน bootstrap step สำเร็จ (#392) — tenant ยัง PROVISIONING จึง trigger ยอม
GRANT UPDATE ("name") ON "tenants" TO dcontact_platform;

-- ── Tenant operational baseline (tenant-scoped; RLS tenant_isolation อยู่ใน rls.sql) ──
CREATE TABLE "tenant_settings" (
    "tenant_id" UUID NOT NULL,
    "locale" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "bootstrap_template_version" TEXT NOT NULL,
    "bootstrap_template_digest" CHAR(64) NOT NULL,
    "provisioning_request_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_settings_pkey" PRIMARY KEY ("tenant_id")
);

ALTER TABLE "tenant_settings" ADD CONSTRAINT "tenant_settings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "tenant_plan_bindings" (
    "tenant_id" UUID NOT NULL,
    "plan_code" TEXT NOT NULL,
    "plan_version" INTEGER NOT NULL,
    "snapshot_digest" CHAR(64) NOT NULL,
    "entitlements" JSONB NOT NULL,
    "provisioning_request_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_plan_bindings_pkey" PRIMARY KEY ("tenant_id")
);

ALTER TABLE "tenant_plan_bindings" ADD CONSTRAINT "tenant_plan_bindings_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "tenant_plan_bindings" ADD CONSTRAINT "tenant_plan_bindings_values_check" CHECK (
  "plan_code" IN ('starter', 'growth', 'enterprise')
  AND "plan_version" >= 1
  AND "snapshot_digest" ~ '^[a-f0-9]{64}$'
  AND jsonb_typeof("entitlements") = 'object'
);

CREATE TABLE "business_hours" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "weekly" JSONB NOT NULL,
    "status" "BusinessHoursStatus" NOT NULL DEFAULT 'DRAFT',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "business_hours_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "business_hours_tenant_id_name_key" ON "business_hours"("tenant_id", "name");
CREATE UNIQUE INDEX "business_hours_tenant_id_id_key" ON "business_hours"("tenant_id", "id");

ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "business_hours" ADD CONSTRAINT "business_hours_values_check" CHECK (
  jsonb_typeof("weekly") = 'array'
);

-- ── provisioner seed ได้เฉพาะ tenant ที่ยัง PROVISIONING (#388 decision, แบบเดียวกับ users ใน A1.4) ──
GRANT SELECT, INSERT ON "teams", "queues", "tenant_settings", "tenant_plan_bindings", "business_hours"
  TO dcontact_provisioner;

DO $$
DECLARE
  t text;
  predicate text := 'EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = %I."tenant_id" AND t."lifecycle_status" = ''PROVISIONING'')';
BEGIN
  FOREACH t IN ARRAY ARRAY['teams', 'queues', 'tenant_settings', 'tenant_plan_bindings', 'business_hours']
  LOOP
    EXECUTE format(
      'CREATE POLICY "provisioner_bootstrap" ON %I AS PERMISSIVE FOR ALL TO dcontact_provisioner USING (' || predicate || ') WITH CHECK (' || predicate || ')',
      t, t, t
    );
    EXECUTE format(
      'CREATE POLICY "provisioner_provisioning_only" ON %I AS RESTRICTIVE FOR ALL TO dcontact_provisioner USING (' || predicate || ') WITH CHECK (' || predicate || ')',
      t, t, t
    );
  END LOOP;
END $$;
