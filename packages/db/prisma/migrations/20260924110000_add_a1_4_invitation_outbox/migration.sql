-- A1.4 (#409): invitation outbox ของ first Tenant Admin + tenant bootstrap write boundary
--
-- Authority: #392 (Invitation contract: execute-actions 72 ชั่วโมง, resend ≤ 3 ครั้ง/ชั่วโมง,
-- ambiguous outcome เข้า reconciliation ห้าม blind resend), #388 decision
-- "Tenant bootstrap write boundary" (role `dcontact_provisioner`)
--
-- expand-only: enum/ตาราง/role/policy ใหม่ ไม่แตะข้อมูลเดิม

DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'dcontact_provisioner') THEN
    -- saga worker เท่านั้น: เขียน bootstrap rows ได้เฉพาะ tenant ที่ยัง PROVISIONING (policy ด้านล่าง)
    CREATE ROLE dcontact_provisioner LOGIN PASSWORD 'dcontact_provisioner' NOBYPASSRLS;
  END IF;
END $$;

CREATE TYPE "PfInvitationState" AS ENUM ('INTENT', 'SENT', 'FAILED', 'AMBIGUOUS');

-- หนึ่งแถวต่อหนึ่ง generation; intent ถูกเขียนก่อนเรียก Keycloak เสมอ (durable outbox)
-- ไม่มี raw email/action token — ผู้รับอ้างด้วย hash และ Keycloak user id เท่านั้น
CREATE TABLE "pf_invitations" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "generation" INTEGER NOT NULL,
    "state" "PfInvitationState" NOT NULL DEFAULT 'INTENT',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "keycloak_user_id" UUID NOT NULL,
    "recipient_hash" CHAR(64) NOT NULL,
    "lifespan_seconds" INTEGER NOT NULL,
    "requested_by_kind" "PfActorKind" NOT NULL,
    "requested_by" TEXT NOT NULL,
    "reason_code" TEXT,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "sent_at" TIMESTAMP(3),
    "expires_at" TIMESTAMP(3),
    "superseded_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_invitations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pf_invitations_generation_key" ON "pf_invitations"("request_id", "generation");
CREATE INDEX "pf_invitations_tenant_idx" ON "pf_invitations"("tenant_id", "created_at");

