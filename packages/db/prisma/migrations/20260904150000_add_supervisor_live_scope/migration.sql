ALTER TABLE "queues"
  ADD COLUMN "team_id" UUID,
  ADD CONSTRAINT "queues_team_id_fkey" FOREIGN KEY ("team_id") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "queues_tenant_id_team_id_idx" ON "queues"("tenant_id", "team_id");

ALTER TABLE "agent_state_logs"
  ADD COLUMN "actor_user_id" UUID;
