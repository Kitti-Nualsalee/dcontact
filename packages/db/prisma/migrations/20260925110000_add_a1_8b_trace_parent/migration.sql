-- A1.8b (#473): W3C traceparent ของ request/command ที่ Platform API รับ — worker ต่อ span เป็น trace เดียวกัน
-- แม้ restart หรือเปลี่ยน worker (nullable: tracing ปิดอยู่ หรือ request เก่ากว่านี้)
ALTER TABLE "pf_provisioning_requests" ADD COLUMN "trace_parent" TEXT;
ALTER TABLE "pf_provisioning_requests" ADD CONSTRAINT "pf_provisioning_requests_trace_parent_check"
  CHECK ("trace_parent" IS NULL OR "trace_parent" ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
ALTER TABLE "pf_operator_commands" ADD COLUMN "trace_parent" TEXT;
ALTER TABLE "pf_operator_commands" ADD CONSTRAINT "pf_operator_commands_trace_parent_check"
  CHECK ("trace_parent" IS NULL OR "trace_parent" ~ '^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$');
