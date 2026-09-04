CREATE UNIQUE INDEX "recordings_tenant_id_interaction_id_key"
  ON "recordings"("tenant_id", "interaction_id");
