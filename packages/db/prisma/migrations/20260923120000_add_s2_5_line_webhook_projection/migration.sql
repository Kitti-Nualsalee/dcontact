-- S2.5 (#369): ที่เก็บ protected payload ของ webhook และ inbound message projection ตาม ADR-024
--
-- Expand ล้วน: สร้างตารางใหม่สองตาราง ไม่แตะตารางเดิม ไม่ backfill
-- trigger RAISE ด้วย machine code ASCII นำหน้า (DL_*) เพราะ Prisma escape ข้อความไทยใน error
--
-- 1) dl_line_protected_payloads — ciphertext ของ webhook event ทั้งก้อน (มี userId/body/replyToken)
--    เข้ารหัส AES-256-GCM ฝั่งแอป กุญแจอยู่ Keychain ไม่อยู่ใน database/env (#362 §9)
--    ตารางนี้ไม่มี plaintext ใด ๆ; ref คือสิ่งเดียวที่ inbox/evidence อ้างถึง (#359 §C)
-- 2) dl_line_inbound_messages — dedupe ชั้นที่สองของ #359 §E ด้วยคีย์ของ ADR-024
--    `(tenant_id, channel_account_id, provider_message_id)` เก็บแค่ opaque ref ไม่มี body/userId

CREATE TABLE "dl_line_protected_payloads" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "payload_ref" TEXT NOT NULL,
  "key_version" INTEGER NOT NULL,
  "nonce" BYTEA NOT NULL,
  "auth_tag" BYTEA NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_line_protected_payloads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_protected_payloads_values_check" CHECK (
    "payload_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    AND "payload_ref" !~ 'U[0-9a-f]{32}'
    AND "key_version" >= 1
    AND octet_length("nonce") = 12
    AND octet_length("auth_tag") = 16
    AND octet_length("ciphertext") BETWEEN 1 AND 1048576
  )
);

CREATE UNIQUE INDEX "dl_line_protected_payloads_tenant_id_key" ON "dl_line_protected_payloads"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_protected_payloads_ref_key" ON "dl_line_protected_payloads"("tenant_id", "payload_ref");

ALTER TABLE "dl_line_protected_payloads"
  ADD CONSTRAINT "dl_line_protected_payloads_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "dl_line_inbound_messages" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "channel_account_id" TEXT NOT NULL,
  -- LINE `message.id` — id จากระบบผู้รับตาม ADR-024 ข้อ 2 ไม่ใช่ค่าที่ผู้ส่งกำหนด
  "provider_message_id" TEXT NOT NULL,
  "inbox_entry_id" UUID NOT NULL,
  "webhook_event_id" TEXT NOT NULL,
  "message_type" TEXT NOT NULL,
  "provider_timestamp" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_line_inbound_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_inbound_messages_values_check" CHECK (
    "channel_account_id" ~ '^[0-9]{1,32}$'
    AND "provider_message_id" ~ '^[0-9]{1,32}$'
    AND "webhook_event_id" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "message_type" ~ '^[a-z][A-Za-z0-9_]{0,31}$'
  )
);

CREATE UNIQUE INDEX "dl_line_inbound_messages_tenant_id_key" ON "dl_line_inbound_messages"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_inbound_messages_provider_key"
  ON "dl_line_inbound_messages"("tenant_id", "channel_account_id", "provider_message_id");
CREATE INDEX "dl_line_inbound_messages_inbox_idx" ON "dl_line_inbound_messages"("tenant_id", "inbox_entry_id");

ALTER TABLE "dl_line_inbound_messages"
  ADD CONSTRAINT "dl_line_inbound_messages_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dl_line_inbound_messages"
  ADD CONSTRAINT "dl_line_inbound_messages_inbox_fkey" FOREIGN KEY ("tenant_id", "inbox_entry_id")
  REFERENCES "dl_line_webhook_inbox"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── Triggers ─────────────────────────────────────────────────────────────────
-- ciphertext ที่แก้ได้ = payload ที่ replay แล้วได้ event คนละตัว (#359 §D ห้ามแก้ payload)
CREATE TRIGGER "dl_line_protected_payloads_immutable" BEFORE UPDATE ON "dl_line_protected_payloads"
  FOR EACH ROW EXECUTE FUNCTION dl_line_reject_update();
CREATE TRIGGER "dl_line_inbound_messages_immutable" BEFORE UPDATE ON "dl_line_inbound_messages"
  FOR EACH ROW EXECUTE FUNCTION dl_line_reject_update();

-- ── RLS ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['dl_line_protected_payloads', 'dl_line_inbound_messages']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- ── Grants ───────────────────────────────────────────────────────────────────
-- ลบ payload ตาม retention เป็นงานของ owner role ไม่ใช่ application role

GRANT SELECT, INSERT ON "dl_line_protected_payloads" TO dcontact_app;
REVOKE UPDATE, DELETE ON "dl_line_protected_payloads" FROM dcontact_app;
GRANT SELECT, INSERT ON "dl_line_inbound_messages" TO dcontact_app;
REVOKE UPDATE, DELETE ON "dl_line_inbound_messages" FROM dcontact_app;
