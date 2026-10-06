-- AC1 (#594): นโยบายบัญชีของ tenant และตารางของ self-service บัญชี (#589, ADR-033) — additive ทั้งหมด

-- นโยบายของ tenant — ไม่มีแถว = ค่าเริ่มต้น (VERIFY, ไม่บังคับ 2FA) ซึ่ง API ตอบให้เอง
CREATE TABLE "tenant_account_policies" (
    "tenant_id" UUID NOT NULL,
    "email_change_policy" TEXT NOT NULL,
    "mfa_required" BOOLEAN NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "updated_by" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_account_policies_pkey" PRIMARY KEY ("tenant_id")
);
ALTER TABLE "tenant_account_policies" ADD CONSTRAINT "tenant_account_policies_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_account_policies" ADD CONSTRAINT "tenant_account_policies_values_check" CHECK (
  "email_change_policy" IN ('VERIFY', 'IMMEDIATE', 'ADMIN_ONLY') AND "revision" >= 1
);

-- audit ค่าก่อน/หลังของทุกการเปลี่ยนนโยบาย — append-only สำหรับ role ของแอป
CREATE TABLE "tenant_account_policy_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_account_policy_audit_events_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "tenant_account_policy_audit_events" ADD CONSTRAINT "tenant_account_policy_audit_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_account_policy_audit_events" ADD CONSTRAINT "tenant_account_policy_audit_events_values_check" CHECK (
  length(btrim("reason")) BETWEEN 3 AND 500
);
CREATE INDEX "tenant_account_policy_audit_events_tenant_idx"
  ON "tenant_account_policy_audit_events" ("tenant_id", "occurred_at");

-- คำขอเปลี่ยน email ที่รอยืนยัน — เก็บเฉพาะ SHA-256 ของ token (token ดิบอยู่ใน email เท่านั้น)
CREATE TABLE "account_email_changes" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "new_email" TEXT NOT NULL,
    "token_hash" CHAR(64) NOT NULL,
    "status" TEXT NOT NULL,
    "requested_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "completed_at" TIMESTAMP(3),

    CONSTRAINT "account_email_changes_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "account_email_changes" ADD CONSTRAINT "account_email_changes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_email_changes" ADD CONSTRAINT "account_email_changes_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "account_email_changes" ADD CONSTRAINT "account_email_changes_values_check" CHECK (
  "status" IN ('PENDING', 'CONFIRMED', 'CANCELLED', 'EXPIRED')
  AND "token_hash" ~ '^[0-9a-f]{64}$'
  AND length("new_email") BETWEEN 3 AND 320
  AND "expires_at" > "requested_at"
  AND (("status" = 'PENDING') = ("completed_at" IS NULL))
);
CREATE UNIQUE INDEX "account_email_changes_token_hash_key" ON "account_email_changes" ("token_hash");
-- คำขอที่รอยืนยันได้ครั้งละหนึ่งรายการต่อผู้ใช้
CREATE UNIQUE INDEX "account_email_changes_pending_user_key"
  ON "account_email_changes" ("tenant_id", "user_id") WHERE "status" = 'PENDING';

-- การลงทะเบียน TOTP ที่ยังไม่ยืนยัน — secret เข้ารหัสด้วย key ของ API (AC4) อายุสั้น และนับครั้งที่ลอง
CREATE TABLE "account_totp_enrolments" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "secret_ciphertext" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_totp_enrolments_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "account_totp_enrolments" ADD CONSTRAINT "account_totp_enrolments_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_totp_enrolments" ADD CONSTRAINT "account_totp_enrolments_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "account_totp_enrolments" ADD CONSTRAINT "account_totp_enrolments_values_check" CHECK (
  "attempts" BETWEEN 0 AND 5 AND "expires_at" > "created_at" AND length("secret_ciphertext") > 0
);
CREATE INDEX "account_totp_enrolments_user_idx" ON "account_totp_enrolments" ("tenant_id", "user_id");

-- audit ของการกระทำกับบัญชีตัวเอง — ห้ามมีรหัสผ่าน, secret, token หรือ email (ตรวจที่ API) และ append-only
CREATE TABLE "account_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "metadata" JSONB,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_audit_events_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "account_audit_events" ADD CONSTRAINT "account_audit_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "account_audit_events" ADD CONSTRAINT "account_audit_events_values_check" CHECK (
  "action" IN (
    'password.changed',
    'email.change.requested', 'email.change.confirmed', 'email.change.cancelled',
    'profile.updated',
    'mfa.enrolled', 'mfa.removed'
  )
);
CREATE INDEX "account_audit_events_user_idx" ON "account_audit_events" ("tenant_id", "user_id", "occurred_at");
