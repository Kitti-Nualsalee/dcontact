-- A1.5b (#441): แก้อีเมล first admin ก่อน identity step สำเร็จ (#392 Correcting non-identity input)
--
-- expand-only: CREATE OR REPLACE guard + ตาราง append-only ใหม่
-- - hash ของอีเมลเปลี่ยนได้เฉพาะเมื่อ FIRST_ADMIN ยังไม่เคยเริ่ม หรือหยุดเพราะอีเมลชนกับ identity อื่น
--   (ทั้งสองกรณียังไม่มี identity ภายนอกของ request นี้) และ request ต้องถือ reservation HELD ของ hash ใหม่
-- - ค่าอื่นใน binding ยัง immutable เหมือน A1.1

CREATE OR REPLACE FUNCTION "pf_provisioning_requests_guard"() RETURNS trigger AS $$
DECLARE
  incomplete integer;
  identity_step record;
BEGIN
  IF (NEW."id", NEW."tenant_id", NEW."idempotency_key_hash", NEW."payload_digest", NEW."slug",
      NEW."primary_domain", NEW."sip_domain", NEW."plan_code", NEW."plan_version",
      NEW."plan_snapshot_digest", NEW."bootstrap_template_version", NEW."bootstrap_template_digest",
      NEW."requested_by", NEW."correlation_id", NEW."accepted_at")
     IS DISTINCT FROM
     (OLD."id", OLD."tenant_id", OLD."idempotency_key_hash", OLD."payload_digest", OLD."slug",
      OLD."primary_domain", OLD."sip_domain", OLD."plan_code", OLD."plan_version",
      OLD."plan_snapshot_digest", OLD."bootstrap_template_version", OLD."bootstrap_template_digest",
      OLD."requested_by", OLD."correlation_id", OLD."accepted_at") THEN
    RAISE EXCEPTION 'PF_REQUEST_IDENTITY_IMMUTABLE: identity/pin ของ provisioning request แก้ไม่ได้';
  END IF;
  IF NEW."first_admin_email_hash" IS DISTINCT FROM OLD."first_admin_email_hash" THEN
    SELECT "state", "attempt", "error_code" INTO identity_step FROM "pf_provisioning_steps"
      WHERE "request_id" = NEW."id" AND "step_key" = 'FIRST_ADMIN';
    IF NOT FOUND OR NOT (
         (identity_step."state" = 'PENDING' AND identity_step."attempt" = 0)
      OR (identity_step."state" = 'ACTION_REQUIRED' AND identity_step."error_code" = 'FIRST_ADMIN_EMAIL_CONFLICT')
    ) THEN
      RAISE EXCEPTION 'PF_FIRST_ADMIN_EMAIL_LOCKED: อีเมล first admin แก้ได้ก่อน identity step เริ่มหรือเมื่อชนกับ identity อื่นเท่านั้น';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "pf_identity_reservations"
       WHERE "kind" = 'FIRST_ADMIN_EMAIL' AND "value_key" = NEW."first_admin_email_hash"
         AND "request_id" = NEW."id" AND "state" = 'HELD'
    ) THEN
      RAISE EXCEPTION 'PF_FIRST_ADMIN_EMAIL_UNRESERVED: ต้อง reserve อีเมลใหม่ก่อนเปลี่ยน';
    END IF;
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

-- append-only: การเปลี่ยนอีเมล first admin — hash เท่านั้น ไม่มี raw email
CREATE TABLE "pf_first_admin_email_revisions" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "request_revision" INTEGER NOT NULL,
    "previous_email_hash" CHAR(64) NOT NULL,
    "email_hash" CHAR(64) NOT NULL,
    "payload_digest" CHAR(64) NOT NULL,
    "actor_kind" "PfActorKind" NOT NULL,
    "actor_subject" TEXT NOT NULL,
    "reason_code" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_first_admin_email_revisions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pf_first_admin_email_revisions_revision_key" ON "pf_first_admin_email_revisions"("request_id", "request_revision");

ALTER TABLE "pf_first_admin_email_revisions" ADD CONSTRAINT "pf_first_admin_email_revisions_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_first_admin_email_revisions" ADD CONSTRAINT "pf_first_admin_email_revisions_values_check" CHECK (
  "request_revision" >= 2
  AND "previous_email_hash" ~ '^[a-f0-9]{64}$'
  AND "email_hash" ~ '^[a-f0-9]{64}$'
  AND "previous_email_hash" <> "email_hash"
  AND "payload_digest" ~ '^[a-f0-9]{64}$'
  AND "reason_code" ~ '^[A-Z][A-Z0-9_]{2,63}$'
  AND "actor_kind" = 'PLATFORM_OPERATOR'
);

CREATE TRIGGER "pf_first_admin_email_revisions_append_only" BEFORE UPDATE OR DELETE ON "pf_first_admin_email_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_mutation"();

GRANT SELECT, INSERT ON "pf_first_admin_email_revisions" TO dcontact_platform;
-- first_admin_email (raw) แก้ได้พร้อม hash; guard คุมเงื่อนไข
GRANT UPDATE ("first_admin_email", "first_admin_email_hash") ON "pf_provisioning_requests" TO dcontact_platform;
