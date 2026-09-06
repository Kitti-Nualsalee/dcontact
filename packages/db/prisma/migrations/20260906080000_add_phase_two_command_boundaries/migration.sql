CREATE TABLE "qm_console_contexts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "interaction_id" UUID NOT NULL,
    "issued_for_user_id" UUID NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "qm_console_contexts_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "qm_console_contexts_tenant_id_issued_for_user_id_expires_at_idx"
ON "qm_console_contexts"("tenant_id", "issued_for_user_id", "expires_at");
CREATE INDEX "qm_console_contexts_tenant_id_interaction_id_expires_at_idx"
ON "qm_console_contexts"("tenant_id", "interaction_id", "expires_at");

ALTER TABLE "qm_console_contexts"
ADD CONSTRAINT "qm_console_contexts_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "qm_console_contexts"
ADD CONSTRAINT "qm_console_contexts_interaction_id_fkey"
FOREIGN KEY ("interaction_id") REFERENCES "interactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "command_receipts" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "command_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "resource_id" UUID NOT NULL,
    "result" JSONB NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "command_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "command_receipts_tenant_id_command_id_key"
ON "command_receipts"("tenant_id", "command_id");
CREATE INDEX "command_receipts_tenant_id_resource_id_created_at_idx"
ON "command_receipts"("tenant_id", "resource_id", "created_at");

ALTER TABLE "command_receipts"
ADD CONSTRAINT "command_receipts_tenant_id_fkey"
FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "qm_console_contexts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "command_receipts" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "qm_console_contexts"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "command_receipts"
USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "qm_console_contexts", "command_receipts" TO dcontact_app;
