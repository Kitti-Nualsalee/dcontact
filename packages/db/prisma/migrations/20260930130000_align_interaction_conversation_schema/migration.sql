-- แก้ schema drift: Prisma Interaction มี nullable relations นี้ตั้งแต่ ADR-023
-- แต่ไม่เคยมี migration เพิ่มเข้า DB; additive only และ voice interaction เดิมยังเป็น null.
ALTER TABLE "interactions"
  ADD COLUMN "conversation_id" UUID,
  ADD COLUMN "reopened_from_interaction_id" UUID;

ALTER TABLE "interactions"
  ADD CONSTRAINT "interactions_conversation_id_fkey"
    FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT "interactions_reopened_from_interaction_id_fkey"
    FOREIGN KEY ("reopened_from_interaction_id") REFERENCES "interactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "interactions_tenant_id_conversation_id_queued_at_idx"
  ON "interactions"("tenant_id", "conversation_id", "queued_at");
CREATE INDEX "interactions_tenant_id_reopened_from_interaction_id_idx"
  ON "interactions"("tenant_id", "reopened_from_interaction_id");
