ALTER TABLE "jr_segment_refilter_cursors" ADD COLUMN "scope_team_id" UUID;
CREATE INDEX "jr_segment_refilter_cursors_tenant_scope_team_idx"
  ON "jr_segment_refilter_cursors"("tenant_id", "scope_team_id");

CREATE TABLE "jr_iam_scope_invalidation_inbox" (
  "consumer" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "scope_version" INTEGER NOT NULL,
  "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "jr_iam_scope_invalidation_inbox_pkey" PRIMARY KEY ("consumer", "tenant_id", "event_id"),
  CONSTRAINT "jr_iam_scope_invalidation_scope_version_check" CHECK ("scope_version" >= 1),
  CONSTRAINT "jr_iam_scope_invalidation_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE INDEX "jr_iam_scope_invalidation_tenant_scope_version_idx"
  ON "jr_iam_scope_invalidation_inbox"("tenant_id", "scope_version");
ALTER TABLE "jr_iam_scope_invalidation_inbox" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "jr_iam_scope_invalidation_inbox"
  USING ("tenant_id" = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK ("tenant_id" = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT ON "jr_iam_scope_invalidation_inbox" TO dcontact_app;
