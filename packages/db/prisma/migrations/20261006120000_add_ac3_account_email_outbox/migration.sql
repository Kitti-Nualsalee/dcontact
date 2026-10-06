-- AC3 (#596): outbox ของ email บัญชีที่ D-Contact ส่งเอง (#589, ADR-033) — additive
--
-- - ผู้เรียก (AC4) เขียนแถวใน transaction เดียวกับการเปลี่ยนบัญชี; `dedupe_key` ซ้ำ = ไม่เพิ่มแถว
-- - ตัวส่งจองแถวด้วย lease (`SENDING` + `lease_expires_at`) แล้วส่งนอก transaction; ล้ม = retry แบบ backoff
-- - ผู้รับและตัวแปร (เช่น token ยืนยัน) ถูกล้างเมื่อจบ (`SENT`/`DEAD`) — ไม่มี PII/secret ค้างหลังส่ง
CREATE TABLE "account_email_outbox" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID,
    "template" TEXT NOT NULL,
    "locale" TEXT NOT NULL,
    "recipient" TEXT,
    "variables" JSONB,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lease_expires_at" TIMESTAMP(3),
    "last_error_code" TEXT,
    "sent_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_email_outbox_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "account_email_outbox" ADD CONSTRAINT "account_email_outbox_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_email_outbox" ADD CONSTRAINT "account_email_outbox_values_check" CHECK (
  "template" IN ('verify-new-email', 'email-changed-notice', 'password-changed-notice')
  AND "locale" IN ('th', 'en')
  AND "status" IN ('PENDING', 'SENDING', 'SENT', 'DEAD')
  AND "attempts" >= 0
  AND length("dedupe_key") BETWEEN 1 AND 200
  -- งานที่ยังไม่จบต้องมีผู้รับและตัวแปร; งานที่จบแล้วต้องไม่มี
  AND (("status" IN ('PENDING', 'SENDING')) = ("recipient" IS NOT NULL AND "variables" IS NOT NULL))
  AND (("status" = 'SENDING') = ("lease_expires_at" IS NOT NULL))
  AND (("status" = 'SENT') = ("sent_at" IS NOT NULL))
);
CREATE UNIQUE INDEX "account_email_outbox_dedupe_key"
  ON "account_email_outbox" ("tenant_id", "dedupe_key");
CREATE INDEX "account_email_outbox_due_idx"
  ON "account_email_outbox" ("tenant_id", "status", "available_at");