ALTER TABLE "pf_invitations" ADD CONSTRAINT "pf_invitations_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_invitations" ADD CONSTRAINT "pf_invitations_values_check" CHECK (
  "generation" >= 1
  AND "revision" >= 1
  -- #392: action link อายุ 72 ชั่วโมงเสมอ
  AND "lifespan_seconds" = 259200
  AND "recipient_hash" ~ '^[a-f0-9]{64}$'
  AND ("reason_code" IS NULL OR "reason_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  AND ("error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  -- generation แรกมาจาก saga; resend ต้องมีเหตุผลและ actor ที่เป็นคน (#392 audited operator action)
  AND (("generation" = 1) = ("reason_code" IS NULL))
  AND ("generation" = 1 OR "requested_by_kind" = 'PLATFORM_OPERATOR')
  -- delivery accepted ต้องมีเวลาส่งและวันหมดอายุที่ตรง lifespan
  AND (("state" = 'SENT') = ("sent_at" IS NOT NULL))
  AND ("sent_at" IS NULL OR "expires_at" = "sent_at" + make_interval(secs => "lifespan_seconds"))
  AND ("sent_at" IS NOT NULL OR "expires_at" IS NULL)
);

CREATE TRIGGER "pf_invitations_retained" BEFORE DELETE ON "pf_invitations"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_delete"();

-- generation ต่อเนื่อง + resend cap แบบ race-safe: lock ต่อ request แล้วนับใน transaction เดียว
CREATE FUNCTION "pf_invitations_insert_guard"() RETURNS trigger AS $$
DECLARE
  latest record;
  recent_resends integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('pf_invitations:' || NEW."request_id"::text, 0));
  SELECT "generation", "created_at", "superseded_at" INTO latest FROM "pf_invitations"
    WHERE "request_id" = NEW."request_id" ORDER BY "generation" DESC LIMIT 1;
  IF NEW."generation" <> coalesce(latest."generation", 0) + 1 THEN
    RAISE EXCEPTION 'PF_INVITATION_GENERATION: generation ต้องต่อจากล่าสุดทีละหนึ่ง';
  END IF;
  IF latest."generation" IS NOT NULL THEN
    IF latest."superseded_at" IS NULL THEN
      RAISE EXCEPTION 'PF_INVITATION_NOT_SUPERSEDED: ต้อง supersede generation ก่อนหน้าใน transaction เดียวกัน';
    END IF;
    IF NEW."created_at" < latest."created_at" THEN
      RAISE EXCEPTION 'PF_INVITATION_CLOCK: created_at ต้องไม่ถอยหลัง';
    END IF;
  END IF;
  IF NEW."generation" > 1 THEN
    SELECT count(*) INTO recent_resends FROM "pf_invitations"
      WHERE "request_id" = NEW."request_id" AND "generation" > 1
        AND "created_at" > NEW."created_at" - interval '1 hour';
    IF recent_resends >= 3 THEN
      RAISE EXCEPTION 'PF_INVITATION_RESEND_LIMIT: resend ได้ไม่เกิน 3 ครั้งต่อชั่วโมง';
    END IF;
  END IF;
  IF NEW."state" <> 'INTENT' OR NEW."revision" <> 1 THEN
    RAISE EXCEPTION 'PF_INVITATION_INTENT: generation ใหม่ต้องเริ่มที่ INTENT revision 1';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_invitations_insert_guard" BEFORE INSERT ON "pf_invitations"
  FOR EACH ROW EXECUTE FUNCTION "pf_invitations_insert_guard"();

CREATE FUNCTION "pf_invitations_guard"() RETURNS trigger AS $$
BEGIN
  IF (NEW."id", NEW."request_id", NEW."tenant_id", NEW."generation", NEW."keycloak_user_id",
      NEW."recipient_hash", NEW."lifespan_seconds", NEW."requested_by_kind", NEW."requested_by",
      NEW."reason_code", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."request_id", OLD."tenant_id", OLD."generation", OLD."keycloak_user_id",
      OLD."recipient_hash", OLD."lifespan_seconds", OLD."requested_by_kind", OLD."requested_by",
      OLD."reason_code", OLD."created_at") THEN
    RAISE EXCEPTION 'PF_INVITATION_IDENTITY_IMMUTABLE: identity ของ invitation แก้ไม่ได้';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'PF_INVITATION_REVISION: revision ต้องเพิ่มทีละหนึ่ง (CAS)';
  END IF;
  IF OLD."superseded_at" IS NOT NULL AND NEW."superseded_at" IS DISTINCT FROM OLD."superseded_at" THEN
    RAISE EXCEPTION 'PF_INVITATION_SUPERSEDED: supersede แล้วย้อนไม่ได้';
  END IF;
  IF OLD."state" = 'SENT' AND (NEW."sent_at", NEW."expires_at") IS DISTINCT FROM (OLD."sent_at", OLD."expires_at") THEN
    RAISE EXCEPTION 'PF_INVITATION_SENT: delivery receipt แก้ไม่ได้';
  END IF;
  -- FAILED = พิสูจน์ได้ว่าไม่ได้ส่ง จึงเริ่ม intent เดิมใหม่ได้; AMBIGUOUS ไปได้ทางเดียวคือ SENT
  -- เมื่อ reconciliation พบหลักฐานการส่ง — ห้ามถือว่าไม่ได้ส่งแล้วยิงซ้ำ (#392)
  IF NEW."state" <> OLD."state" AND NOT (
       (OLD."state" = 'INTENT' AND NEW."state" IN ('SENT', 'FAILED', 'AMBIGUOUS'))
    OR (OLD."state" = 'FAILED' AND NEW."state" = 'INTENT')
    OR (OLD."state" = 'AMBIGUOUS' AND NEW."state" = 'SENT')
  ) THEN
    RAISE EXCEPTION 'PF_INVITATION_TRANSITION: % -> % ไม่อนุญาต', OLD."state", NEW."state";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_invitations_guard" BEFORE UPDATE ON "pf_invitations"
  FOR EACH ROW EXECUTE FUNCTION "pf_invitations_guard"();

GRANT SELECT, INSERT, UPDATE ON "pf_invitations" TO dcontact_platform;

-- ── Tenant bootstrap write boundary (#388 decision) ─────────────────────────
-- provisioner เห็น tenants แค่ id + lifecycle เพื่อให้ policy ตรวจได้ และเขียน users ของ first-admin
-- ได้เฉพาะ tenant ที่ยัง PROVISIONING; หลัง ACTIVE แล้วแตะไม่ได้อีกแม้ตั้ง app.tenant_id เอง
GRANT USAGE ON SCHEMA public TO dcontact_provisioner;
GRANT SELECT ("id", "lifecycle_status") ON "tenants" TO dcontact_provisioner;
GRANT SELECT, INSERT ON "users" TO dcontact_provisioner;
GRANT UPDATE ("keycloak_id") ON "users" TO dcontact_provisioner;

CREATE POLICY "provisioner_bootstrap" ON "users" AS PERMISSIVE FOR ALL TO dcontact_provisioner
  USING (EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = "users"."tenant_id" AND t."lifecycle_status" = 'PROVISIONING'))
  WITH CHECK (EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = "users"."tenant_id" AND t."lifecycle_status" = 'PROVISIONING'));
-- RESTRICTIVE: AND กับทุก permissive policy รวม tenant_isolation จึงหนี PROVISIONING ไม่ได้
CREATE POLICY "provisioner_provisioning_only" ON "users" AS RESTRICTIVE FOR ALL TO dcontact_provisioner
  USING (EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = "users"."tenant_id" AND t."lifecycle_status" = 'PROVISIONING'))
  WITH CHECK (EXISTS (SELECT 1 FROM "tenants" t WHERE t."id" = "users"."tenant_id" AND t."lifecycle_status" = 'PROVISIONING'));
