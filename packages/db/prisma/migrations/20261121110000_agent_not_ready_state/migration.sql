-- #937 Agent ตั้ง Not Ready (BREAK + เหตุผล) และ Offline เอง, เหตุผลใน state log, สถานะหลังจบงาน
-- เหตุผลอ้างรายการของ tenant (#936) — ใช้ครั้งแรกแล้วตั้ง first_used_at ให้เหตุผลนั้นลบไม่ได้
ALTER TABLE agent_state_logs ADD COLUMN reason_code text;
ALTER TABLE agent_state_logs ADD CONSTRAINT agent_state_logs_reason_code_break
  CHECK (reason_code IS NULL OR state = 'BREAK');
ALTER TABLE agent_state_logs ADD CONSTRAINT agent_state_logs_reason_code_fkey
  FOREIGN KEY (tenant_id, reason_code) REFERENCES tenant_not_ready_reasons(tenant_id, code);

-- สถานะที่ Agent ขอไว้ใช้ตอนปิดงานหลังสาย (ไม่มีแถว = Ready) ใช้ครั้งเดียวแล้วลบ
CREATE TABLE agent_after_work_states (
  tenant_id uuid NOT NULL,
  user_id uuid NOT NULL,
  state "AgentStateType" NOT NULL CHECK (state = 'BREAK'),
  reason_code text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, user_id),
  FOREIGN KEY (tenant_id, user_id) REFERENCES users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, reason_code) REFERENCES tenant_not_ready_reasons(tenant_id, code)
);
ALTER TABLE agent_after_work_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_after_work_states FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_after_work_states
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);

CREATE FUNCTION dc_not_ready_reason_mark_used() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
  IF NEW.reason_code IS NOT NULL THEN
    UPDATE tenant_not_ready_reasons SET first_used_at = now()
      WHERE tenant_id = NEW.tenant_id AND code = NEW.reason_code AND first_used_at IS NULL;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER agent_state_log_reason_used AFTER INSERT ON agent_state_logs
  FOR EACH ROW WHEN (NEW.reason_code IS NOT NULL) EXECUTE FUNCTION dc_not_ready_reason_mark_used();
