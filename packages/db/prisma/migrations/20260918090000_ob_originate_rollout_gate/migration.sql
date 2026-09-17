-- J2.9 (#137): rollout gate ของ Dialer originate barrier ต้องแชร์ข้ามทุก instance และอยู่รอดหลัง
-- restart — kill ที่สั่งบน instance หนึ่งต้องหยุด originate ทุก instance ทันที
--
-- DISABLED → SHADOW_RECEIPT → OWNER_CONFORMANCE → SCOPED_INTERNAL_ENABLED เดินหน้าทีละขั้น ทุก state
-- ไม่มี provider I/O; kill ชนะทุก state และยกเลิกไม่ได้ (J2 ไม่มีสิทธิ์ยก kill switch ตาม #124)

CREATE TYPE "ObOriginateRolloutState" AS ENUM (
  'DISABLED',
  'SHADOW_RECEIPT',
  'OWNER_CONFORMANCE',
  'SCOPED_INTERNAL_ENABLED'
);
CREATE TYPE "ObOriginateRolloutScopeKind" AS ENUM ('CAMPAIGN', 'CALLBACK_QUEUE');

CREATE TABLE "ob_originate_rollout_state" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "state" "ObOriginateRolloutState" NOT NULL DEFAULT 'DISABLED',
  "pending_state" "ObOriginateRolloutState",
  "pending_by_ref" TEXT,
  "killed" BOOLEAN NOT NULL DEFAULT false,
  "kill_trigger" TEXT,
  "killed_at" TIMESTAMP(3),
  "version" INTEGER NOT NULL DEFAULT 1,
  "updated_by_ref" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ob_originate_rollout_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "ob_originate_rollout_state_kill_check" CHECK (
    ("killed" = false AND "kill_trigger" IS NULL AND "killed_at" IS NULL)
    OR ("killed" = true AND "kill_trigger" IS NOT NULL AND "killed_at" IS NOT NULL
        AND "pending_state" IS NULL)
  ),
  CONSTRAINT "ob_originate_rollout_state_pending_check" CHECK (
    ("pending_state" IS NULL) = ("pending_by_ref" IS NULL)
  )
);

CREATE TABLE "ob_originate_rollout_scopes" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "scope_kind" "ObOriginateRolloutScopeKind" NOT NULL,
  "scope_ref" UUID NOT NULL,
  "added_by_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ob_originate_rollout_scopes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ob_originate_rollout_audit" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "actor_role" TEXT NOT NULL,
  "actor_ref" TEXT NOT NULL,
  "detail" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ob_originate_rollout_audit_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ob_originate_rollout_state_tenant_id_key"
  ON "ob_originate_rollout_state" ("tenant_id");
CREATE UNIQUE INDEX "ob_originate_rollout_scopes_tenant_id_scope_kind_scope_ref_key"
  ON "ob_originate_rollout_scopes" ("tenant_id", "scope_kind", "scope_ref");
CREATE INDEX "ob_originate_rollout_audit_tenant_id_occurred_at_idx"
  ON "ob_originate_rollout_audit" ("tenant_id", "occurred_at");

ALTER TABLE "ob_originate_rollout_state"
  ADD CONSTRAINT "ob_originate_rollout_state_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ob_originate_rollout_scopes"
  ADD CONSTRAINT "ob_originate_rollout_scopes_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ob_originate_rollout_audit"
  ADD CONSTRAINT "ob_originate_rollout_audit_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- guard ระดับฐานข้อมูล: state เดินหน้าทีละขั้น, kill ยกเลิกไม่ได้, version เพิ่มทุกครั้ง
CREATE FUNCTION ob_guard_originate_rollout() RETURNS trigger AS $$
DECLARE
  old_rank INT;
  new_rank INT;
BEGIN
  old_rank := array_position(
    ARRAY['DISABLED','SHADOW_RECEIPT','OWNER_CONFORMANCE','SCOPED_INTERNAL_ENABLED'], OLD.state::text);
  new_rank := array_position(
    ARRAY['DISABLED','SHADOW_RECEIPT','OWNER_CONFORMANCE','SCOPED_INTERNAL_ENABLED'], NEW.state::text);
  IF new_rank < old_rank OR new_rank > old_rank + 1 THEN
    RAISE EXCEPTION 'ob_originate_rollout_state เลื่อนได้ทีละขั้นไปข้างหน้าเท่านั้น';
  END IF;
  IF OLD.killed AND (NOT NEW.killed OR NEW.state <> OLD.state) THEN
    RAISE EXCEPTION 'ob_originate_rollout_state ที่ถูก kill แล้วยกเลิกหรือเลื่อน state ไม่ได้';
  END IF;
  IF NEW.version <= OLD.version THEN
    RAISE EXCEPTION 'ob_originate_rollout_state version ต้องเพิ่มขึ้นทุกครั้งที่แก้';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "ob_originate_rollout_guard"
BEFORE UPDATE ON "ob_originate_rollout_state"
FOR EACH ROW EXECUTE FUNCTION ob_guard_originate_rollout();

CREATE FUNCTION ob_reject_originate_rollout_audit_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'ob_originate_rollout_audit เป็น append-only';
END;
$$ LANGUAGE plpgsql;

-- UPDATE ถูกปฏิเสธสำหรับทุก role; DELETE ถูกถอนสิทธิ์จาก application role (owner ยังลบตอน teardown/
-- retention ได้ แบบเดียวกับ jr_recovery_audit)
CREATE TRIGGER "ob_originate_rollout_audit_immutable"
BEFORE UPDATE ON "ob_originate_rollout_audit"
FOR EACH ROW EXECUTE FUNCTION ob_reject_originate_rollout_audit_mutation();

ALTER TABLE "ob_originate_rollout_state" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ob_originate_rollout_state"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "ob_originate_rollout_scopes" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ob_originate_rollout_scopes"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "ob_originate_rollout_audit" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "ob_originate_rollout_audit"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "ob_originate_rollout_state" TO dcontact_app;
GRANT SELECT, INSERT, DELETE ON "ob_originate_rollout_scopes" TO dcontact_app;
GRANT SELECT, INSERT ON "ob_originate_rollout_audit" TO dcontact_app;
REVOKE UPDATE, DELETE ON "ob_originate_rollout_audit" FROM dcontact_app;
