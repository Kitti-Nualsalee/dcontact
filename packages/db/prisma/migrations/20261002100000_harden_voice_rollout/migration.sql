-- E1.18 (#520): แยก cap ระดับ tenant/agent และทำ kill latch เป็น one-way authority.
ALTER TABLE "dl_voice_scope_gates"
  ADD COLUMN "agent_cap_per_minute" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "agent_cap_per_day" INTEGER NOT NULL DEFAULT 10;

ALTER TABLE "dl_voice_scope_gates"
  DROP CONSTRAINT "dl_voice_scope_gates_shape";

ALTER TABLE "dl_voice_scope_gates"
  ADD CONSTRAINT "dl_voice_scope_gates_shape" CHECK (
    "telephony_node_id" ~ '^[A-Za-z0-9_.-]{1,128}$'
    AND "cap_per_minute" > 0
    AND "cap_per_day" > 0
    AND "agent_cap_per_minute" > 0
    AND "agent_cap_per_day" > 0
  );

ALTER TABLE "dl_voice_cap_ledger"
  ADD COLUMN "agent_user_id" UUID;

UPDATE "dl_voice_cap_ledger" AS ledger
SET "agent_user_id" = voice."agent_user_id"
FROM "dl_voice_originates" AS voice
WHERE voice."tenant_id" = ledger."tenant_id"
  AND voice."delivery_id" = ledger."delivery_id";

ALTER TABLE "dl_voice_cap_ledger"
  ALTER COLUMN "agent_user_id" SET NOT NULL;

CREATE INDEX "dl_voice_cap_ledger_agent_window_idx"
  ON "dl_voice_cap_ledger"("tenant_id", "gate_id", "agent_user_id", "reserved_at");

CREATE FUNCTION prevent_voice_gate_unkill() RETURNS trigger AS $$
BEGIN
  IF OLD."killed" AND NOT NEW."killed" THEN
    RAISE EXCEPTION 'voice rollout kill latch cannot be cleared';
  END IF;
  IF OLD."killed" AND NEW."technical_switch_on" THEN
    RAISE EXCEPTION 'killed voice rollout scope cannot be enabled';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER dl_voice_scope_gates_kill_latch
BEFORE UPDATE ON "dl_voice_scope_gates"
FOR EACH ROW EXECUTE FUNCTION prevent_voice_gate_unkill();
