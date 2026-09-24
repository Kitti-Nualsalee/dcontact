-- A1.6 (#411): durable operator command ของ Platform API
--
-- Authority: #388 checkpoint 1 (202 Accepted, Idempotency-Key, expectedRevision, previewDigest) และ
-- decision "Recovery ที่ต้องใช้ Keycloak ทำงานผ่าน durable command ของ worker"
--
-- API ตรวจสิ่งที่รู้ได้จาก DB แล้วบันทึก command; worker claim ด้วย lease/CAS แล้วทำ preview/execute
-- จริง ผลลง command + request state + Action history — API ไม่ถือ Keycloak credential
-- expand-only: enum/ตารางใหม่

CREATE TYPE "PfOperatorCommandKind" AS ENUM ('PREVIEW', 'EXECUTE');

CREATE TYPE "PfOperatorCommandState" AS ENUM ('QUEUED', 'RUNNING', 'SUCCEEDED', 'REJECTED');

CREATE TABLE "pf_operator_commands" (
    "id" UUID NOT NULL,
    "request_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "kind" "PfOperatorCommandKind" NOT NULL,
    "action" TEXT NOT NULL,
    "state" "PfOperatorCommandState" NOT NULL DEFAULT 'QUEUED',
    "revision" INTEGER NOT NULL DEFAULT 1,
    "expected_revision" INTEGER,
    "preview_digest" CHAR(64),
    "reason_code" TEXT,
    "comment" TEXT,
    "idempotency_key_hash" CHAR(64),
    "actor_kind" "PfActorKind" NOT NULL,
    "actor_subject" TEXT NOT NULL,
    "actor_role" TEXT,
    "actor_session_ref" TEXT,
    "correlation_id" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "lease_owner" TEXT,
    "lease_expires_at" TIMESTAMP(3),
    "result" JSONB,
    "error_code" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL,
    "started_at" TIMESTAMP(3),
    "finished_at" TIMESTAMP(3),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "pf_operator_commands_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "pf_operator_commands_idempotency_key_hash_key" ON "pf_operator_commands"("idempotency_key_hash");
-- execute ที่ยังไม่จบได้ครั้งละหนึ่งต่อ request — คำสั่งซ้อนได้ 409 แบบ deterministic
CREATE UNIQUE INDEX "pf_operator_commands_single_execute_key" ON "pf_operator_commands"("request_id")
  WHERE "kind" = 'EXECUTE' AND "state" IN ('QUEUED', 'RUNNING');
CREATE INDEX "pf_operator_commands_claim_idx" ON "pf_operator_commands"("state", "created_at");
CREATE INDEX "pf_operator_commands_request_idx" ON "pf_operator_commands"("request_id", "created_at");

ALTER TABLE "pf_operator_commands" ADD CONSTRAINT "pf_operator_commands_request_fkey" FOREIGN KEY ("tenant_id", "request_id") REFERENCES "pf_provisioning_requests"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "pf_operator_commands" ADD CONSTRAINT "pf_operator_commands_values_check" CHECK (
  "action" IN ('RECONCILE', 'RETRY_STEP', 'SAFE_COMPENSATE', 'MARK_FAILED_FINAL', 'RESEND_INVITATION')
  AND "revision" >= 1
  AND "attempt" >= 0
  AND ("reason_code" IS NULL OR "reason_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  AND ("error_code" IS NULL OR "error_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  AND ("preview_digest" IS NULL OR "preview_digest" ~ '^[a-f0-9]{64}$')
  AND ("idempotency_key_hash" IS NULL OR "idempotency_key_hash" ~ '^[a-f0-9]{64}$')
  AND ("comment" IS NULL OR char_length("comment") BETWEEN 1 AND 500)
  -- preview อ่านอย่างเดียว; resend ไม่มี preview (cap บังคับที่ DB)
  AND ("kind" <> 'PREVIEW' OR (
    "action" <> 'RESEND_INVITATION' AND "idempotency_key_hash" IS NULL AND "expected_revision" IS NULL
    AND "preview_digest" IS NULL AND "reason_code" IS NULL AND "comment" IS NULL
  ))
  -- execute ต้องมี Idempotency-Key, reason/comment และ actor ที่เป็นคน; recovery ต้องมี revision + digest
  AND ("kind" <> 'EXECUTE' OR (
    "idempotency_key_hash" IS NOT NULL AND "reason_code" IS NOT NULL AND "comment" IS NOT NULL
    AND "actor_kind" = 'PLATFORM_OPERATOR'
    AND ("action" = 'RESEND_INVITATION' OR ("expected_revision" IS NOT NULL AND "preview_digest" IS NOT NULL))
  ))
  AND (("state" IN ('SUCCEEDED', 'REJECTED')) = ("finished_at" IS NOT NULL))
  AND ("state" <> 'REJECTED' OR "error_code" IS NOT NULL)
);

CREATE TRIGGER "pf_operator_commands_retained" BEFORE DELETE ON "pf_operator_commands"
  FOR EACH ROW EXECUTE FUNCTION "pf_forbid_delete"();

CREATE FUNCTION "pf_operator_commands_guard"() RETURNS trigger AS $$
BEGIN
  IF (NEW."id", NEW."request_id", NEW."tenant_id", NEW."kind", NEW."action", NEW."expected_revision",
      NEW."preview_digest", NEW."reason_code", NEW."comment", NEW."idempotency_key_hash",
      NEW."actor_kind", NEW."actor_subject", NEW."actor_role", NEW."actor_session_ref",
      NEW."correlation_id", NEW."created_at")
     IS DISTINCT FROM
     (OLD."id", OLD."request_id", OLD."tenant_id", OLD."kind", OLD."action", OLD."expected_revision",
      OLD."preview_digest", OLD."reason_code", OLD."comment", OLD."idempotency_key_hash",
      OLD."actor_kind", OLD."actor_subject", OLD."actor_role", OLD."actor_session_ref",
      OLD."correlation_id", OLD."created_at") THEN
    RAISE EXCEPTION 'PF_COMMAND_IMMUTABLE: คำสั่งของ operator แก้ไม่ได้';
  END IF;
  IF OLD."state" IN ('SUCCEEDED', 'REJECTED') THEN
    RAISE EXCEPTION 'PF_COMMAND_FINISHED: คำสั่งที่จบแล้วแก้ไม่ได้';
  END IF;
  IF NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'PF_COMMAND_REVISION: revision ต้องเพิ่มทีละหนึ่ง (CAS)';
  END IF;
  IF NEW."state" <> OLD."state" AND NOT (
       (OLD."state" = 'QUEUED' AND NEW."state" = 'RUNNING')
    OR (OLD."state" = 'RUNNING' AND NEW."state" IN ('SUCCEEDED', 'REJECTED'))
  ) THEN
    RAISE EXCEPTION 'PF_COMMAND_TRANSITION: % -> % ไม่อนุญาต', OLD."state", NEW."state";
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "pf_operator_commands_guard" BEFORE UPDATE ON "pf_operator_commands"
  FOR EACH ROW EXECUTE FUNCTION "pf_operator_commands_guard"();

GRANT SELECT, INSERT, UPDATE ON "pf_operator_commands" TO dcontact_platform;
