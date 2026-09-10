CREATE TYPE "JrJourneyDefinitionStatus" AS ENUM (
    'DRAFT',
    'PUBLISHED'
);

CREATE TABLE "jr_journey_definitions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    -- ไม่มี FK ไป teams โดยตั้งใจ (เหมือน cg_reservations.team_id/cg_decision_logs.team_id):
    -- draft เขียนค่าที่ยังตรวจไม่ได้ได้; publishVersion() เป็นจุดเดียวที่ยืนยัน owner team
    -- จริงใน tenant เดียวกันก่อนเปลี่ยนสถานะ
    "owner_team_id" UUID NOT NULL,
    "status" "JrJourneyDefinitionStatus" NOT NULL DEFAULT 'DRAFT',
    "trigger" JSONB NOT NULL,
    "graph" JSONB NOT NULL,
    "goal" JSONB NOT NULL,
    "exit_rules" JSONB NOT NULL,
    "max_duration_days" INTEGER NOT NULL,
    "input_hash" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "published_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "jr_journey_definitions_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "jr_journey_definitions_tenant_id_id_key"
ON "jr_journey_definitions"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_journey_definitions_tenant_id_journey_id_version_key"
ON "jr_journey_definitions"("tenant_id", "journey_id", "version");
CREATE INDEX "jr_journey_definitions_tenant_id_journey_id_status_idx"
ON "jr_journey_definitions"("tenant_id", "journey_id", "status");

ALTER TABLE "jr_journey_definitions"
ADD CONSTRAINT "jr_journey_definitions_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_journey_definitions" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "jr_journey_definitions"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- content เป็น immutable; แถวเปลี่ยนได้แค่ทาง publish transition (status/published_at)
-- ที่ repository เป็นผู้บังคับ ไม่ใช่การเปิดให้แก้เนื้อหา
GRANT SELECT, INSERT, UPDATE ON "jr_journey_definitions" TO dcontact_app;
REVOKE DELETE ON "jr_journey_definitions" FROM dcontact_app;
