-- S2.5 (#369): message projection dedupe และ durable event outbox ของ Channels
--
-- expand-only ตาม #362 §11 — ไม่มี backfill และไม่แตะตารางเดิมของ S2.1/S2.2/S2.3
--
-- สองชั้นของ inbound dedupe (#359 §E):
--   1. ingress dedupe = dl_line_webhook_inbox (tenant, channel_account_id, webhook_event_id) ของ S2.1
--   2. projection dedupe = ตารางนี้ (tenant, channel_account_id, provider_message_id) ตาม ADR-024
-- ชั้นที่สองจำเป็นเพราะ message object เดิมมาได้จาก event ID คนละตัว (redelivery หลัง provider retry)
--
-- dl_line_event_outbox เป็น durable outbox ของ owner Delivery/Channels เอง ไม่ใช้ cg_event_outbox
-- ซึ่งเป็นของ Contact Governance (#362 §2 ownership) payload เป็น PII-safe envelope ตาม §5:
-- มีได้เฉพาะ opaque IDs, digest, code และเวลา — CHECK ด้านล่างกันชื่อ field ต้องห้ามที่ระดับ database

-- ── 1. dl_line_inbound_messages (projection dedupe ชั้นที่ 2) ────────────────

CREATE TABLE "dl_line_inbound_messages" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "channel_account_id" TEXT NOT NULL,
  -- message.id จาก provider เท่านั้น (ADR-024 ข้อ 2) ห้ามเป็นค่าที่ผู้ส่งกำหนด
  "provider_message_id" TEXT NOT NULL,
  "inbox_entry_id" UUID NOT NULL,
  -- sentMessages.id ที่ถูก quote ถ้ามี — ใช้ผูก Attempt ต่อใน correlation
  "quoted_message_id" TEXT,
  -- SHA-256 ของ source userId + channel account: เทียบ recipient binding ได้โดยไม่เก็บ userId
  "source_fingerprint" CHAR(64) NOT NULL,
  "provider_timestamp" TIMESTAMP(3) NOT NULL,
  "projected_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_line_inbound_messages_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_inbound_messages_values_check" CHECK (
    "provider_message_id" ~ '^[0-9]{1,32}$'
    AND ("quoted_message_id" IS NULL OR "quoted_message_id" ~ '^[0-9]{1,32}$')
    AND "source_fingerprint" ~ '^[0-9a-f]{64}$'
    AND "channel_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  )
);

CREATE UNIQUE INDEX "dl_line_inbound_messages_tenant_id_key"
  ON "dl_line_inbound_messages"("tenant_id", "id");
-- projection dedupe (#359 §E ชั้นที่ 2, ADR-024 ข้อ 2)
CREATE UNIQUE INDEX "dl_line_inbound_messages_provider_key"
  ON "dl_line_inbound_messages"("tenant_id", "channel_account_id", "provider_message_id");
-- inbox entry หนึ่งแถว project ข้อความได้ครั้งเดียว
CREATE UNIQUE INDEX "dl_line_inbound_messages_inbox_key"
  ON "dl_line_inbound_messages"("tenant_id", "inbox_entry_id");
CREATE INDEX "dl_line_inbound_messages_quote_idx"
  ON "dl_line_inbound_messages"("tenant_id", "quoted_message_id");

ALTER TABLE "dl_line_inbound_messages"
  ADD CONSTRAINT "dl_line_inbound_messages_tenant_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- composite tenant FK: projection ข้าม tenant ของ inbox ไม่ได้แม้ application จะพลาด
ALTER TABLE "dl_line_inbound_messages"
  ADD CONSTRAINT "dl_line_inbound_messages_inbox_fkey" FOREIGN KEY ("tenant_id", "inbox_entry_id")
  REFERENCES "dl_line_webhook_inbox"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 2. dl_line_event_outbox (PII-safe event envelope ของ owner) ──────────────

CREATE TYPE "DlLineEventOutboxState" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED');

CREATE TABLE "dl_line_event_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  -- eventId คงที่ต่อ transition เดิม (#362 §5) — consumer dedupe ด้วยคีย์นี้
  "event_id" TEXT NOT NULL,
  "event_type" TEXT NOT NULL,
  "ordering_key" TEXT NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "state" "DlLineEventOutboxState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_line_event_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_event_outbox_values_check" CHECK (
    "event_type" IN (
      'delivery.line.lifecycle.v1', 'channel.line.inbound.v1', 'contact.touch.correlated.v1'
    )
    AND "event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    AND "ordering_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    AND "payload_hash" ~ '^[0-9a-f]{64}$'
    AND "attempts" >= 0
    AND ("lease_owner" IS NULL OR "lease_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  ),
  -- field ต้องห้ามตาม #362 §5: raw recipient/body/token/signature ห้ามอยู่ใน event ใด ๆ
  CONSTRAINT "dl_line_event_outbox_pii_check" CHECK (
    NOT ("payload" ?| ARRAY[
      'userId', 'destination', 'replyToken', 'quoteToken', 'text', 'body', 'message',
      'signature', 'accessToken', 'channelSecret', 'recipient', 'phone', 'email'
    ])
  ),
  CONSTRAINT "dl_line_event_outbox_state_check" CHECK (
    (("state" = 'PUBLISHING') = ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
    AND (("state" = 'PUBLISHED') = ("published_at" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "dl_line_event_outbox_tenant_id_key"
  ON "dl_line_event_outbox"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_event_outbox_event_key"
  ON "dl_line_event_outbox"("tenant_id", "event_id");
CREATE INDEX "dl_line_event_outbox_claim_idx"
  ON "dl_line_event_outbox"("tenant_id", "state", "available_at", "lease_expires_at");

ALTER TABLE "dl_line_event_outbox"
  ADD CONSTRAINT "dl_line_event_outbox_tenant_fkey" FOREIGN KEY ("tenant_id")
  REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- payload/identity ของ event ที่ publish แล้วแก้ไม่ได้ — evidence ต้องตรวจซ้ำได้
CREATE FUNCTION dl_line_event_outbox_guard() RETURNS trigger AS $$
BEGIN
  IF OLD.event_id <> NEW.event_id
    OR OLD.event_type <> NEW.event_type
    OR OLD.payload_hash <> NEW.payload_hash
    OR OLD.payload::text <> NEW.payload::text
    OR OLD.occurred_at <> NEW.occurred_at
  THEN
    RAISE EXCEPTION 'DL_LINE_EVENT_IMMUTABLE: dl_line_event_outbox แก้ identity/payload ของ event ไม่ได้';
  END IF;
  IF OLD.state = 'PUBLISHED' AND NEW.state <> 'PUBLISHED' THEN
    RAISE EXCEPTION 'DL_LINE_EVENT_PUBLISHED: event ที่ publish แล้วย้อน state ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dl_line_event_outbox_guard_trigger
  BEFORE UPDATE ON "dl_line_event_outbox"
  FOR EACH ROW EXECUTE FUNCTION dl_line_event_outbox_guard();

-- ── 3. RLS และ grants ───────────────────────────────────────────────────────

DO $$
DECLARE t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['dl_line_inbound_messages', 'dl_line_event_outbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- projection เป็น append-only: แก้/ลบไม่ได้ เพราะเป็นหลักฐานว่า message ถูก project ไปแล้ว
GRANT SELECT, INSERT ON "dl_line_inbound_messages" TO dcontact_app;
REVOKE UPDATE, DELETE ON "dl_line_inbound_messages" FROM dcontact_app;
-- outbox ต้อง UPDATE ได้เพื่อ claim/publish แต่ลบไม่ได้
GRANT SELECT, INSERT, UPDATE ON "dl_line_event_outbox" TO dcontact_app;
REVOKE DELETE ON "dl_line_event_outbox" FROM dcontact_app;
