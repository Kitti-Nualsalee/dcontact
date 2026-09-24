-- A1.3 (#408): scheduling ของ saga worker — expand-only
-- next_attempt_at: backoff + jitter หลัง transient failure (worker ไม่ claim ก่อนเวลานี้)
-- attempt_floor: จุดเริ่มงบ attempt ปัจจุบัน — operator Retry เปิดงบใหม่โดยไม่ reset `attempt`
--   เพราะ receipt unique ต่อ (request, step, attempt) ต้องเดินหน้าอย่างเดียว
ALTER TABLE "pf_provisioning_steps"
  ADD COLUMN "next_attempt_at" TIMESTAMP(3),
  ADD COLUMN "attempt_floor" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "pf_provisioning_steps" ADD CONSTRAINT "pf_provisioning_steps_attempt_floor_check" CHECK (
  "attempt_floor" >= 0 AND "attempt_floor" <= "attempt"
);

-- worker หา step ที่ถึงเวลาได้โดยไม่ scan ทั้งตาราง
CREATE INDEX "pf_provisioning_steps_claim_idx"
  ON "pf_provisioning_steps"("state", "next_attempt_at", "lease_expires_at");
