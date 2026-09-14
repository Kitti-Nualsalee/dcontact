-- CG4.10 (#193) PR-B: shadow → switch → enforce ของ #179 §6
--
-- rollout state เป็นของ Contact Governance ต่อ tenant (#178 development rollout)
-- `DISABLED → SHADOW_EVALUATION → SCOPED_SYNTHETIC → INTERNAL_ENABLED` ทุก stage ไม่มี provider traffic
-- ก่อน switch ถอยกลับไปอ่าน CG3 ได้ หลัง switch ห้ามย้อน writer/reader: ใช้ freeze/kill/forward-fix แทน

CREATE TYPE "Cg4RolloutStage" AS ENUM (
  'DISABLED',
  'SHADOW_EVALUATION',
  'SCOPED_SYNTHETIC',
  'INTERNAL_ENABLED'
);

-- 1. state ปัจจุบันต่อ tenant: ไม่มีแถว = DISABLED (CG3 reader, CG4 writer เป็น dark)
CREATE TABLE "cg4_rollout_state" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "stage" "Cg4RolloutStage" NOT NULL DEFAULT 'DISABLED',
  "synthetic_scope_keys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "shadow_started_at" TIMESTAMP(3),
  "switched_at" TIMESTAMP(3),
  "mutation_frozen" BOOLEAN NOT NULL DEFAULT false,
  "version" INTEGER NOT NULL,
  "updated_by_ref" TEXT NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "cg4_rollout_state_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg4_rollout_state_version_check" CHECK ("version" >= 1),
  -- reader ของ CG4 เปิดอยู่ ⇔ switch เกิดขึ้นแล้ว
  CONSTRAINT "cg4_rollout_state_switch_check" CHECK (
    ("stage" IN ('SCOPED_SYNTHETIC', 'INTERNAL_ENABLED')) = ("switched_at" IS NOT NULL)
  ),
  CONSTRAINT "cg4_rollout_state_shadow_check" CHECK (
    "stage" = 'DISABLED' OR "shadow_started_at" IS NOT NULL
  )
);
CREATE UNIQUE INDEX "cg4_rollout_state_tenant_id_id_key" ON "cg4_rollout_state"("tenant_id", "id");
CREATE UNIQUE INDEX "cg4_rollout_state_tenant_id_key" ON "cg4_rollout_state"("tenant_id");
ALTER TABLE "cg4_rollout_state" ADD CONSTRAINT "cg4_rollout_state_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- DB เป็นด่านสุดท้ายของ irreversibility: แม้ application จะถูกข้าม ก็ย้อนหลัง switch ไม่ได้
CREATE FUNCTION cg4_guard_rollout_state() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.version <> OLD.version + 1 THEN
      RAISE EXCEPTION 'cg4_rollout_state version must advance by exactly one';
    END IF;
    IF OLD.switched_at IS NOT NULL AND NEW.switched_at IS DISTINCT FROM OLD.switched_at THEN
      RAISE EXCEPTION 'cg4_rollout_state switched_at is immutable once set';
    END IF;
    IF NEW.tenant_id <> OLD.tenant_id THEN
      RAISE EXCEPTION 'cg4_rollout_state tenant is immutable';
    END IF;
  END IF;
  IF NEW.switched_at IS NOT NULL
     AND NEW.stage::text NOT IN ('SCOPED_SYNTHETIC', 'INTERNAL_ENABLED') THEN
    RAISE EXCEPTION 'cg4 rollout cannot return below SCOPED_SYNTHETIC after switch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cg4_rollout_state_guard
  BEFORE INSERT OR UPDATE ON "cg4_rollout_state"
  FOR EACH ROW EXECUTE FUNCTION cg4_guard_rollout_state();

-- 2. ประวัติทุก transition/freeze แบบ append-only เป็นหลักฐาน rollout และ drill
CREATE TABLE "cg4_rollout_transition" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "action" TEXT NOT NULL,
  "from_stage" "Cg4RolloutStage" NOT NULL,
  "to_stage" "Cg4RolloutStage" NOT NULL,
  "from_version" INTEGER NOT NULL,
  "to_version" INTEGER NOT NULL,
  "mutation_frozen" BOOLEAN NOT NULL,
  "synthetic_scope_keys" TEXT[] NOT NULL,
  "reason_code" TEXT NOT NULL,
  "actor_ref" TEXT NOT NULL,
  "evidence_ref" TEXT NOT NULL,
  "state_digest" CHAR(64) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cg4_rollout_transition_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg4_rollout_transition_version_check" CHECK ("to_version" = "from_version" + 1),
  CONSTRAINT "cg4_rollout_transition_action_check" CHECK ("action" IN ('TRANSITION', 'FREEZE', 'UNFREEZE')),
  CONSTRAINT "cg4_rollout_transition_digest_check" CHECK ("state_digest" ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX "cg4_rollout_transition_tenant_id_id_key" ON "cg4_rollout_transition"("tenant_id", "id");
CREATE UNIQUE INDEX "cg4_rollout_transition_tenant_version_key" ON "cg4_rollout_transition"("tenant_id", "to_version");
ALTER TABLE "cg4_rollout_transition" ADD CONSTRAINT "cg4_rollout_transition_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 3. shadow mismatch: เก็บเฉพาะ opaque decision id, scope key และ digest ของผลทั้งสองฝั่ง (ไม่มี PII)
CREATE TABLE "cg4_shadow_mismatch" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "decision_id" UUID NOT NULL,
  "request_scope_key" TEXT NOT NULL,
  "pilot" BOOLEAN NOT NULL,
  "cg3_digest" CHAR(64) NOT NULL,
  "cg4_digest" CHAR(64) NOT NULL,
  "cg3_policy_version" INTEGER,
  "cg4_policy_version_id" UUID,
  "cg4_outcome" TEXT NOT NULL,
  "detected_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cg4_shadow_mismatch_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg4_shadow_mismatch_digest_check" CHECK (
    "cg3_digest" ~ '^[a-f0-9]{64}$' AND "cg4_digest" ~ '^[a-f0-9]{64}$' AND "cg3_digest" <> "cg4_digest"
  ),
  CONSTRAINT "cg4_shadow_mismatch_outcome_check" CHECK ("cg4_outcome" IN ('RESOLVED', 'UNCONFIGURED', 'FAIL_CLOSED'))
);
CREATE UNIQUE INDEX "cg4_shadow_mismatch_tenant_id_id_key" ON "cg4_shadow_mismatch"("tenant_id", "id");
CREATE UNIQUE INDEX "cg4_shadow_mismatch_tenant_decision_key" ON "cg4_shadow_mismatch"("tenant_id", "decision_id");
CREATE INDEX "cg4_shadow_mismatch_tenant_detected_idx" ON "cg4_shadow_mismatch"("tenant_id", "detected_at");
ALTER TABLE "cg4_shadow_mismatch" ADD CONSTRAINT "cg4_shadow_mismatch_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- 4. Enforce (#179 §6 ขั้น 7): หลัง switch writer ของ CG3 ปิดที่ DB ด้วย จึงไม่มีทางเกิด
--    published row ใหม่ที่ reader ของ CG4 มองไม่เห็น (legacy alias ต้องเข้า CG4 transaction แล้ว)
CREATE FUNCTION cg4_reject_legacy_policy_write_after_switch() RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "cg4_rollout_state" s
    WHERE s.tenant_id = NEW.tenant_id AND s.switched_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'legacy cg_policies writer is closed after CG4 switch';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER cg4_legacy_policy_writer_closed
  BEFORE INSERT OR UPDATE ON "cg_policies"
  FOR EACH ROW EXECUTE FUNCTION cg4_reject_legacy_policy_write_after_switch();

-- 5. RLS และ grant: state เดินได้แต่ลบไม่ได้, ประวัติและ mismatch เป็น append-only
ALTER TABLE "cg4_rollout_state" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg4_rollout_transition" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg4_shadow_mismatch" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "cg4_rollout_state" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg4_rollout_transition" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "cg4_shadow_mismatch" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "cg4_rollout_state" TO dcontact_app;
GRANT SELECT, INSERT ON "cg4_rollout_transition", "cg4_shadow_mismatch" TO dcontact_app;
REVOKE DELETE ON "cg4_rollout_state" FROM dcontact_app;
REVOKE UPDATE, DELETE ON "cg4_rollout_transition", "cg4_shadow_mismatch" FROM dcontact_app;
