-- S2.5 (#369): encrypted operational payload ของ webhook event
--
-- #359 §C ให้ inbox เก็บ "encrypted operational payload/ref" และ §D ให้ manual replay อ่านจาก ref นั้น
-- แล้วสร้าง downstream event ID เดิม — ref ที่ไม่มีที่เก็บจริงจะ replay ไม่ได้ ตารางนี้จึงเป็นที่เก็บ
--
-- คุณสมบัติ:
-- - ciphertext เท่านั้น (AES-256-GCM) ไม่มี plaintext body/userId/replyToken ในคอลัมน์ใด
-- - key_ref เป็นชื่อ keychain reference ไม่ใช่ตัว key
-- - append-only สำหรับ application role: replay ต้องอ่านของเดิมได้เสมอ ไม่ใช่ของที่ถูกเขียนทับ

CREATE TABLE "dl_line_webhook_payloads" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  -- ref เดียวกับที่ dl_line_webhook_inbox.protected_payload_ref ถืออยู่
  "protected_payload_ref" TEXT NOT NULL,
  "channel_account_id" TEXT NOT NULL,
  "key_ref" TEXT NOT NULL,
  "iv" BYTEA NOT NULL,
  "auth_tag" BYTEA NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_line_webhook_payloads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_webhook_payloads_values_check" CHECK (
    "protected_payload_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    AND "protected_payload_ref" !~ 'U[0-9a-f]{32}'
    AND "key_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND octet_length("iv") = 12
    AND octet_length("auth_tag") = 16
    AND octet_length("ciphertext") BETWEEN 1 AND 1048576
  )
);

CREATE UNIQUE INDEX "dl_line_webhook_payloads_tenant_id_key"
  ON "dl_line_webhook_payloads"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_webhook_payloads_ref_key"
  ON "dl_line_webhook_payloads"("tenant_id", "protected_payload_ref");

ALTER TABLE "dl_line_webhook_payloads"
  ADD CONSTRAINT "dl_line_webhook_payloads_tenant_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "dl_line_webhook_payloads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dl_line_webhook_payloads" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dl_line_webhook_payloads"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON "dl_line_webhook_payloads" TO dcontact_app;
REVOKE UPDATE, DELETE ON "dl_line_webhook_payloads" FROM dcontact_app;
