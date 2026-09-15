-- J3.5 (#216): durable persistence ของ Journey สำหรับ segment membership
--
-- ตารางชุดนี้เป็นของ J3 เองทั้งหมด แยกขาดจาก jr_event_inbox ของ J1 และ jr_outcome_* ของ J2
-- ตาม stop condition ที่ห้าม repurpose ตารางเดิม และไม่มี shared write ไปยัง c360_* ใด ๆ

CREATE TYPE "JrSegmentReceiptState" AS ENUM (
  'RECEIVED',
  'WAITING_FOR_GAP',
  'READY',
  'PROCESSING',
  'APPLIED',
  'IGNORED_SUPERSEDED',
  'REVIEW',
  'QUARANTINED'
);

CREATE TYPE "JrSegmentRefilterState" AS ENUM (
  'PENDING',
  'REVALIDATING',
  'NO_OP',
  'CANCELLED',
  'DEFERRED',
  'HELD',
  'RECONCILING'
);

CREATE TYPE "JrSegmentOutboxState" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'FAILED');

-- additive เท่านั้น: ค่าเดิมของสอง enum นี้ยังหมายถึง J2 receipt/action เหมือนเดิมทุกประการ
-- ค่าใหม่ไม่ถูกใช้ใน DDL ของ migration นี้ จึงอยู่ทรานแซกชันเดียวกับ ADD VALUE ได้
ALTER TYPE "JrRecoveryTargetKind" ADD VALUE IF NOT EXISTS 'SEGMENT_RECEIPT';
ALTER TYPE "JrRecoveryTargetKind" ADD VALUE IF NOT EXISTS 'SEGMENT_REFILTER';
ALTER TYPE "JrRecoveryOperation" ADD VALUE IF NOT EXISTS 'REVALIDATE';

CREATE TABLE "jr_segment_receipts" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "event_id" TEXT NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "membership_revision" INTEGER NOT NULL,
  "change_kind" TEXT NOT NULL,
  "entry_id" TEXT,
  "supersedes_revision" INTEGER,
  "segment_definition_version" INTEGER NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "evidence_ref" TEXT,
  "state" "JrSegmentReceiptState" NOT NULL DEFAULT 'RECEIVED',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "review_reason_code" TEXT,
  "last_error" TEXT,
  "correlation_id" TEXT NOT NULL,
  "causation_id" TEXT,
  "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "applied_at" TIMESTAMP(3),
  CONSTRAINT "jr_segment_receipts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jr_segment_heads" (
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "last_applied_revision" INTEGER NOT NULL DEFAULT 0,
  "last_applied_receipt_id" UUID,
  "terminal_entry_id" TEXT,
  "terminal_revision" INTEGER,
  "terminal_reason_code" TEXT,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "jr_segment_heads_pkey" PRIMARY KEY ("tenant_id", "contact_id", "segment_id")
);

CREATE TABLE "jr_segment_enrollment_intents" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "journey_id" TEXT NOT NULL,
  "journey_version" INTEGER NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "entry_id" TEXT NOT NULL,
  "receipt_id" UUID NOT NULL,
  "reason_membership_revision" INTEGER NOT NULL,
  "reason_definition_version" INTEGER NOT NULL,
  "reason_evidence_ref" TEXT,
  "reason_digest" CHAR(64) NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_segment_enrollment_intents_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jr_segment_refilter_cursors" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "membership_revision" INTEGER NOT NULL,
  "receipt_id" UUID NOT NULL,
  "state" "JrSegmentRefilterState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease_owner" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reason_code" TEXT,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "settled_at" TIMESTAMP(3),
  CONSTRAINT "jr_segment_refilter_cursors_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jr_segment_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "receipt_id" UUID NOT NULL,
  "event_id" UUID NOT NULL,
  "event_type" TEXT NOT NULL,
  "ordering_key" TEXT NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "payload" JSONB NOT NULL,
  "state" "JrSegmentOutboxState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_error" TEXT,
  "correlation_id" TEXT NOT NULL,
  "causation_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  CONSTRAINT "jr_segment_outbox_pkey" PRIMARY KEY ("id")
);

