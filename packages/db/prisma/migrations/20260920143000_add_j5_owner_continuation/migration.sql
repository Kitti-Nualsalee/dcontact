-- J5.0 (#338): bind owner actions to the Journey cursor and record exactly-once
-- continuation in the same transaction as the durable owner result.
--
-- Additive only: legacy actions remain readable. A legacy row is bound only when its
-- actionKey exactly proves the enrollment's current cursor; ambiguous rows stay null
-- and therefore cannot move the cursor.

CREATE TYPE "JrOwnerContinuationOutcome" AS ENUM ('ADVANCED', 'TERMINAL_IGNORED');

ALTER TABLE "jr_owner_actions"
  ADD COLUMN "step_id" TEXT,
  ADD COLUMN "step_sequence" INTEGER;

ALTER TABLE "jr_owner_actions"
  ADD CONSTRAINT "jr_owner_actions_step_binding_check"
  CHECK (
    ("step_id" IS NULL AND "step_sequence" IS NULL)
    OR ("step_id" IS NOT NULL AND "step_sequence" IS NOT NULL AND "step_sequence" >= 0)
  );

CREATE UNIQUE INDEX "jr_owner_actions_tenant_id_id_key"
  ON "jr_owner_actions"("tenant_id", "id");

-- Deterministic legacy backfill only. If the enrollment moved, the key does not match
-- currentStepId and this row deliberately remains unbound for explicit quarantine.
UPDATE "jr_owner_actions" AS action
SET
  "step_id" = enrollment."current_step_id",
  "step_sequence" = enrollment."step_sequence"
FROM "jr_enrollments" AS enrollment
WHERE action."tenant_id" = enrollment."tenant_id"
  AND action."enrollment_id" = enrollment."id"
  AND enrollment."current_step_id" IS NOT NULL
  AND action."action_key" = (
    enrollment."id"::text || ':' || enrollment."journey_version"::text || ':' || enrollment."current_step_id"
  );

CREATE TABLE "jr_owner_continuations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "action_id" UUID NOT NULL,
  "action_key" TEXT NOT NULL,
  "command_id" TEXT NOT NULL,
  "enrollment_id" UUID NOT NULL,
  "from_step_id" TEXT NOT NULL,
  "from_step_sequence" INTEGER NOT NULL,
  "result_kind" "JrOwnerResultKind" NOT NULL,
  "next_step_id" TEXT,
  "outcome" "JrOwnerContinuationOutcome" NOT NULL,
  "result_hash" CHAR(64) NOT NULL,
  "correlation_id" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "jr_owner_continuations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "jr_owner_continuations_step_sequence_check" CHECK ("from_step_sequence" >= 0),
  CONSTRAINT "jr_owner_continuations_hash_check" CHECK ("result_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "jr_owner_continuations_outcome_check" CHECK (
    ("outcome" = 'ADVANCED' AND "next_step_id" IS NOT NULL)
    OR ("outcome" = 'TERMINAL_IGNORED' AND "next_step_id" IS NULL)
  )
);

CREATE UNIQUE INDEX "jr_owner_continuations_tenant_id_id_key"
  ON "jr_owner_continuations"("tenant_id", "id");
CREATE UNIQUE INDEX "jr_owner_continuations_tenant_action_key"
  ON "jr_owner_continuations"("tenant_id", "action_id");
CREATE UNIQUE INDEX "jr_owner_continuations_tenant_command_key"
  ON "jr_owner_continuations"("tenant_id", "command_id");
CREATE INDEX "jr_owner_continuations_tenant_enrollment_sequence_idx"
  ON "jr_owner_continuations"("tenant_id", "enrollment_id", "from_step_sequence");

ALTER TABLE "jr_owner_continuations" ADD CONSTRAINT "jr_owner_continuations_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_owner_continuations" ADD CONSTRAINT "jr_owner_continuations_action_fkey"
  FOREIGN KEY ("tenant_id", "action_id") REFERENCES "jr_owner_actions"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_owner_continuations" ADD CONSTRAINT "jr_owner_continuations_result_fkey"
  FOREIGN KEY ("tenant_id", "command_id") REFERENCES "jr_owner_result_inbox"("tenant_id", "command_id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "jr_owner_continuations" ADD CONSTRAINT "jr_owner_continuations_enrollment_fkey"
  FOREIGN KEY ("tenant_id", "enrollment_id") REFERENCES "jr_enrollments"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "jr_owner_continuations" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_owner_continuations"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Ledger content is append-only. The application can create and read evidence but
-- cannot rewrite or delete a committed cursor decision.
GRANT SELECT, INSERT ON "jr_owner_continuations" TO dcontact_app;
REVOKE UPDATE, DELETE ON "jr_owner_continuations" FROM dcontact_app;
