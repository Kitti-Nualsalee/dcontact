-- #567 (T3/T6): profile `S2_LINE_TEAM_TRIAL_V1` — ช่วงทีมทดสอบส่ง-รับ LINE บน UAT 30 วัน
--
-- run authorization ของ trial: หนึ่งแถวต่อผู้รับใน allowlist (เสนอ/อนุมัติเป็นชุดเดียวด้วย `trial_ref`), ใช้ได้หลาย
-- delivery จนหมดอายุ (state คง APPROVED ไม่ CONSUMED) และนับ cap ผ่าน `dl_line_cap_ledger` เดิม
--
-- CHECK constraint ถูก "แทนที่" ด้วยชื่อเดิม (ข้อยกเว้นของ migration guard ที่ review แล้วใน #567):
-- กิ่ง `S2_LINE_LOCAL_PILOT_V1` เหมือนเดิมทุกข้อ และเพิ่มกิ่งของ trial เท่านั้น — ไม่มีข้อมูลหาย
-- code เดิมทำงานกับ schema นี้ได้เพราะแถวของ S2 ต้องมีคอลัมน์ใหม่เป็น NULL ทั้งหมด

ALTER TABLE "dl_line_run_authorizations"
  ADD COLUMN "cap_recipient_per_24h" INTEGER,
  ADD COLUMN "cap_per_24h" INTEGER,
  ADD COLUMN "cap_lifetime" INTEGER,
  ADD COLUMN "trial_ref" TEXT,
  ADD COLUMN "contact_id" UUID,
  ADD COLUMN "identity_id" UUID;

ALTER TABLE "dl_line_run_authorizations" DROP CONSTRAINT "dl_line_run_authorizations_values_check";
ALTER TABLE "dl_line_run_authorizations" ADD CONSTRAINT "dl_line_run_authorizations_values_check" CHECK (
  "proposal_digest" ~ '^[a-f0-9]{64}$'
  AND "config_digest" ~ '^[a-f0-9]{64}$'
  AND "adapter" = 'LINE_MESSAGING_API'
  AND "proposed_by" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
  AND ("tenant_admin_approved_by" IS NULL OR "tenant_admin_approved_by" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$')
  AND ("compliance_approved_by" IS NULL OR "compliance_approved_by" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$')
  AND (
    (
      "profile" = 'S2_LINE_LOCAL_PILOT_V1'
      AND "trial_ref" IS NULL
      AND "contact_id" IS NULL
      AND "identity_id" IS NULL
    )
    OR (
      "profile" = 'S2_LINE_TEAM_TRIAL_V1'
      AND "trial_ref" ~ '^trial-[0-9a-f-]{36}$'
      AND "contact_id" IS NOT NULL
      -- trial ไม่ใช่ one-shot: ไม่มีการ consume
      AND "state" <> 'CONSUMED'
    )
  )
);

ALTER TABLE "dl_line_run_authorizations" DROP CONSTRAINT "dl_line_run_authorizations_caps_check";
ALTER TABLE "dl_line_run_authorizations" ADD CONSTRAINT "dl_line_run_authorizations_caps_check" CHECK (
  "expires_at" > "proposed_at"
  AND "cap_provider_attempts" BETWEEN 1 AND 4
  AND (
    -- S2 (#358 §C): ลดได้แต่เกิน profile ไม่ได้; TTL สูงสุด 30 นาที
    (
      "profile" = 'S2_LINE_LOCAL_PILOT_V1'
      AND "cap_logical_deliveries" = 1
      AND "expires_at" <= "proposed_at" + INTERVAL '30 minutes'
      AND "cap_recipient_per_24h" IS NULL
      AND "cap_per_24h" IS NULL
      AND "cap_lifetime" IS NULL
    )
    -- trial (#567, amendment #358 2026-10-01): ≤20/ผู้รับ/24 ชม., ≤100/24 ชม., ≤3,000 ตลอด, TTL ≤30 วัน
    OR (
      "profile" = 'S2_LINE_TEAM_TRIAL_V1'
      AND "cap_logical_deliveries" BETWEEN 1 AND 600
      AND "cap_recipient_per_24h" BETWEEN 1 AND 20
      AND "cap_per_24h" BETWEEN 1 AND 100
      AND "cap_lifetime" BETWEEN 1 AND 3000
      AND "expires_at" <= "proposed_at" + INTERVAL '30 days'
    )
  )
);

-- proposal pin รวมคอลัมน์ของ trial ด้วย — แก้ cap/ผู้รับ/contact หลังเสนอไม่ได้
CREATE OR REPLACE FUNCTION dl_line_guard_run_authorization() RETURNS trigger AS $$
BEGIN
  IF OLD.state IN ('CONSUMED', 'EXPIRED', 'REVOKED') THEN
    RAISE EXCEPTION 'DL_LINE_RUN_CLOSED: dl_line_run_authorizations ที่ปิดแล้วแก้ไม่ได้';
  END IF;
  IF (NEW.id, NEW.tenant_id, NEW.gate_id, NEW.allowlist_entry_id, NEW.credential_ref_id,
      NEW.credential_version, NEW.proposal_digest, NEW.config_digest, NEW.profile,
      NEW.cap_logical_deliveries, NEW.cap_provider_attempts, NEW.proposed_by, NEW.proposed_at,
      NEW.expires_at, NEW.adapter, NEW.created_at, NEW.cap_recipient_per_24h, NEW.cap_per_24h,
      NEW.cap_lifetime, NEW.trial_ref, NEW.contact_id, NEW.identity_id)
     IS DISTINCT FROM
     (OLD.id, OLD.tenant_id, OLD.gate_id, OLD.allowlist_entry_id, OLD.credential_ref_id,
      OLD.credential_version, OLD.proposal_digest, OLD.config_digest, OLD.profile,
      OLD.cap_logical_deliveries, OLD.cap_provider_attempts, OLD.proposed_by, OLD.proposed_at,
      OLD.expires_at, OLD.adapter, OLD.created_at, OLD.cap_recipient_per_24h, OLD.cap_per_24h,
      OLD.cap_lifetime, OLD.trial_ref, OLD.contact_id, OLD.identity_id) THEN
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

CREATE INDEX "dl_line_run_authorizations_trial_idx"
  ON "dl_line_run_authorizations"("tenant_id", "trial_ref")
  WHERE "trial_ref" IS NOT NULL;

-- ── การตอบกลับของ trial (T1/T2) ───────────────────────────────────────────────
-- หนึ่งแถวต่อการกดตอบกลับ: ผูก delivery ↔ authorization ↔ ข้อความขาเข้าที่ตอบ และเก็บ text แบบเข้ารหัส
-- (ด้วย payload key เดียวกับ webhook) เพื่อให้ retry เป็น request เดิม byte ต่อ byte หลัง barrier
-- append-only: แก้ text/ผู้รับหลังบันทึกไม่ได้
CREATE TABLE "dl_line_trial_sends" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "run_authorization_id" UUID NOT NULL,
  "inbox_entry_id" UUID NOT NULL,
  "delivery_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "content_digest" CHAR(64) NOT NULL,
  "key_ref" TEXT NOT NULL,
  "iv" BYTEA NOT NULL,
  "auth_tag" BYTEA NOT NULL,
  "ciphertext" BYTEA NOT NULL,
  "actor_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_line_trial_sends_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dl_line_trial_sends_values_check" CHECK (
    "delivery_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$'
    AND "idempotency_key" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'
    AND "content_digest" ~ '^[a-f0-9]{64}$'
    AND "key_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$'
    AND "actor_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:@-]{0,127}$'
    AND octet_length("iv") = 12
    AND octet_length("auth_tag") = 16
    -- text ≤500 ตัวอักษร UTF-8 ≤ 2,000 bytes
    AND octet_length("ciphertext") BETWEEN 1 AND 2000
  )
);

CREATE UNIQUE INDEX "dl_line_trial_sends_tenant_id_key" ON "dl_line_trial_sends"("tenant_id", "id");
CREATE UNIQUE INDEX "dl_line_trial_sends_idempotency_key" ON "dl_line_trial_sends"("tenant_id", "idempotency_key");
CREATE UNIQUE INDEX "dl_line_trial_sends_delivery_key" ON "dl_line_trial_sends"("tenant_id", "delivery_id");
CREATE INDEX "dl_line_trial_sends_run_idx" ON "dl_line_trial_sends"("tenant_id", "run_authorization_id", "created_at");

ALTER TABLE "dl_line_trial_sends"
  ADD CONSTRAINT "dl_line_trial_sends_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dl_line_trial_sends"
  ADD CONSTRAINT "dl_line_trial_sends_run_fkey" FOREIGN KEY ("tenant_id", "run_authorization_id")
  REFERENCES "dl_line_run_authorizations"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "dl_line_trial_sends"
  ADD CONSTRAINT "dl_line_trial_sends_inbox_fkey" FOREIGN KEY ("tenant_id", "inbox_entry_id")
  REFERENCES "dl_line_webhook_inbox"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE TRIGGER "dl_line_trial_sends_immutable" BEFORE UPDATE ON "dl_line_trial_sends"
  FOR EACH ROW EXECUTE FUNCTION dl_line_reject_update();
