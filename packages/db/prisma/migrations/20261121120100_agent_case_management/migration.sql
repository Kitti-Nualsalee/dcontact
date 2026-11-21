-- #956 Agent เปิดเคสจากงาน มอบหมายในทีม เพิ่มโน้ต เปลี่ยนสถานะ และปิดเคส
-- คอลัมน์ใหม่เป็น nullable เพราะเคสเดิมจาก J2 ENSURE_CASE ไม่มีหัวข้อ ทีม หรือผู้รับผิดชอบ
ALTER TABLE "cs_cases"
  ADD COLUMN "subject" TEXT,
  ADD COLUMN "team_id" UUID,
  ADD COLUMN "assignee_user_id" UUID,
  ADD COLUMN "created_by_user_id" UUID,
  ADD COLUMN "source_interaction_id" UUID;

ALTER TABLE "cs_cases"
  ADD CONSTRAINT "cs_cases_subject_length_check"
    CHECK ("subject" IS NULL OR char_length("subject") BETWEEN 1 AND 200),
  -- เคสที่ Agent เปิดต้องมีทีมและผู้เปิดครบชุด เพื่อใช้กำหนดว่าใครเห็นเคส
  ADD CONSTRAINT "cs_cases_agent_case_check"
    CHECK ("created_by_user_id" IS NULL OR ("subject" IS NOT NULL AND "team_id" IS NOT NULL)),
  ADD CONSTRAINT "cs_cases_team_fkey"
    FOREIGN KEY ("tenant_id", "team_id") REFERENCES "teams"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cs_cases_assignee_fkey"
    FOREIGN KEY ("tenant_id", "assignee_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cs_cases_created_by_fkey"
    FOREIGN KEY ("tenant_id", "created_by_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "cs_cases_tenant_team_status_updated_idx"
  ON "cs_cases"("tenant_id", "team_id", "status", "updated_at" DESC);

-- ไทม์ไลน์เดียวของเคส: แถวจาก J2 มี outcome reference ส่วนแถวที่ Agent ทำมีผู้กระทำ
ALTER TABLE "cs_case_activities"
  ALTER COLUMN "interaction_id" DROP NOT NULL,
  ALTER COLUMN "outcome_type" DROP NOT NULL,
  ALTER COLUMN "outcome_id" DROP NOT NULL,
  ALTER COLUMN "outcome_version" DROP NOT NULL,
  ALTER COLUMN "correlation_id" DROP NOT NULL,
  ADD COLUMN "actor_user_id" UUID,
  ADD COLUMN "body" TEXT,
  ADD COLUMN "from_status" "CsCaseStatus",
  ADD COLUMN "to_status" "CsCaseStatus",
  ADD COLUMN "assignee_user_id" UUID;

ALTER TABLE "cs_case_activities"
  ADD CONSTRAINT "cs_case_activities_source_check"
    CHECK ("outcome_id" IS NOT NULL OR "actor_user_id" IS NOT NULL),
  ADD CONSTRAINT "cs_case_activities_body_length_check"
    CHECK ("body" IS NULL OR char_length("body") BETWEEN 1 AND 2000),
  ADD CONSTRAINT "cs_case_activities_case_fkey"
    FOREIGN KEY ("case_id") REFERENCES "cs_cases"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cs_case_activities_actor_fkey"
    FOREIGN KEY ("tenant_id", "actor_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "cs_case_activities_assignee_fkey"
    FOREIGN KEY ("tenant_id", "assignee_user_id") REFERENCES "users"("tenant_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;
