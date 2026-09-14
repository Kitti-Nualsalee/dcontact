-- CG4.8 (#191): downstream consumer compatibility สำหรับ CG4 exception/policy/kill events
--
-- expand-only: เพิ่ม enum value, nullable column และเปลี่ยน unique index เป็นแบบ partial
-- ไม่มีการลบหรือแก้ประวัติเดิม

-- 1. event ที่ version+digest ซ้ำกับที่ apply แล้วแต่ eventId ต่าง ต้องถูกบันทึกเป็น completion
--    ของ eventId นั้นได้ (idempotency store ตรวจ inbox ด้วย eventId) โดยไม่ขยับ cursor
ALTER TYPE "JrGovernanceConsumerState" ADD VALUE IF NOT EXISTS 'DUPLICATE';
ALTER TYPE "ObGovernanceConsumerState" ADD VALUE IF NOT EXISTS 'DUPLICATE';

-- 2. controlled reason ของ quarantine/unsupported contract (OB01) ไม่มี payload หรือ PII
ALTER TABLE "jr_governance_consumer_inbox" ADD COLUMN "reason_code" TEXT;
ALTER TABLE "ob_governance_consumer_inbox" ADD COLUMN "reason_code" TEXT;

-- 3. unique เดิมรวม payload_hash ทำให้ duplicate ที่ hash ตรงกันบันทึกไม่ได้; cursor ต้อง unique
--    ต่อ version เฉพาะแถวที่ขยับ cursor จริง (APPLIED|NO_OP) ซึ่งเข้มกว่าเดิม
DROP INDEX "jr_governance_consumer_inbox_aggregate_version_hash_key";
CREATE UNIQUE INDEX "jr_governance_consumer_inbox_cursor_version_key"
  ON "jr_governance_consumer_inbox"("consumer", "tenant_id", "aggregate_type", "aggregate_id", "aggregate_version")
  WHERE "state" IN ('APPLIED', 'NO_OP');
DROP INDEX "ob_governance_consumer_inbox_aggregate_version_hash_key";
CREATE UNIQUE INDEX "ob_governance_consumer_inbox_cursor_version_key"
  ON "ob_governance_consumer_inbox"("consumer", "tenant_id", "aggregate_type", "aggregate_id", "aggregate_version")
  WHERE "state" IN ('APPLIED', 'NO_OP');

-- 4. acknowledgement ส่ง applied state digest ของ Governance (#179 §4 "ack applied version/digest")
ALTER TABLE "jr_governance_acknowledgement_outbox" ADD COLUMN "applied_state_digest" CHAR(64);
ALTER TABLE "jr_governance_acknowledgement_outbox" ADD CONSTRAINT "jr_governance_ack_outbox_state_digest_check"
  CHECK ("applied_state_digest" IS NULL OR "applied_state_digest" ~ '^[a-f0-9]{64}$');
ALTER TABLE "ob_governance_acknowledgement_outbox" ADD COLUMN "applied_state_digest" CHAR(64);
ALTER TABLE "ob_governance_acknowledgement_outbox" ADD CONSTRAINT "ob_governance_ack_outbox_state_digest_check"
  CHECK ("applied_state_digest" IS NULL OR "applied_state_digest" ~ '^[a-f0-9]{64}$');
ALTER TABLE "cg_consumer_acknowledgements" ADD COLUMN "applied_state_digest" CHAR(64);
ALTER TABLE "cg_consumer_acknowledgements" ADD CONSTRAINT "cg_consumer_acknowledgements_state_digest_check"
  CHECK ("applied_state_digest" IS NULL OR "applied_state_digest" ~ '^[a-f0-9]{64}$');
