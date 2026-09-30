-- E1.18 (#520): `dialing` ถูกบันทึกได้ต่อเมื่อ Voice Delivery commit durable queue แล้ว
ALTER TABLE "dphone_click_to_call_audit_events"
  DROP CONSTRAINT "dphone_click_to_call_audit_events_values_check";

ALTER TABLE "dphone_click_to_call_audit_events"
  ADD CONSTRAINT "dphone_click_to_call_audit_events_values_check" CHECK (
    ("decision" IS NULL OR "decision" IN ('ALLOW', 'BLOCK', 'DEFER', 'REVIEW'))
    AND "outcome" IN ('blocked', 'unavailable', 'rate_limited', 'dialing')
    AND length("request_id") BETWEEN 1 AND 128
  );
