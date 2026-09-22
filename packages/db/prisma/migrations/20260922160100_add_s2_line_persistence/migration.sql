-- S2.1 (#365): persistence foundation ของ LINE provider pilot ตาม Phase Contract #362 §3/§11
--
-- Expand ล้วน: ไม่ drop/rename อะไร และไม่ backfill แถว TEST_ADAPTER เดิม
-- constraint ที่เพิ่มบน dl_outbox_entries มีผลกับแถว LINE เท่านั้น ส่วน identity guard
-- ตรึงคอลัมน์ที่ adapter เดิมไม่เคยแก้อยู่แล้ว
--
-- trigger ทุกตัว RAISE ด้วย machine code ภาษาอังกฤษนำหน้า (DL_*) ให้ผู้เรียก/เทสต์อ้างได้คงที่
--
-- กติกาทั้งไฟล์:
-- - FK ข้าม entity ใช้ (tenant_id, ...) เสมอ; ตารางลูกของ outbox ผูก adapter ด้วยเพื่อให้
--   หลักฐาน LINE อ้างแถว TEST_ADAPTER ไม่ได้
-- - ทุกตาราง ENABLE RLS + tenant_isolation ทั้ง USING/WITH CHECK
-- - dcontact_app ลบไม่ได้ทุกตาราง; attempt receipt และ audit แก้ไม่ได้ทั้งที่ grant และ trigger
-- - ไม่มีคอลัมน์ใดเก็บ token/secret/raw LINE user ID/message body — ref ทุกตัวเป็น opaque
--   และ CHECK ปฏิเสธรูปแบบ LINE user ID (`U` + hex 32 ตัว) ที่หลุดเข้ามา

-- ── Enums ────────────────────────────────────────────────────────────────────

CREATE TYPE "DlLineProviderOutcomeCode" AS ENUM (
  'LINE_ACCEPTED', 'LINE_ACCEPTED_REPLAY', 'LINE_REQUEST_REJECTED', 'LINE_AUTH_INVALID',
  'LINE_RATE_LIMITED', 'LINE_MONTHLY_QUOTA_EXHAUSTED', 'LINE_PROVIDER_UNAVAILABLE',
  'LINE_UNKNOWN_OUTCOME', 'LINE_RESPONSE_INVALID', 'LINE_RETRY_WINDOW_EXPIRED'
);
CREATE TYPE "DlLineProviderOutcomeClass" AS ENUM ('ACCEPTED', 'TERMINAL_REJECTED', 'RETRYABLE_UNKNOWN', 'QUARANTINED');
CREATE TYPE "DlLineRejectionScope" AS ENUM ('RECIPIENT', 'OPERATIONAL');
CREATE TYPE "DlLineRolloutState" AS ENUM ('DISABLED', 'DRY_RUN', 'PROVIDER_CONFORMANCE', 'CAPPED_PILOT');
CREATE TYPE "DlLineKillReason" AS ENUM (
  'CROSS_TENANT_LEAK', 'ALLOWLIST_BINDING_MISMATCH', 'CG3_BYPASS', 'DUPLICATE_BUSINESS_EFFECT',
  'PII_OR_CREDENTIAL_LEAK', 'EVIDENCE_HASH_MISMATCH', 'UNKNOWN_OUTCOME_EXPIRED',
  'PROVIDER_ATTEMPTS_EXHAUSTED', 'AUTH_FAILURE', 'QUOTA_EXHAUSTED', 'CAP_ACCOUNTING_INCONSISTENCY',
  'OPERATOR_KILL', 'COMPLIANCE_KILL', 'PILOT_ROLLBACK'
);
CREATE TYPE "DlLineRunAuthorizationState" AS ENUM ('PROPOSED', 'APPROVED', 'CONSUMED', 'EXPIRED', 'REVOKED');
CREATE TYPE "DlLineCapKind" AS ENUM ('LOGICAL_DELIVERY', 'PROVIDER_ATTEMPT', 'CONCURRENT_SUBMISSION', 'CONCURRENT_UNKNOWN');
CREATE TYPE "DlLineCapReservationState" AS ENUM ('RESERVED', 'COMMITTED', 'RELEASED');
CREATE TYPE "DlLineCredentialKind" AS ENUM ('CHANNEL_ACCESS_TOKEN_V2_1', 'CHANNEL_ACCESS_TOKEN_LONG_LIVED', 'CHANNEL_SECRET');
CREATE TYPE "DlLineCredentialStatus" AS ENUM ('CANDIDATE', 'ACTIVE', 'RETIRED', 'REVOKED');
CREATE TYPE "DlLineWebhookInboxState" AS ENUM ('PENDING', 'PROCESSING', 'COMPLETED', 'QUARANTINED');
CREATE TYPE "DlLineWebhookCode" AS ENUM (
  'WEBHOOK_ACCEPTED', 'WEBHOOK_DUPLICATE', 'WEBHOOK_EMPTY_VERIFICATION', 'WEBHOOK_SIGNATURE_INVALID',
  'WEBHOOK_DESTINATION_MISMATCH', 'WEBHOOK_SCHEMA_INVALID', 'WEBHOOK_IDEMPOTENCY_CONFLICT',
  'WEBHOOK_UNSUPPORTED_EVENT_TYPE', 'WEBHOOK_DURABILITY_UNAVAILABLE', 'WEBHOOK_QUARANTINED'
);
CREATE TYPE "DlLineTouchCorrelationState" AS ENUM ('PENDING', 'BOUND', 'QUARANTINED');
CREATE TYPE "DlLineAuditCategory" AS ENUM (
  'GATE', 'KILL', 'ALLOWLIST', 'RUN_AUTHORIZATION', 'CAP', 'CREDENTIAL', 'PROVIDER', 'WEBHOOK'
);
CREATE TYPE "DlLineActorKind" AS ENUM ('TENANT_ADMIN', 'COMPLIANCE', 'PLATFORM_OPERATOR', 'SYSTEM');
-- Governance-owned: หลักฐานของ Touch แบบ explicit เท่านั้น (#361 §D)
CREATE TYPE "CgTouchEvidenceKind" AS ENUM ('USER_QUOTED_RESPONSE', 'SIGNED_POSTBACK');

-- ── 0. dl_outbox_entries: binding key + LINE invariants ─────────────────────

-- ตารางลูกอ้าง (delivery, key, adapter) พร้อมกัน: receipt จึงผูก providerRequestKey เดิมได้ทางเดียว
CREATE UNIQUE INDEX "dl_outbox_entries_tenant_delivery_request_adapter_key"
  ON "dl_outbox_entries"("tenant_id", "delivery_id", "provider_request_key", "adapter");
CREATE UNIQUE INDEX "dl_outbox_entries_tenant_delivery_adapter_key"
  ON "dl_outbox_entries"("tenant_id", "delivery_id", "adapter");

-- LINE: channel ต้องเป็น LINE, retry key เป็น hexadecimal UUID (#357 §2) และ standard push
-- ห้ามมี DELIVERED/DELIVERY_FAILED เพราะไม่มี authoritative per-message evidence (#361 §A)
ALTER TABLE "dl_outbox_entries" ADD CONSTRAINT "dl_outbox_entries_line_binding_check" CHECK (
  "adapter" <> 'LINE_MESSAGING_API'
  OR (
    "channel" = 'LINE'
    AND "provider_request_key" ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    AND ("outcome" IS NULL OR "outcome" IN ('PROVIDER_ACCEPTED', 'PROVIDER_REJECTED'))
  )
);

-- identity และ content binding ของ delivery คงที่ตลอดอายุ — ห้าม mint key ใหม่หรือเปลี่ยน
-- ปลายทาง/เนื้อหาหลัง persist (#357 §2); state/lease/outcome ยังเดินได้ตามเดิม
CREATE FUNCTION dl_outbox_guard_identity() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.action_key, NEW.reservation_id, NEW.delivery_id,
      NEW.provider_request_key, NEW.adapter, NEW.channel, NEW.contact_id, NEW.identity_id,
      NEW.purpose, NEW.sender_identity_id, NEW.content_ref, NEW.input_hash, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.action_key, OLD.reservation_id, OLD.delivery_id,
      OLD.provider_request_key, OLD.adapter, OLD.channel, OLD.contact_id, OLD.identity_id,
      OLD.purpose, OLD.sender_identity_id, OLD.content_ref, OLD.input_hash, OLD.created_at) THEN
    RAISE EXCEPTION 'DL_OUTBOX_IDENTITY_IMMUTABLE: dl_outbox_entries แก้ identity/binding ของ delivery ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_outbox_entries_identity_guard" BEFORE UPDATE ON "dl_outbox_entries"
  FOR EACH ROW EXECUTE FUNCTION dl_outbox_guard_identity();

-- ── 1. dl_provider_submission_attempts (append-only HTTP attempt receipt) ────

CREATE TABLE "dl_provider_submission_attempts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "provider_request_key" TEXT NOT NULL,
  "adapter" "DlDeliveryAdapter" NOT NULL DEFAULT 'LINE_MESSAGING_API',
  "attempt_no" INTEGER NOT NULL,
  "provider_payload_digest" CHAR(64) NOT NULL,
  "started_at" TIMESTAMP(3) NOT NULL,
  "finished_at" TIMESTAMP(3) NOT NULL,
  "http_status" INTEGER,
  "outcome_code" "DlLineProviderOutcomeCode" NOT NULL,
  "outcome_class" "DlLineProviderOutcomeClass" NOT NULL,
  "rejection_scope" "DlLineRejectionScope",
  "line_request_id" TEXT,
  "line_accepted_request_id" TEXT,
  "sent_message_ids" TEXT[] NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_provider_submission_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_provider_submission_attempts_adapter_check" CHECK ("adapter" = 'LINE_MESSAGING_API'),
  -- initial + retry รวมไม่เกิน 4 (#358 §C)
  CONSTRAINT "dl_provider_submission_attempts_attempt_no_check" CHECK ("attempt_no" BETWEEN 1 AND 4),
  CONSTRAINT "dl_provider_submission_attempts_values_check" CHECK (
    "provider_payload_digest" ~ '^[a-f0-9]{64}$'
    AND "finished_at" >= "started_at"
    AND ("http_status" IS NULL OR "http_status" BETWEEN 100 AND 599)
    AND cardinality("sent_message_ids") <= 5
    AND ("line_request_id" IS NULL OR "line_request_id" ~ '^[A-Za-z0-9-]{1,128}$')
    AND ("line_accepted_request_id" IS NULL OR "line_accepted_request_id" ~ '^[A-Za-z0-9-]{1,128}$')
  ),
  -- code -> class ตาม #357 §5; ห้ามให้ caller ตัดสิน class เอง
  CONSTRAINT "dl_provider_submission_attempts_class_check" CHECK (
    "outcome_class" = CASE "outcome_code"
      WHEN 'LINE_ACCEPTED' THEN 'ACCEPTED'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_ACCEPTED_REPLAY' THEN 'ACCEPTED'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_REQUEST_REJECTED' THEN 'TERMINAL_REJECTED'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_AUTH_INVALID' THEN 'TERMINAL_REJECTED'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_RATE_LIMITED' THEN 'TERMINAL_REJECTED'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_MONTHLY_QUOTA_EXHAUSTED' THEN 'TERMINAL_REJECTED'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_PROVIDER_UNAVAILABLE' THEN 'RETRYABLE_UNKNOWN'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_UNKNOWN_OUTCOME' THEN 'RETRYABLE_UNKNOWN'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_RESPONSE_INVALID' THEN 'RETRYABLE_UNKNOWN'::"DlLineProviderOutcomeClass"
      WHEN 'LINE_RETRY_WINDOW_EXPIRED' THEN 'QUARANTINED'::"DlLineProviderOutcomeClass"
    END
  ),
  -- rejection ต้องบอก scope เพราะนับ Attempt ต่างกัน; auth/rate/quota เป็น operational เสมอ (#361 §B)
  CONSTRAINT "dl_provider_submission_attempts_rejection_check" CHECK (
    ("outcome_class" = 'TERMINAL_REJECTED') = ("rejection_scope" IS NOT NULL)
    AND NOT (
      "rejection_scope" = 'RECIPIENT'
      AND "outcome_code" IN ('LINE_AUTH_INVALID', 'LINE_RATE_LIMITED', 'LINE_MONTHLY_QUOTA_EXHAUSTED')
    )
  ),
  -- acceptance ต้องมีหลักฐานจาก provider: 2xx + request ID หรือ 409 + accepted request ID (#357 §3)
  CONSTRAINT "dl_provider_submission_attempts_acceptance_check" CHECK (
    ("outcome_code" <> 'LINE_ACCEPTED'
      OR ("http_status" BETWEEN 200 AND 299 AND "line_request_id" IS NOT NULL))
    AND ("outcome_code" <> 'LINE_ACCEPTED_REPLAY'
      OR ("http_status" = 409 AND "line_accepted_request_id" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "dl_provider_submission_attempts_tenant_id_key"
  ON "dl_provider_submission_attempts"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_provider_submission_attempts_attempt_key"
  ON "dl_provider_submission_attempts"("tenant_id", "delivery_id", "attempt_no");
-- provider request receipt identity: x-line-request-id หนึ่งค่าเป็นของ attempt เดียว
CREATE UNIQUE INDEX "dl_provider_submission_attempts_request_id_key"
  ON "dl_provider_submission_attempts"("tenant_id", "line_request_id")
  WHERE "line_request_id" IS NOT NULL;

ALTER TABLE "dl_provider_submission_attempts"
  ADD CONSTRAINT "dl_provider_submission_attempts_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dl_provider_submission_attempts"
  ADD CONSTRAINT "dl_provider_submission_attempts_outbox_fkey" FOREIGN KEY ("tenant_id", "delivery_id", "provider_request_key", "adapter")
  REFERENCES "dl_outbox_entries"("tenant_id", "delivery_id", "provider_request_key", "adapter") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── 2. dl_line_scope_gates (exact scope business state + switch + kill latch) ─

CREATE TABLE "dl_line_scope_gates" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "profile" TEXT NOT NULL DEFAULT 'S2_LINE_LOCAL_PILOT_V1',
  "channel" "ChannelType" NOT NULL DEFAULT 'LINE',
  "channel_account_id" TEXT NOT NULL,
  "sender_identity_id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "contact_kind" TEXT NOT NULL,
  "business_state" "DlLineRolloutState" NOT NULL DEFAULT 'DISABLED',
  "technical_switch_on" BOOLEAN NOT NULL DEFAULT false,
  "killed" BOOLEAN NOT NULL DEFAULT false,
  "kill_reason" "DlLineKillReason",
  "killed_at" TIMESTAMP(3),
  -- approval/proposal ref ที่อนุญาตให้ยก kill ครั้งล่าสุด — ต้องเป็นค่าใหม่ทุกครั้ง (#358 §E)
  "kill_cleared_ref" TEXT,
  "config_digest" CHAR(64),
  "version" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_line_scope_gates_pkey" PRIMARY KEY ("id"),
  -- S2 มี profile และ pilot tuple เดียว (#356/#358 §B)
  CONSTRAINT "dl_line_scope_gates_scope_check" CHECK (
    "profile" = 'S2_LINE_LOCAL_PILOT_V1'
    AND "channel" = 'LINE'
    AND "channel_account_id" ~ '^[0-9]{1,32}$'
    AND "sender_identity_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    AND "purpose" = 'SERVICE_NOTIFICATION'
    AND "contact_kind" = 'SERVICE'
  ),
  CONSTRAINT "dl_line_scope_gates_version_check" CHECK ("version" >= 1),
  -- kill ครบทั้งชุดหรือไม่มีเลย และ kill บังคับ switch ปิดในแถวเดียวกัน
  CONSTRAINT "dl_line_scope_gates_kill_check" CHECK (
    ("killed" = ("kill_reason" IS NOT NULL))
    AND ("killed" = ("killed_at" IS NOT NULL))
    AND NOT ("killed" AND "technical_switch_on")
  ),
  -- ข้าม DRY_RUN ไปแตะ provider ได้ต้องมี config digest ที่ allowlist/run authorization pin ไว้
  CONSTRAINT "dl_line_scope_gates_config_check" CHECK (
    ("config_digest" IS NULL OR "config_digest" ~ '^[a-f0-9]{64}$')
    AND ("business_state" IN ('DISABLED', 'DRY_RUN') OR "config_digest" IS NOT NULL)
    AND ("kill_cleared_ref" IS NULL OR "kill_cleared_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$')
  )
);

CREATE UNIQUE INDEX "dl_line_scope_gates_tenant_id_key" ON "dl_line_scope_gates"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_scope_gates_scope_key"
  ON "dl_line_scope_gates"("tenant_id", "channel_account_id", "sender_identity_id", "purpose", "contact_kind");
CREATE UNIQUE INDEX "dl_line_scope_gates_binding_key"
  ON "dl_line_scope_gates"("tenant_id", "id", "channel_account_id", "sender_identity_id", "purpose", "contact_kind");

ALTER TABLE "dl_line_scope_gates"
  ADD CONSTRAINT "dl_line_scope_gates_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 3. dl_line_credential_refs (reference + metadata; ไม่มี secret value) ─────

CREATE TABLE "dl_line_credential_refs" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "channel_account_id" TEXT NOT NULL,
  "credential_kind" "DlLineCredentialKind" NOT NULL,
  "version" INTEGER NOT NULL,
  "status" "DlLineCredentialStatus" NOT NULL DEFAULT 'CANDIDATE',
  -- ชื่อ service/account ใน macOS Keychain — ชื่อของ secret ไม่ใช่ตัว secret
  "keychain_service" TEXT NOT NULL,
  "keychain_account" TEXT NOT NULL,
  "fingerprint" CHAR(64) NOT NULL,
  "key_id" TEXT,
  "issued_at" TIMESTAMP(3) NOT NULL,
  "expires_at" TIMESTAMP(3),
  "verified_at" TIMESTAMP(3),
  "activated_at" TIMESTAMP(3),
  "retired_at" TIMESTAMP(3),
  "revoked_at" TIMESTAMP(3),
  "long_lived_exception_ref" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_line_credential_refs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_credential_refs_values_check" CHECK (
    "version" >= 1
    AND "channel_account_id" ~ '^[0-9]{1,32}$'
    AND "keychain_service" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
    AND "keychain_account" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
    AND "fingerprint" ~ '^[a-f0-9]{64}$'
    AND ("key_id" IS NULL OR "key_id" ~ '^[A-Za-z0-9._:-]{1,128}$')
    AND ("expires_at" IS NULL OR "expires_at" > "issued_at")
  ),
  -- v2.1 ต้องหมดอายุภายใน 30 วัน; long-lived ต้องมี test-only exception ที่อนุมัติแล้ว (#358 §G)
  CONSTRAINT "dl_line_credential_refs_kind_check" CHECK (
    ("credential_kind" <> 'CHANNEL_ACCESS_TOKEN_V2_1'
      OR ("expires_at" IS NOT NULL AND "expires_at" <= "issued_at" + INTERVAL '30 days'))
    AND (("credential_kind" = 'CHANNEL_ACCESS_TOKEN_LONG_LIVED') = ("long_lived_exception_ref" IS NOT NULL))
    AND ("long_lived_exception_ref" IS NULL OR "long_lived_exception_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$')
  ),
  CONSTRAINT "dl_line_credential_refs_status_check" CHECK (
    ("status" = 'CANDIDATE' OR "status" = 'REVOKED' OR ("verified_at" IS NOT NULL AND "activated_at" IS NOT NULL))
    AND ("status" <> 'RETIRED' OR "retired_at" IS NOT NULL)
    AND (("status" = 'REVOKED') = ("revoked_at" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "dl_line_credential_refs_tenant_id_key" ON "dl_line_credential_refs"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_credential_refs_binding_key" ON "dl_line_credential_refs"("tenant_id", "id", "version");
CREATE UNIQUE INDEX "dl_line_credential_refs_version_key"
  ON "dl_line_credential_refs"("tenant_id", "channel_account_id", "credential_kind", "version");
-- access token (v2.1 หรือ long-lived) ACTIVE ได้ทีละหนึ่ง และ channel secret ACTIVE ได้ทีละหนึ่ง
-- rotation จึงสลับ version แบบ atomic ไม่มีช่วงที่ worker เห็นสองค่า (#358 §G)
CREATE UNIQUE INDEX "dl_line_credential_refs_one_active_key"
  ON "dl_line_credential_refs"("tenant_id", "channel_account_id", ("credential_kind" = 'CHANNEL_SECRET'))
  WHERE "status" = 'ACTIVE';

ALTER TABLE "dl_line_credential_refs"
  ADD CONSTRAINT "dl_line_credential_refs_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 4. dl_line_allowlist_entries (exact tuple รวม recipient + content) ────────

CREATE TABLE "dl_line_allowlist_entries" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "gate_id" UUID NOT NULL,
  "channel_account_id" TEXT NOT NULL,
  "sender_identity_id" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "contact_kind" TEXT NOT NULL,
  -- fingerprint สำหรับเทียบ + ref ไปยัง encrypted operational store; raw LINE user ID ไม่อยู่ที่นี่
  "recipient_fingerprint" CHAR(64) NOT NULL,
  "recipient_protected_ref" TEXT NOT NULL,
  "content_ref" TEXT NOT NULL,
  "content_digest" CHAR(64) NOT NULL,
  "config_digest" CHAR(64) NOT NULL,
  "valid_from" TIMESTAMP(3) NOT NULL,
  "valid_until" TIMESTAMP(3) NOT NULL,
  "approval_audit_ref" TEXT NOT NULL,
  "revoked_at" TIMESTAMP(3),
  "revocation_code" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_line_allowlist_entries_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_allowlist_entries_values_check" CHECK (
    "recipient_fingerprint" ~ '^[a-f0-9]{64}$'
    AND "content_digest" ~ '^[a-f0-9]{64}$'
    AND "config_digest" ~ '^[a-f0-9]{64}$'
    AND "recipient_protected_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    AND "recipient_protected_ref" !~ 'U[0-9a-f]{32}'
    AND "content_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,255}$'
    AND "approval_audit_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    AND "valid_until" > "valid_from"
  ),
  CONSTRAINT "dl_line_allowlist_entries_revocation_check" CHECK (
    ("revoked_at" IS NULL) = ("revocation_code" IS NULL)
    AND ("revocation_code" IS NULL OR "revocation_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  )
);

CREATE UNIQUE INDEX "dl_line_allowlist_entries_tenant_id_key" ON "dl_line_allowlist_entries"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_allowlist_entries_binding_key" ON "dl_line_allowlist_entries"("tenant_id", "id", "gate_id");
CREATE UNIQUE INDEX "dl_line_allowlist_entries_tuple_key"
  ON "dl_line_allowlist_entries"("tenant_id", "gate_id", "recipient_fingerprint", "content_digest", "config_digest");

ALTER TABLE "dl_line_allowlist_entries"
  ADD CONSTRAINT "dl_line_allowlist_entries_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
-- tuple ของ allowlist ต้องตรงกับ scope ของ gate ทุกคอลัมน์ ไม่ใช่แค่ gate_id
ALTER TABLE "dl_line_allowlist_entries"
  ADD CONSTRAINT "dl_line_allowlist_entries_gate_fkey" FOREIGN KEY ("tenant_id", "gate_id", "channel_account_id", "sender_identity_id", "purpose", "contact_kind")
  REFERENCES "dl_line_scope_gates"("tenant_id", "id", "channel_account_id", "sender_identity_id", "purpose", "contact_kind") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── 5. dl_line_run_authorizations (immutable proposal + one-shot consume) ─────

CREATE TABLE "dl_line_run_authorizations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "gate_id" UUID NOT NULL,
  "allowlist_entry_id" UUID NOT NULL,
  "credential_ref_id" UUID NOT NULL,
  "credential_version" INTEGER NOT NULL,
  "proposal_digest" CHAR(64) NOT NULL,
  "config_digest" CHAR(64) NOT NULL,
  "profile" TEXT NOT NULL DEFAULT 'S2_LINE_LOCAL_PILOT_V1',
  "cap_logical_deliveries" INTEGER NOT NULL,
  "cap_provider_attempts" INTEGER NOT NULL,
  "proposed_by" TEXT NOT NULL,
  "proposed_at" TIMESTAMP(3) NOT NULL,
  "tenant_admin_approved_by" TEXT,
  "tenant_admin_approved_at" TIMESTAMP(3),
  "compliance_approved_by" TEXT,
  "compliance_approved_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3) NOT NULL,
  "state" "DlLineRunAuthorizationState" NOT NULL DEFAULT 'PROPOSED',
  "consumed_at" TIMESTAMP(3),
  "consumed_delivery_id" TEXT,
  -- ผูกกับ outbox ของ LINE เท่านั้น; authorization ถูก consume โดยแถว TEST_ADAPTER ไม่ได้
  "adapter" "DlDeliveryAdapter" NOT NULL DEFAULT 'LINE_MESSAGING_API',
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_line_run_authorizations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_run_authorizations_values_check" CHECK (
    "proposal_digest" ~ '^[a-f0-9]{64}$'
    AND "config_digest" ~ '^[a-f0-9]{64}$'
    AND "profile" = 'S2_LINE_LOCAL_PILOT_V1'
    AND "adapter" = 'LINE_MESSAGING_API'
    AND "proposed_by" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
    AND ("tenant_admin_approved_by" IS NULL OR "tenant_admin_approved_by" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$')
    AND ("compliance_approved_by" IS NULL OR "compliance_approved_by" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$')
  ),
  -- caps ลดได้แต่เกิน profile ไม่ได้; TTL สูงสุด 30 นาที (#358 §C)
  CONSTRAINT "dl_line_run_authorizations_caps_check" CHECK (
    "cap_logical_deliveries" = 1
    AND "cap_provider_attempts" BETWEEN 1 AND 4
    AND "expires_at" > "proposed_at"
    AND "expires_at" <= "proposed_at" + INTERVAL '30 minutes'
  ),
  CONSTRAINT "dl_line_run_authorizations_approval_check" CHECK (
    ("tenant_admin_approved_by" IS NULL) = ("tenant_admin_approved_at" IS NULL)
    AND ("compliance_approved_by" IS NULL) = ("compliance_approved_at" IS NULL)
    AND ("state" NOT IN ('APPROVED', 'CONSUMED')
      OR ("tenant_admin_approved_at" IS NOT NULL AND "compliance_approved_at" IS NOT NULL))
  ),
  CONSTRAINT "dl_line_run_authorizations_consume_check" CHECK (
    (("state" = 'CONSUMED') = ("consumed_at" IS NOT NULL))
    AND (("consumed_at" IS NULL) = ("consumed_delivery_id" IS NULL))
    AND ("consumed_at" IS NULL OR "consumed_at" <= "expires_at")
    AND (("state" IN ('EXPIRED', 'REVOKED')) = ("closed_at" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "dl_line_run_authorizations_tenant_id_key" ON "dl_line_run_authorizations"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_run_authorizations_proposal_key" ON "dl_line_run_authorizations"("tenant_id", "proposal_digest");
-- authorization หนึ่งใบใช้กับ delivery เดียว และ delivery หนึ่งใบใช้ authorization ได้ใบเดียว
CREATE UNIQUE INDEX "dl_line_run_authorizations_consumed_delivery_key"
  ON "dl_line_run_authorizations"("tenant_id", "consumed_delivery_id")
  WHERE "consumed_delivery_id" IS NOT NULL;
CREATE INDEX "dl_line_run_authorizations_gate_state_idx"
  ON "dl_line_run_authorizations"("tenant_id", "gate_id", "state", "expires_at");

ALTER TABLE "dl_line_run_authorizations"
  ADD CONSTRAINT "dl_line_run_authorizations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dl_line_run_authorizations"
  ADD CONSTRAINT "dl_line_run_authorizations_allowlist_fkey" FOREIGN KEY ("tenant_id", "allowlist_entry_id", "gate_id")
  REFERENCES "dl_line_allowlist_entries"("tenant_id", "id", "gate_id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "dl_line_run_authorizations"
  ADD CONSTRAINT "dl_line_run_authorizations_credential_fkey" FOREIGN KEY ("tenant_id", "credential_ref_id", "credential_version")
  REFERENCES "dl_line_credential_refs"("tenant_id", "id", "version") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "dl_line_run_authorizations"
  ADD CONSTRAINT "dl_line_run_authorizations_delivery_fkey" FOREIGN KEY ("tenant_id", "consumed_delivery_id", "adapter")
  REFERENCES "dl_outbox_entries"("tenant_id", "delivery_id", "adapter") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── 6. dl_line_cap_ledger (atomic cap reservations) ───────────────────────────

-- หนึ่งแถวต่อหนึ่งหน่วยที่จอง; นับจากแถวที่ยังไม่ RELEASED ภายใต้ row lock ของ gate
-- ไม่มี counter แยกที่ restart/worker ชนกันแล้วหายได้ (#358 §C)
CREATE TABLE "dl_line_cap_ledger" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "gate_id" UUID NOT NULL,
  "run_authorization_id" UUID NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "adapter" "DlDeliveryAdapter" NOT NULL DEFAULT 'LINE_MESSAGING_API',
  "cap_kind" "DlLineCapKind" NOT NULL,
  -- 0 = ไม่ใช่ provider attempt; 1..4 = attempt ที่จอง
  "attempt_no" INTEGER NOT NULL DEFAULT 0,
  "recipient_fingerprint" CHAR(64) NOT NULL,
  "state" "DlLineCapReservationState" NOT NULL DEFAULT 'RESERVED',
  "reserved_at" TIMESTAMP(3) NOT NULL,
  "settled_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_line_cap_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_cap_ledger_values_check" CHECK (
    "adapter" = 'LINE_MESSAGING_API'
    AND "recipient_fingerprint" ~ '^[a-f0-9]{64}$'
    AND (("cap_kind" = 'PROVIDER_ATTEMPT') = ("attempt_no" BETWEEN 1 AND 4))
    AND ("cap_kind" = 'PROVIDER_ATTEMPT' OR "attempt_no" = 0)
    AND (("state" = 'RESERVED') = ("settled_at" IS NULL))
    AND ("settled_at" IS NULL OR "settled_at" >= "reserved_at")
  )
);

CREATE UNIQUE INDEX "dl_line_cap_ledger_tenant_id_key" ON "dl_line_cap_ledger"("tenant_id", "id");
-- reservation ซ้ำของหน่วยเดิมเป็น replay ไม่ใช่การจองเพิ่ม
CREATE UNIQUE INDEX "dl_line_cap_ledger_reservation_key"
  ON "dl_line_cap_ledger"("tenant_id", "delivery_id", "cap_kind", "attempt_no");
CREATE INDEX "dl_line_cap_ledger_gate_window_idx"
  ON "dl_line_cap_ledger"("tenant_id", "gate_id", "cap_kind", "state", "reserved_at");
CREATE INDEX "dl_line_cap_ledger_recipient_window_idx"
  ON "dl_line_cap_ledger"("tenant_id", "gate_id", "recipient_fingerprint", "reserved_at");

ALTER TABLE "dl_line_cap_ledger"
  ADD CONSTRAINT "dl_line_cap_ledger_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dl_line_cap_ledger"
  ADD CONSTRAINT "dl_line_cap_ledger_gate_fkey" FOREIGN KEY ("tenant_id", "gate_id")
  REFERENCES "dl_line_scope_gates"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "dl_line_cap_ledger"
  ADD CONSTRAINT "dl_line_cap_ledger_run_authorization_fkey" FOREIGN KEY ("tenant_id", "run_authorization_id")
  REFERENCES "dl_line_run_authorizations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "dl_line_cap_ledger"
  ADD CONSTRAINT "dl_line_cap_ledger_delivery_fkey" FOREIGN KEY ("tenant_id", "delivery_id", "adapter")
  REFERENCES "dl_outbox_entries"("tenant_id", "delivery_id", "adapter") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── 7. dl_line_webhook_inbox (หนึ่งแถวต่อ webhook event หลัง signature ผ่าน) ──

CREATE TABLE "dl_line_webhook_inbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "channel_account_id" TEXT NOT NULL,
  "webhook_event_id" TEXT NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  -- ชนิดจาก provider ไม่ปิดชุด: unknown type ต้องเก็บ/ack ได้แล้ว quarantine (#359 §D)
  "event_type" TEXT NOT NULL,
  "delivery_mode" TEXT NOT NULL,
  "is_redelivery" BOOLEAN NOT NULL,
  "provider_timestamp" TIMESTAMP(3) NOT NULL,
  "received_at" TIMESTAMP(3) NOT NULL,
  -- ref ไปยัง encrypted operational payload; body/userId/replyToken ไม่อยู่ในตารางนี้
  "protected_payload_ref" TEXT NOT NULL,
  "state" "DlLineWebhookInboxState" NOT NULL DEFAULT 'PENDING',
  "outcome_code" "DlLineWebhookCode",
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_line_webhook_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_webhook_inbox_values_check" CHECK (
    "channel_account_id" ~ '^[0-9]{1,32}$'
    AND "webhook_event_id" ~ '^[A-Za-z0-9_-]{1,128}$'
    AND "payload_hash" ~ '^[a-f0-9]{64}$'
    AND "event_type" ~ '^[A-Za-z][A-Za-z0-9_]{0,63}$'
    AND "delivery_mode" IN ('active', 'standby')
    AND "protected_payload_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    AND "protected_payload_ref" !~ 'U[0-9a-f]{32}'
    AND "attempts" >= 0
    AND ("lease_owner" IS NULL OR "lease_owner" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
  ),
  CONSTRAINT "dl_line_webhook_inbox_state_check" CHECK (
    (("state" = 'PROCESSING') = ("lease_owner" IS NOT NULL AND "lease_expires_at" IS NOT NULL))
    AND (("state" IN ('COMPLETED', 'QUARANTINED')) = ("completed_at" IS NOT NULL))
    AND ("state" NOT IN ('COMPLETED', 'QUARANTINED') OR "outcome_code" IS NOT NULL)
    AND ("state" <> 'COMPLETED' OR "outcome_code" = 'WEBHOOK_ACCEPTED')
    AND ("state" <> 'QUARANTINED' OR "outcome_code" IN (
      'WEBHOOK_DESTINATION_MISMATCH', 'WEBHOOK_SCHEMA_INVALID', 'WEBHOOK_IDEMPOTENCY_CONFLICT',
      'WEBHOOK_UNSUPPORTED_EVENT_TYPE', 'WEBHOOK_QUARANTINED'
    ))
  )
);

CREATE UNIQUE INDEX "dl_line_webhook_inbox_tenant_id_key" ON "dl_line_webhook_inbox"("tenant_id", "id");
-- ingress dedupe (#359 §E ชั้นที่ 1)
CREATE UNIQUE INDEX "dl_line_webhook_inbox_event_key"
  ON "dl_line_webhook_inbox"("tenant_id", "channel_account_id", "webhook_event_id");
CREATE INDEX "dl_line_webhook_inbox_claim_idx"
  ON "dl_line_webhook_inbox"("tenant_id", "state", "lease_expires_at", "received_at");

ALTER TABLE "dl_line_webhook_inbox"
  ADD CONSTRAINT "dl_line_webhook_inbox_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 8. dl_line_touch_correlations (pending/bound/quarantined response binding) ─

CREATE TABLE "dl_line_touch_correlations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "inbox_entry_id" UUID NOT NULL,
  "evidence_kind" "CgTouchEvidenceKind" NOT NULL,
  -- opaque ref ของ (channelAccountId, webhookEventId) — ตัวเดียวกับที่ cg_touches ใช้ (#361 §C)
  "response_evidence_ref" TEXT NOT NULL,
  -- sentMessages.id ที่ถูก quote (provider ID ไม่ใช่ PII); postback ไม่มีค่านี้
  "quoted_message_id" TEXT,
  "provider_timestamp" TIMESTAMP(3) NOT NULL,
  "window_expires_at" TIMESTAMP(3) NOT NULL,
  "state" "DlLineTouchCorrelationState" NOT NULL DEFAULT 'PENDING',
  -- delivery ยังไม่รู้ได้ถ้า webhook มาก่อน acceptance commit (#361 §F)
  "delivery_id" TEXT,
  "adapter" "DlDeliveryAdapter" NOT NULL DEFAULT 'LINE_MESSAGING_API',
  "attempt_id" UUID,
  "quarantine_code" TEXT,
  "resolved_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_line_touch_correlations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_touch_correlations_values_check" CHECK (
    "adapter" = 'LINE_MESSAGING_API'
    AND "response_evidence_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    AND "response_evidence_ref" !~ 'U[0-9a-f]{32}'
    AND ("quoted_message_id" IS NULL OR "quoted_message_id" ~ '^[0-9]{1,32}$')
    AND (("evidence_kind" = 'USER_QUOTED_RESPONSE') = ("quoted_message_id" IS NOT NULL))
    AND "window_expires_at" > "provider_timestamp"
    AND "window_expires_at" <= "provider_timestamp" + INTERVAL '24 hours'
    AND ("quarantine_code" IS NULL OR "quarantine_code" ~ '^[A-Z][A-Z0-9_]{2,63}$')
  ),
  CONSTRAINT "dl_line_touch_correlations_state_check" CHECK (
    ("state" <> 'PENDING' OR ("attempt_id" IS NULL AND "resolved_at" IS NULL AND "quarantine_code" IS NULL))
    AND ("state" <> 'BOUND' OR ("delivery_id" IS NOT NULL AND "attempt_id" IS NOT NULL
      AND "resolved_at" IS NOT NULL AND "quarantine_code" IS NULL))
    AND ("state" <> 'QUARANTINED' OR ("attempt_id" IS NULL AND "resolved_at" IS NOT NULL
      AND "quarantine_code" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "dl_line_touch_correlations_tenant_id_key" ON "dl_line_touch_correlations"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_touch_correlations_evidence_key"
  ON "dl_line_touch_correlations"("tenant_id", "response_evidence_ref");
CREATE UNIQUE INDEX "dl_line_touch_correlations_inbox_key"
  ON "dl_line_touch_correlations"("tenant_id", "inbox_entry_id");
-- Successful Touch ได้หนึ่งครั้งต่อ Attempt (สอดคล้อง cg_touches (tenant_id, attempt_id))
CREATE UNIQUE INDEX "dl_line_touch_correlations_bound_attempt_key"
  ON "dl_line_touch_correlations"("tenant_id", "attempt_id")
  WHERE "state" = 'BOUND';
CREATE INDEX "dl_line_touch_correlations_pending_idx"
  ON "dl_line_touch_correlations"("tenant_id", "state", "window_expires_at");

ALTER TABLE "dl_line_touch_correlations"
  ADD CONSTRAINT "dl_line_touch_correlations_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dl_line_touch_correlations"
  ADD CONSTRAINT "dl_line_touch_correlations_inbox_fkey" FOREIGN KEY ("tenant_id", "inbox_entry_id")
  REFERENCES "dl_line_webhook_inbox"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "dl_line_touch_correlations"
  ADD CONSTRAINT "dl_line_touch_correlations_delivery_fkey" FOREIGN KEY ("tenant_id", "delivery_id", "adapter")
  REFERENCES "dl_outbox_entries"("tenant_id", "delivery_id", "adapter") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "dl_line_touch_correlations"
  ADD CONSTRAINT "dl_line_touch_correlations_attempt_fkey" FOREIGN KEY ("tenant_id", "attempt_id")
  REFERENCES "cg_attempts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ── 9. dl_line_audit_events (append-only gate/kill/credential/provider/webhook) ─

CREATE TABLE "dl_line_audit_events" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  -- stable ต่อการกระทำเดิม: retry ของ transition เดียวกันเขียนซ้ำไม่ได้
  "event_id" TEXT NOT NULL,
  "category" "DlLineAuditCategory" NOT NULL,
  "code" TEXT NOT NULL,
  "actor_kind" "DlLineActorKind" NOT NULL,
  "actor_ref" TEXT NOT NULL,
  "subject_id" UUID,
  "delivery_id" TEXT,
  "evidence_digest" CHAR(64),
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_line_audit_events_pkey" PRIMARY KEY ("id"),
  -- control flow ใช้ machine code เท่านั้น; ไม่มีช่อง free-form ที่ PII จะหลุดเข้าไปได้
  CONSTRAINT "dl_line_audit_events_values_check" CHECK (
    "event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,255}$'
    AND "code" ~ '^[A-Z][A-Z0-9_]{2,63}$'
    AND "actor_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
    AND "actor_ref" !~ 'U[0-9a-f]{32}'
    AND ("delivery_id" IS NULL OR "delivery_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$')
    AND ("evidence_digest" IS NULL OR "evidence_digest" ~ '^[a-f0-9]{64}$')
  )
);

CREATE UNIQUE INDEX "dl_line_audit_events_event_key" ON "dl_line_audit_events"("tenant_id", "event_id");
CREATE INDEX "dl_line_audit_events_category_idx" ON "dl_line_audit_events"("tenant_id", "category", "occurred_at");

ALTER TABLE "dl_line_audit_events"
  ADD CONSTRAINT "dl_line_audit_events_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── 10. cg_touches: response evidence (Governance-owned, additive) ────────────

-- Touch ของ S1/TEST_ADAPTER เดิมไม่มี evidence ทั้งคู่; Touch ของ LINE ต้องมีทั้งคู่ (S2.2 เป็นผู้เขียน)
ALTER TABLE "cg_touches" ADD COLUMN "evidence_kind" "CgTouchEvidenceKind";
ALTER TABLE "cg_touches" ADD COLUMN "response_evidence_ref" TEXT;
ALTER TABLE "cg_touches" ADD CONSTRAINT "cg_touches_response_evidence_check" CHECK (
  ("evidence_kind" IS NULL) = ("response_evidence_ref" IS NULL)
);
CREATE UNIQUE INDEX "cg_touches_tenant_response_evidence_key"
  ON "cg_touches"("tenant_id", "response_evidence_ref")
  WHERE "response_evidence_ref" IS NOT NULL;

-- ── Triggers ─────────────────────────────────────────────────────────────────

-- append-only: receipt/audit ที่แก้ย้อนหลังได้ก็ไม่ใช่หลักฐาน
CREATE FUNCTION dl_line_reject_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DL_LINE_APPEND_ONLY: % เป็น append-only', TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_provider_submission_attempts_immutable" BEFORE UPDATE ON "dl_provider_submission_attempts"
  FOR EACH ROW EXECUTE FUNCTION dl_line_reject_update();
CREATE TRIGGER "dl_line_audit_events_immutable" BEFORE UPDATE ON "dl_line_audit_events"
  FOR EACH ROW EXECUTE FUNCTION dl_line_reject_update();

-- attempt เรียงต่อกัน, จบแล้วห้ามต่อ และ retry ต้องเริ่มก่อนครบ 24 ชม. จาก request แรก (#357 §3)
-- ที่นี่เป็นด่านสุดท้าย: key เดิมหลัง 24 ชม. LINE อาจมองเป็น request ใหม่แล้วส่งซ้ำ
CREATE FUNCTION dl_line_guard_attempt_insert() RETURNS trigger AS $$
DECLARE
  first_started TIMESTAMP(3);
BEGIN
  IF NEW.attempt_no > 1 AND NOT EXISTS (
    SELECT 1 FROM "dl_provider_submission_attempts" AS previous
    WHERE previous.tenant_id = NEW.tenant_id
      AND previous.delivery_id = NEW.delivery_id
      AND previous.attempt_no = NEW.attempt_no - 1
  ) THEN
    RAISE EXCEPTION 'DL_LINE_ATTEMPT_SEQUENCE: dl_provider_submission_attempts ต้องเรียง attempt_no ต่อกัน';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "dl_provider_submission_attempts" AS previous
    WHERE previous.tenant_id = NEW.tenant_id
      AND previous.delivery_id = NEW.delivery_id
      AND previous.outcome_class <> 'RETRYABLE_UNKNOWN'
  ) THEN
    RAISE EXCEPTION 'DL_LINE_ATTEMPT_AFTER_OUTCOME: dl_provider_submission_attempts ของ delivery ที่ได้ผลแล้วห้ามมี attempt เพิ่ม';
  END IF;
  SELECT min(previous.started_at) INTO first_started
  FROM "dl_provider_submission_attempts" AS previous
  WHERE previous.tenant_id = NEW.tenant_id AND previous.delivery_id = NEW.delivery_id;
  IF first_started IS NOT NULL AND NEW.outcome_class <> 'QUARANTINED'
     AND NEW.started_at >= first_started + INTERVAL '24 hours' THEN
    RAISE EXCEPTION 'DL_LINE_RETRY_WINDOW_EXPIRED: dl_provider_submission_attempts retry เกิน 24 ชม. ด้วย key เดิมไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_provider_submission_attempts_sequence_guard" BEFORE INSERT ON "dl_provider_submission_attempts"
  FOR EACH ROW EXECUTE FUNCTION dl_line_guard_attempt_insert();

-- gate: scope คงที่, version +1, business state เลื่อนขึ้นทีละขั้น (ลดลงได้ทันที)
-- kill latch ยกได้เฉพาะพร้อม approval ref ใหม่และกลับไป DISABLED (#358 §E/§F)
CREATE FUNCTION dl_line_guard_scope_gate() RETURNS trigger AS $$
DECLARE
  stages TEXT[] := ARRAY['DISABLED','DRY_RUN','PROVIDER_CONFORMANCE','CAPPED_PILOT'];
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.profile, NEW.channel, NEW.channel_account_id,
      NEW.sender_identity_id, NEW.purpose, NEW.contact_kind, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.profile, OLD.channel, OLD.channel_account_id,
      OLD.sender_identity_id, OLD.purpose, OLD.contact_kind, OLD.created_at) THEN
    RAISE EXCEPTION 'DL_LINE_GATE_SCOPE_IMMUTABLE: dl_line_scope_gates แก้ scope ไม่ได้';
  END IF;
  IF NEW.version <> OLD.version + 1 THEN
    RAISE EXCEPTION 'DL_LINE_GATE_VERSION_CAS: dl_line_scope_gates version ต้องเพิ่มทีละหนึ่ง (CAS)';
  END IF;
  IF array_position(stages, NEW.business_state::text) > array_position(stages, OLD.business_state::text) + 1 THEN
    RAISE EXCEPTION 'DL_LINE_GATE_STEP: dl_line_scope_gates เลื่อน business state ทีละขั้นเท่านั้น';
  END IF;
  IF (OLD.killed OR NEW.killed)
     AND array_position(stages, NEW.business_state::text) > array_position(stages, OLD.business_state::text) THEN
    RAISE EXCEPTION 'DL_LINE_GATE_KILLED_ADVANCE: dl_line_scope_gates ที่ถูก kill เลื่อน state ขึ้นไม่ได้';
  END IF;
  IF OLD.killed AND NOT NEW.killed THEN
    IF NEW.kill_cleared_ref IS NULL OR NEW.kill_cleared_ref IS NOT DISTINCT FROM OLD.kill_cleared_ref THEN
      RAISE EXCEPTION 'DL_LINE_GATE_KILL_CLEAR_REF: dl_line_scope_gates ยก kill ต้องมี approval ref ใหม่';
    END IF;
    IF NEW.business_state <> 'DISABLED' THEN
      RAISE EXCEPTION 'DL_LINE_GATE_KILL_CLEAR_STATE: dl_line_scope_gates ยก kill แล้วต้องเริ่มที่ DISABLED';
    END IF;
  ELSIF NEW.kill_cleared_ref IS DISTINCT FROM OLD.kill_cleared_ref THEN
    RAISE EXCEPTION 'DL_LINE_GATE_KILL_CLEARED_REF_IMMUTABLE: dl_line_scope_gates แก้ kill_cleared_ref ได้เฉพาะตอนยก kill';
  END IF;
  IF OLD.killed AND NEW.killed AND (NEW.kill_reason, NEW.killed_at) IS DISTINCT FROM (OLD.kill_reason, OLD.killed_at) THEN
    RAISE EXCEPTION 'DL_LINE_GATE_KILL_REASON_IMMUTABLE: dl_line_scope_gates แก้เหตุผล kill ที่ latch แล้วไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_line_scope_gates_guard" BEFORE UPDATE ON "dl_line_scope_gates"
  FOR EACH ROW EXECUTE FUNCTION dl_line_guard_scope_gate();

-- allowlist: tuple คงที่ทั้งแถว เปลี่ยนได้อย่างเดียวคือ revoke ครั้งเดียว
CREATE FUNCTION dl_line_guard_allowlist() RETURNS trigger AS $$
BEGIN
  IF OLD.revoked_at IS NOT NULL THEN
    RAISE EXCEPTION 'DL_LINE_ALLOWLIST_REVOKED: dl_line_allowlist_entries ที่ revoke แล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.gate_id, NEW.channel_account_id, NEW.sender_identity_id,
      NEW.purpose, NEW.contact_kind, NEW.recipient_fingerprint, NEW.recipient_protected_ref,
      NEW.content_ref, NEW.content_digest, NEW.config_digest, NEW.valid_from, NEW.valid_until,
      NEW.approval_audit_ref, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.gate_id, OLD.channel_account_id, OLD.sender_identity_id,
      OLD.purpose, OLD.contact_kind, OLD.recipient_fingerprint, OLD.recipient_protected_ref,
      OLD.content_ref, OLD.content_digest, OLD.config_digest, OLD.valid_from, OLD.valid_until,
      OLD.approval_audit_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'DL_LINE_ALLOWLIST_IMMUTABLE: dl_line_allowlist_entries แก้ tuple ที่อนุมัติแล้วไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_line_allowlist_entries_guard" BEFORE UPDATE ON "dl_line_allowlist_entries"
  FOR EACH ROW EXECUTE FUNCTION dl_line_guard_allowlist();

-- run authorization: proposal pin ทั้งหมด, approval ใส่ได้ครั้งเดียวตอน PROPOSED
-- consume ได้ครั้งเดียวจาก APPROVED และ terminal แก้ไม่ได้ (#358 §E)
CREATE FUNCTION dl_line_guard_run_authorization() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('CONSUMED', 'EXPIRED', 'REVOKED') THEN
    RAISE EXCEPTION 'DL_LINE_RUN_CLOSED: dl_line_run_authorizations ที่ปิดแล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.gate_id, NEW.allowlist_entry_id, NEW.credential_ref_id,
      NEW.credential_version, NEW.proposal_digest, NEW.config_digest, NEW.profile,
      NEW.cap_logical_deliveries, NEW.cap_provider_attempts, NEW.proposed_by, NEW.proposed_at,
      NEW.expires_at, NEW.adapter, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.gate_id, OLD.allowlist_entry_id, OLD.credential_ref_id,
      OLD.credential_version, OLD.proposal_digest, OLD.config_digest, OLD.profile,
      OLD.cap_logical_deliveries, OLD.cap_provider_attempts, OLD.proposed_by, OLD.proposed_at,
      OLD.expires_at, OLD.adapter, OLD.created_at) THEN
    RAISE EXCEPTION 'DL_LINE_RUN_PINNED: dl_line_run_authorizations แก้ proposal ที่ pin ไว้ไม่ได้';
  END IF;
  IF (OLD.tenant_admin_approved_by IS NOT NULL
        AND (NEW.tenant_admin_approved_by, NEW.tenant_admin_approved_at)
            IS DISTINCT FROM (OLD.tenant_admin_approved_by, OLD.tenant_admin_approved_at))
     OR (OLD.compliance_approved_by IS NOT NULL
        AND (NEW.compliance_approved_by, NEW.compliance_approved_at)
            IS DISTINCT FROM (OLD.compliance_approved_by, OLD.compliance_approved_at)) THEN
    RAISE EXCEPTION 'DL_LINE_RUN_APPROVAL_IMMUTABLE: dl_line_run_authorizations แก้ approval ที่ให้แล้วไม่ได้';
  END IF;
  IF OLD.state = 'APPROVED'
     AND ((NEW.tenant_admin_approved_by, NEW.compliance_approved_by)
          IS DISTINCT FROM (OLD.tenant_admin_approved_by, OLD.compliance_approved_by)) THEN
    RAISE EXCEPTION 'DL_LINE_RUN_APPROVAL_AFTER_APPROVED: dl_line_run_authorizations เพิ่ม approval หลัง APPROVED ไม่ได้';
  END IF;
  IF NOT (
    NEW.state = OLD.state
    OR (OLD.state = 'PROPOSED' AND NEW.state IN ('APPROVED', 'EXPIRED', 'REVOKED'))
    OR (OLD.state = 'APPROVED' AND NEW.state IN ('CONSUMED', 'EXPIRED', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'DL_LINE_RUN_TRANSITION: dl_line_run_authorizations เปลี่ยน state % -> % ไม่ได้', OLD.state, NEW.state;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_line_run_authorizations_guard" BEFORE UPDATE ON "dl_line_run_authorizations"
  FOR EACH ROW EXECUTE FUNCTION dl_line_guard_run_authorization();

-- cap reservation: identity คงที่ และ RESERVED -> COMMITTED|RELEASED ครั้งเดียว
-- COMMITTED คือข้าม barrier แล้ว คืนหน่วยไม่ได้ (#362 §11)
CREATE FUNCTION dl_line_guard_cap_ledger() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'RESERVED' THEN
    RAISE EXCEPTION 'DL_LINE_CAP_SETTLED: dl_line_cap_ledger ที่ settle แล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.gate_id, NEW.run_authorization_id, NEW.delivery_id,
      NEW.adapter, NEW.cap_kind, NEW.attempt_no, NEW.recipient_fingerprint, NEW.reserved_at,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.gate_id, OLD.run_authorization_id, OLD.delivery_id,
      OLD.adapter, OLD.cap_kind, OLD.attempt_no, OLD.recipient_fingerprint, OLD.reserved_at,
      OLD.created_at) THEN
    RAISE EXCEPTION 'DL_LINE_CAP_IDENTITY_IMMUTABLE: dl_line_cap_ledger แก้ reservation identity ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_line_cap_ledger_guard" BEFORE UPDATE ON "dl_line_cap_ledger"
  FOR EACH ROW EXECUTE FUNCTION dl_line_guard_cap_ledger();

-- credential: metadata ที่ pin ไว้คงที่ และ status เดินหน้าอย่างเดียว
CREATE FUNCTION dl_line_guard_credential_ref() RETURNS trigger AS $$
DECLARE
  statuses TEXT[] := ARRAY['CANDIDATE','ACTIVE','RETIRED','REVOKED'];
BEGIN
  IF (NEW.id, NEW.tenant_id, NEW.channel_account_id, NEW.credential_kind, NEW.version,
      NEW.keychain_service, NEW.keychain_account, NEW.fingerprint, NEW.key_id, NEW.issued_at,
      NEW.expires_at, NEW.long_lived_exception_ref, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.channel_account_id, OLD.credential_kind, OLD.version,
      OLD.keychain_service, OLD.keychain_account, OLD.fingerprint, OLD.key_id, OLD.issued_at,
      OLD.expires_at, OLD.long_lived_exception_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'DL_LINE_CREDENTIAL_PINNED: dl_line_credential_refs แก้ metadata ที่ pin ไว้ไม่ได้';
  END IF;
  IF OLD.status = 'REVOKED' THEN
    RAISE EXCEPTION 'DL_LINE_CREDENTIAL_REVOKED: dl_line_credential_refs ที่ revoke แล้วแก้ไม่ได้';
  END IF;
  IF array_position(statuses, NEW.status::text) < array_position(statuses, OLD.status::text) THEN
    RAISE EXCEPTION 'DL_LINE_CREDENTIAL_STATUS_BACKWARD: dl_line_credential_refs ย้อน status ไม่ได้';
  END IF;
  IF OLD.status <> 'CANDIDATE' AND NEW.verified_at IS DISTINCT FROM OLD.verified_at THEN
    RAISE EXCEPTION 'DL_LINE_CREDENTIAL_VERIFIED_IMMUTABLE: dl_line_credential_refs แก้ verified_at หลัง activate ไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_line_credential_refs_guard" BEFORE UPDATE ON "dl_line_credential_refs"
  FOR EACH ROW EXECUTE FUNCTION dl_line_guard_credential_ref();

-- inbox: event ที่รับไว้คงที่ทั้งแถว; terminal แก้ไม่ได้และ attempts ไม่ถอยหลัง
CREATE FUNCTION dl_line_guard_webhook_inbox() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('COMPLETED', 'QUARANTINED') THEN
    RAISE EXCEPTION 'DL_LINE_INBOX_TERMINAL: dl_line_webhook_inbox ที่จบแล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.channel_account_id, NEW.webhook_event_id, NEW.payload_hash,
      NEW.event_type, NEW.delivery_mode, NEW.is_redelivery, NEW.provider_timestamp,
      NEW.received_at, NEW.protected_payload_ref, NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.channel_account_id, OLD.webhook_event_id, OLD.payload_hash,
      OLD.event_type, OLD.delivery_mode, OLD.is_redelivery, OLD.provider_timestamp,
      OLD.received_at, OLD.protected_payload_ref, OLD.created_at) THEN
    RAISE EXCEPTION 'DL_LINE_INBOX_EVENT_IMMUTABLE: dl_line_webhook_inbox แก้ event ที่รับไว้ไม่ได้';
  END IF;
  IF NEW.attempts < OLD.attempts THEN
    RAISE EXCEPTION 'DL_LINE_INBOX_ATTEMPTS_BACKWARD: dl_line_webhook_inbox attempts ถอยหลังไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_line_webhook_inbox_guard" BEFORE UPDATE ON "dl_line_webhook_inbox"
  FOR EACH ROW EXECUTE FUNCTION dl_line_guard_webhook_inbox();

-- correlation: evidence คงที่, PENDING -> BOUND|QUARANTINED ครั้งเดียว
CREATE FUNCTION dl_line_guard_touch_correlation() RETURNS trigger AS $$
BEGIN
  IF OLD.state <> 'PENDING' THEN
    RAISE EXCEPTION 'DL_LINE_CORRELATION_RESOLVED: dl_line_touch_correlations ที่ resolve แล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.inbox_entry_id, NEW.evidence_kind, NEW.response_evidence_ref,
      NEW.quoted_message_id, NEW.provider_timestamp, NEW.window_expires_at, NEW.adapter,
      NEW.created_at)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.inbox_entry_id, OLD.evidence_kind, OLD.response_evidence_ref,
      OLD.quoted_message_id, OLD.provider_timestamp, OLD.window_expires_at, OLD.adapter,
      OLD.created_at) THEN
    RAISE EXCEPTION 'DL_LINE_CORRELATION_EVIDENCE_IMMUTABLE: dl_line_touch_correlations แก้ evidence ไม่ได้';
  END IF;
  IF OLD.delivery_id IS NOT NULL AND NEW.delivery_id IS DISTINCT FROM OLD.delivery_id THEN
    RAISE EXCEPTION 'DL_LINE_CORRELATION_DELIVERY_IMMUTABLE: dl_line_touch_correlations เปลี่ยน delivery ที่ผูกแล้วไม่ได้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "dl_line_touch_correlations_guard" BEFORE UPDATE ON "dl_line_touch_correlations"
  FOR EACH ROW EXECUTE FUNCTION dl_line_guard_touch_correlation();

-- ── RLS ──────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'dl_provider_submission_attempts', 'dl_line_scope_gates', 'dl_line_credential_refs',
    'dl_line_allowlist_entries', 'dl_line_run_authorizations', 'dl_line_cap_ledger',
    'dl_line_webhook_inbox', 'dl_line_touch_correlations', 'dl_line_audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)',
      t
    );
  END LOOP;
END $$;

-- ── Grants ───────────────────────────────────────────────────────────────────
-- REVOKE ทีละตารางเพื่อให้ rls.integration อ่านจาก migration แล้วตรวจกับ bootstrap ได้ครบ

-- state ที่เดินได้แต่ห้ามหาย: ลบ gate ที่ถูก kill = สร้างใหม่เป็น DISABLED เท่ากับยก kill switch
GRANT SELECT, INSERT, UPDATE ON "dl_line_scope_gates" TO dcontact_app;
REVOKE DELETE ON "dl_line_scope_gates" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "dl_line_credential_refs" TO dcontact_app;
REVOKE DELETE ON "dl_line_credential_refs" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "dl_line_allowlist_entries" TO dcontact_app;
REVOKE DELETE ON "dl_line_allowlist_entries" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "dl_line_run_authorizations" TO dcontact_app;
REVOKE DELETE ON "dl_line_run_authorizations" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "dl_line_cap_ledger" TO dcontact_app;
REVOKE DELETE ON "dl_line_cap_ledger" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "dl_line_webhook_inbox" TO dcontact_app;
REVOKE DELETE ON "dl_line_webhook_inbox" FROM dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "dl_line_touch_correlations" TO dcontact_app;
REVOKE DELETE ON "dl_line_touch_correlations" FROM dcontact_app;

-- หลักฐาน append-only
GRANT SELECT, INSERT ON "dl_provider_submission_attempts" TO dcontact_app;
REVOKE UPDATE, DELETE ON "dl_provider_submission_attempts" FROM dcontact_app;
GRANT SELECT, INSERT ON "dl_line_audit_events" TO dcontact_app;
REVOKE UPDATE, DELETE ON "dl_line_audit_events" FROM dcontact_app;