-- transport identity แยกจาก logical identity: ส่งซ้ำจาก broker ชนที่คู่ (source, event_id)
-- ส่วน revision เดิมที่มาคนละ event ชนที่คู่ (contact, segment, revision) ทั้งสองทางต้องไม่
-- สร้างแถวที่สอง — นี่คือเหตุผลที่ต้องมี unique สองชุด ไม่ใช่ชุดเดียว
CREATE UNIQUE INDEX "jr_segment_receipts_tenant_id_key" ON "jr_segment_receipts" ("tenant_id", "id");
CREATE UNIQUE INDEX "jr_segment_receipts_transport_key" ON "jr_segment_receipts" ("tenant_id", "source", "event_id");
CREATE UNIQUE INDEX "jr_segment_receipts_logical_key" ON "jr_segment_receipts" ("tenant_id", "contact_id", "segment_id", "membership_revision");
CREATE INDEX "jr_segment_receipts_claim_idx" ON "jr_segment_receipts" ("tenant_id", "state", "available_at");
CREATE INDEX "jr_segment_receipts_stream_idx" ON "jr_segment_receipts" ("tenant_id", "contact_id", "segment_id", "membership_revision");

CREATE INDEX "jr_segment_heads_segment_idx" ON "jr_segment_heads" ("tenant_id", "segment_id");

CREATE UNIQUE INDEX "jr_segment_enrollment_intents_key" ON "jr_segment_enrollment_intents" ("tenant_id", "journey_id", "journey_version", "contact_id", "segment_id", "entry_id");
CREATE INDEX "jr_segment_enrollment_intents_receipt_idx" ON "jr_segment_enrollment_intents" ("tenant_id", "receipt_id");

CREATE UNIQUE INDEX "jr_segment_refilter_cursors_key" ON "jr_segment_refilter_cursors" ("tenant_id", "contact_id", "segment_id", "membership_revision");
CREATE INDEX "jr_segment_refilter_cursors_claim_idx" ON "jr_segment_refilter_cursors" ("tenant_id", "state", "available_at");

CREATE UNIQUE INDEX "jr_segment_outbox_event_key" ON "jr_segment_outbox" ("tenant_id", "event_id");
CREATE INDEX "jr_segment_outbox_claim_idx" ON "jr_segment_outbox" ("tenant_id", "state", "available_at");

ALTER TABLE "jr_segment_receipts"
  ADD CONSTRAINT "jr_segment_receipts_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_segment_receipts_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_segment_heads"
  ADD CONSTRAINT "jr_segment_heads_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_segment_heads_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_segment_enrollment_intents"
  ADD CONSTRAINT "jr_segment_enrollment_intents_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_segment_enrollment_intents_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_segment_enrollment_intents_receipt_fkey"
    FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "jr_segment_receipts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_segment_refilter_cursors"
  ADD CONSTRAINT "jr_segment_refilter_cursors_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_segment_refilter_cursors_contact_fkey"
    FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_segment_refilter_cursors_receipt_fkey"
    FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "jr_segment_receipts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_segment_outbox"
  ADD CONSTRAINT "jr_segment_outbox_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "jr_segment_outbox_receipt_fkey"
    FOREIGN KEY ("tenant_id", "receipt_id") REFERENCES "jr_segment_receipts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- invariant ที่ต้องจริงแม้มีคนเขียนข้าม repository เข้ามาตรง ๆ

