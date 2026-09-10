-- CreateEnum
CREATE TYPE "JrRunState" AS ENUM ('RUNNING', 'WAITING', 'TERMINAL');

-- CreateEnum
CREATE TYPE "JrTerminalReason" AS ENUM ('GRAPH_EXIT', 'GOAL_REACHED', 'EXIT_RULE', 'MAX_AGE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "JrStepRunState" AS ENUM ('COMPLETED', 'AWAITING_SEND');

-- CreateEnum
CREATE TYPE "JrScheduleOccurrenceState" AS ENUM ('CLAIMED', 'ENROLLED');

-- Schedule trigger ไม่มี event ตั้งต้น จึงผ่อน event_inbox_id เป็น nullable (expand-only)
ALTER TABLE "jr_enrollments" ALTER COLUMN "event_inbox_id" DROP NOT NULL;

ALTER TABLE "jr_enrollments"
ADD COLUMN "occurrence_id" UUID,
ADD COLUMN "journey_id" UUID,
ADD COLUMN "run_state" "JrRunState" NOT NULL DEFAULT 'RUNNING',
ADD COLUMN "current_step_id" TEXT,
ADD COLUMN "step_sequence" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "wait_until" TIMESTAMP(3),
ADD COLUMN "max_age_at" TIMESTAMP(3),
ADD COLUMN "terminal_reason" "JrTerminalReason",
ADD COLUMN "terminal_step_id" TEXT,
ADD COLUMN "terminal_at" TIMESTAMP(3),
ADD COLUMN "claimed_by" TEXT,
ADD COLUMN "claim_expires_at" TIMESTAMP(3),
ADD COLUMN "correlation_id" TEXT;

-- CreateTable
CREATE TABLE "jr_schedule_occurrences" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "journey_version" INTEGER NOT NULL,
    "occurrence_at" TIMESTAMP(3) NOT NULL,
    "state" "JrScheduleOccurrenceState" NOT NULL DEFAULT 'CLAIMED',
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jr_schedule_occurrences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "jr_step_runs" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "enrollment_id" UUID NOT NULL,
    "step_sequence" INTEGER NOT NULL,
    "step_id" TEXT NOT NULL,
    "step_type" TEXT NOT NULL,
    "state" "JrStepRunState" NOT NULL,
    "next_step_id" TEXT,
    "branch_result" BOOLEAN,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "started_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "jr_step_runs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "jr_enrollments_tenant_id_id_key" ON "jr_enrollments"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jr_enrollments_tenant_occurrence_key" ON "jr_enrollments"("tenant_id", "occurrence_id");

-- CreateIndex
CREATE INDEX "jr_enrollments_tenant_run_state_wait_until_idx" ON "jr_enrollments"("tenant_id", "run_state", "wait_until");

-- CreateIndex
CREATE INDEX "jr_enrollments_tenant_run_state_max_age_idx" ON "jr_enrollments"("tenant_id", "run_state", "max_age_at");

-- CreateIndex
CREATE UNIQUE INDEX "jr_schedule_occurrences_tenant_id_id_key" ON "jr_schedule_occurrences"("tenant_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "jr_schedule_occurrences_tenant_occurrence_key" ON "jr_schedule_occurrences"("tenant_id", "journey_id", "journey_version", "occurrence_at");

-- CreateIndex
CREATE INDEX "jr_schedule_occurrences_tenant_state_occurrence_idx" ON "jr_schedule_occurrences"("tenant_id", "state", "occurrence_at");

-- CreateIndex
CREATE UNIQUE INDEX "jr_step_runs_tenant_enrollment_sequence_key" ON "jr_step_runs"("tenant_id", "enrollment_id", "step_sequence");

-- CreateIndex
CREATE INDEX "jr_step_runs_tenant_enrollment_step_idx" ON "jr_step_runs"("tenant_id", "enrollment_id", "step_id");

-- AddForeignKey
ALTER TABLE "jr_schedule_occurrences" ADD CONSTRAINT "jr_schedule_occurrences_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jr_enrollments" ADD CONSTRAINT "jr_enrollments_occurrence_id_fkey" FOREIGN KEY ("occurrence_id") REFERENCES "jr_schedule_occurrences"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jr_step_runs" ADD CONSTRAINT "jr_step_runs_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "jr_step_runs" ADD CONSTRAINT "jr_step_runs_tenant_enrollment_fkey" FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "jr_enrollments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_schedule_occurrences" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_schedule_occurrences"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

ALTER TABLE "jr_step_runs" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_step_runs"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- occurrence เดินสถานะ CLAIMED -> ENROLLED ได้ แต่ห้ามลบหลักฐานว่าเคยยิงไปแล้ว
GRANT SELECT, INSERT, UPDATE ON "jr_schedule_occurrences" TO dcontact_app;
REVOKE DELETE ON "jr_schedule_occurrences" FROM dcontact_app;

-- step run เป็น ledger ที่เขียนครั้งเดียว
GRANT SELECT, INSERT ON "jr_step_runs" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_step_runs" FROM dcontact_app;
