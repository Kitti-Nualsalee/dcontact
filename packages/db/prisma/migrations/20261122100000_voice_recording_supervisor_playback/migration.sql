-- #967 Supervisor เปิดฟังเสียงบันทึกของสายที่ทีมตัวเองรับ
-- หลักฐานว่าใครและทีมไหนรับสายจริง Router เขียนใน transaction เดียวกับการรับสาย (append-only)
-- หลักฐานอยู่กับ Interaction: ลบ Interaction แล้วหลักฐานหายตาม
-- team_id ไม่มี FK เพราะเป็นค่า ณ เวลารับสาย ทีมที่ถูกลบภายหลังต้องไม่ถูกบล็อกและไม่มีใครได้สิทธิ์ฟัง
CREATE TABLE "voice_interaction_handling_attributions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "interaction_id" UUID NOT NULL,
  "agent_id" UUID NOT NULL,
  "team_id" UUID,
  "accepted_at" TIMESTAMP(3) NOT NULL,
  "source_event_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "voice_interaction_handling_attributions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "voice_interaction_handling_attributions_interaction_fkey"
    FOREIGN KEY ("tenant_id", "interaction_id") REFERENCES "interactions"("tenant_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "voice_interaction_handling_attributions_agent_fkey"
    FOREIGN KEY ("tenant_id", "agent_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

-- รอบแรกรองรับทีมที่รับสายทีมเดียวต่อ Interaction
CREATE UNIQUE INDEX "voice_interaction_handling_attributions_interaction_key"
  ON "voice_interaction_handling_attributions"("tenant_id", "interaction_id");
CREATE INDEX "voice_interaction_handling_attributions_team_idx"
  ON "voice_interaction_handling_attributions"("tenant_id", "team_id", "accepted_at" DESC);

-- session ของการเปิดฟังผูกกับผู้ขอ เก็บรูปแบบไฟล์ที่ตรวจแล้วเพื่อไม่ต้องอ่าน header ซ้ำทุก chunk
CREATE TABLE "recording_playback_sessions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "tenant_id" UUID NOT NULL,
  "recording_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL,
  "data_offset" INTEGER NOT NULL,
  "sample_rate" INTEGER NOT NULL,
  "channels" INTEGER NOT NULL,
  "total_frames" INTEGER NOT NULL,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "closed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "recording_playback_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "recording_playback_sessions_recording_fkey"
    FOREIGN KEY ("recording_id") REFERENCES "recordings"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "recording_playback_sessions_actor_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "recording_playback_sessions_format_check"
    CHECK ("data_offset" > 0 AND "sample_rate" > 0 AND "channels" IN (1, 2) AND "total_frames" >= 0)
);

CREATE INDEX "recording_playback_sessions_actor_idx"
  ON "recording_playback_sessions"("tenant_id", "actor_user_id", "closed_at");
