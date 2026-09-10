CREATE TYPE "JrExecutionStatus" AS ENUM (
    'ACTIVE',
    'WAITING',
    'SUBMITTING',
    'COMPLETED',
    'EXITED',
    'CANCELLED',
    'FAILED'
);

CREATE TABLE "jr_executions" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "journey_id" UUID NOT NULL,
    "journey_version" INTEGER NOT NULL,
    "enrollment_key" TEXT NOT NULL,
    "status" "JrExecutionStatus" NOT NULL DEFAULT 'ACTIVE',
    "current_step_id" TEXT NOT NULL,
    "pending_action_key" TEXT,
    "step_version" INTEGER NOT NULL DEFAULT 0,
    "wait_until" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancel_reason" TEXT,
    "goal_reached_at" TIMESTAMP(3),
    "exit_event_type" TEXT,
    "exit_event_at" TIMESTAMP(3),
    "terminal_reason" TEXT,
    "terminal_at" TIMESTAMP(3),
    "correlation_id" TEXT NOT NULL,
    "enrolled_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "jr_executions_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "jr_execution_steps" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "execution_id" UUID NOT NULL,
    "from_step_version" INTEGER NOT NULL,
    "step_id" TEXT NOT NULL,
    "step_type" TEXT NOT NULL,
    "result" TEXT NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "causation_id" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "jr_execution_steps_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "jr_executions_tenant_id_id_key"
ON "jr_executions"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_executions_tenant_id_journey_id_journey_version_enrollm_key"
ON "jr_executions"("tenant_id", "journey_id", "journey_version", "enrollment_key");
CREATE INDEX "jr_executions_tenant_id_status_wait_until_idx"
ON "jr_executions"("tenant_id", "status", "wait_until");

CREATE UNIQUE INDEX "jr_execution_steps_tenant_id_id_key"
ON "jr_execution_steps"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_execution_steps_tenant_id_execution_id_from_step_versio_key"
ON "jr_execution_steps"("tenant_id", "execution_id", "from_step_version");
CREATE INDEX "jr_execution_steps_tenant_id_execution_id_occurred_at_idx"
ON "jr_execution_steps"("tenant_id", "execution_id", "occurred_at");

ALTER TABLE "jr_executions"
ADD CONSTRAINT "jr_executions_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_executions"
ADD CONSTRAINT "jr_executions_tenant_id_journey_id_journey_version_fkey"
FOREIGN KEY ("tenant_id", "journey_id", "journey_version") REFERENCES "jr_journey_definitions"("tenant_id", "journey_id", "version") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_execution_steps"
ADD CONSTRAINT "jr_execution_steps_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_execution_steps"
ADD CONSTRAINT "jr_execution_steps_tenant_id_execution_id_fkey"
FOREIGN KEY ("tenant_id", "execution_id") REFERENCES "jr_executions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_executions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "jr_execution_steps" ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON "jr_executions"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "jr_execution_steps"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "jr_executions" TO dcontact_app;
REVOKE DELETE ON "jr_executions" FROM dcontact_app;
-- append-only evidence log: หนึ่ง transition ต่อหนึ่งแถว ห้ามแก้/ลบ
GRANT SELECT, INSERT ON "jr_execution_steps" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_execution_steps" FROM dcontact_app;