-- revision เป็นลำดับที่เริ่มจาก 1 เสมอ และ supersedes ต้องชี้ไปข้างหลังจริง
ALTER TABLE "jr_segment_receipts"
  ADD CONSTRAINT "jr_segment_receipts_revision_check"
    CHECK ("membership_revision" >= 1),
  ADD CONSTRAINT "jr_segment_receipts_supersedes_check"
    CHECK ("supersedes_revision" IS NULL OR "supersedes_revision" < "membership_revision"),
  -- lease ต้องมาเป็นคู่: owner ที่ไม่มีวันหมดอายุคือ lease ที่ค้างตลอดกาลเมื่อ worker ตาย
  ADD CONSTRAINT "jr_segment_receipts_lease_check"
    CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
  -- PROCESSING เท่านั้นที่ถือ lease ได้ และ APPLIED เท่านั้นที่มีเวลา applied
  ADD CONSTRAINT "jr_segment_receipts_state_check"
    CHECK (
      ("state" = 'PROCESSING' OR "lease_owner" IS NULL)
      AND ("state" = 'APPLIED') = ("applied_at" IS NOT NULL)
      AND ("state" <> 'REVIEW' OR "review_reason_code" IS NOT NULL)
    );

-- head ขยับขึ้นอย่างเดียวและ terminal ต้องมาครบชุด (first-terminal protection)
ALTER TABLE "jr_segment_heads"
  ADD CONSTRAINT "jr_segment_heads_revision_check"
    CHECK ("last_applied_revision" >= 0),
  ADD CONSTRAINT "jr_segment_heads_terminal_check"
    CHECK (
      ("terminal_entry_id" IS NULL AND "terminal_revision" IS NULL AND "terminal_reason_code" IS NULL)
      OR (
        "terminal_entry_id" IS NOT NULL
        AND "terminal_revision" IS NOT NULL
        AND "terminal_reason_code" IS NOT NULL
        AND "terminal_revision" <= "last_applied_revision"
      )
    );

ALTER TABLE "jr_segment_refilter_cursors"
  ADD CONSTRAINT "jr_segment_refilter_cursors_revision_check"
    CHECK ("membership_revision" >= 1),
  ADD CONSTRAINT "jr_segment_refilter_cursors_lease_check"
    CHECK (("lease_owner" IS NULL) = ("lease_expires_at" IS NULL)),
  -- settled_at ต้องมีเฉพาะ state ที่จบแล้วจริง ๆ ไม่ใช่ตอนยังทำงานอยู่
  ADD CONSTRAINT "jr_segment_refilter_cursors_settled_check"
    CHECK (("state" IN ('NO_OP', 'CANCELLED')) = ("settled_at" IS NOT NULL));

ALTER TABLE "jr_segment_outbox"
  ADD CONSTRAINT "jr_segment_outbox_state_check"
    CHECK (("state" = 'SENT') = ("published_at" IS NOT NULL));

-- enrollment intent เป็นหลักฐานว่า "ทำไม contact นี้ถึงเข้า journey นี้" — แก้ย้อนหลังไม่ได้
-- ปิด UPDATE ที่ระดับฐานข้อมูล ไม่ใช่แค่ใน repository เพราะเหตุผลที่แก้ได้ก็ไม่ต่างกับไม่มีเหตุผล
--
-- trigger คุมเฉพาะ UPDATE ส่วน DELETE คุมด้วย grant (application role ไม่มีสิทธิ์ลบ) แบบเดียว
-- กับ c360_membership_change_immutable — ตารางที่ลบไม่ได้แม้แต่โดย owner จะทำให้ retention
-- ทำงานไม่ได้เลย ซึ่งขัดกับ retention-safe deletion boundaries ที่ #216 กำหนดไว้เอง
CREATE FUNCTION jr_reject_segment_intent_update() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'jr_segment_enrollment_intents เป็น append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "jr_segment_enrollment_intents_immutable"
BEFORE UPDATE ON "jr_segment_enrollment_intents"
FOR EACH ROW EXECUTE FUNCTION jr_reject_segment_intent_update();

ALTER TABLE "jr_segment_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_segment_receipts"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_segment_heads" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_segment_heads"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_segment_enrollment_intents" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_segment_enrollment_intents"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_segment_refilter_cursors" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_segment_refilter_cursors"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_segment_outbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_segment_outbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON "jr_segment_receipts" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "jr_segment_heads" TO dcontact_app;
GRANT SELECT, INSERT ON "jr_segment_enrollment_intents" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "jr_segment_refilter_cursors" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON "jr_segment_outbox" TO dcontact_app;
