-- E1.14 (#488): audit ของ click-to-call จาก host ทุกครั้ง พร้อม decisionId และผลตัดสิน (E1.6 #462 ข้อ 3, 5)
-- ไม่เก็บเบอร์ปลายทาง (PII) — เก็บเฉพาะ contact ที่ resolve ได้และผลของ Contact Governance
CREATE TABLE "dphone_click_to_call_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "lease_id" UUID NOT NULL,
    "host_origin" TEXT NOT NULL,
    "request_id" TEXT NOT NULL,
    "action_key" TEXT NOT NULL,
    "contact_id" UUID,
    "decision_id" TEXT,
    "decision" TEXT,
    "reason_code" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "dphone_click_to_call_audit_events_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "dphone_click_to_call_audit_events" ADD CONSTRAINT "dphone_click_to_call_audit_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "dphone_click_to_call_audit_events" ADD CONSTRAINT "dphone_click_to_call_audit_events_values_check" CHECK (
  ("decision" IS NULL OR "decision" IN ('ALLOW', 'BLOCK', 'DEFER', 'REVIEW'))
  AND "outcome" IN ('blocked', 'unavailable', 'rate_limited')
  AND length("request_id") BETWEEN 1 AND 128
);
CREATE INDEX "dphone_click_to_call_audit_events_tenant_idx"
  ON "dphone_click_to_call_audit_events" ("tenant_id", "occurred_at");
