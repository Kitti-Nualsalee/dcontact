-- IAM.1 follow-up: the preceding migration was already applied in local development.
-- A clean deployment has no state/index to remove; IF EXISTS keeps both paths equivalent.

DROP INDEX IF EXISTS "iam_scope_grant_active_key";
ALTER TABLE "iam_team_segment_scope_grants" DROP COLUMN IF EXISTS "state";
DROP TYPE IF EXISTS "IamScopeGrantState";

CREATE TABLE "iam_team_segment_scope_active_grants" (
  "tenant_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "permission" "IamScopePermission" NOT NULL,
  "grant_id" UUID NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_scope_active_grant_pkey" PRIMARY KEY ("tenant_id", "team_id", "segment_id", "permission"),
  CONSTRAINT "iam_scope_active_grant_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "iam_scope_active_grant_team_fkey" FOREIGN KEY ("tenant_id", "team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "iam_scope_active_grant_grant_fkey" FOREIGN KEY ("tenant_id", "grant_id") REFERENCES "iam_team_segment_scope_grants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "iam_scope_active_grant_tenant_grant_key" ON "iam_team_segment_scope_active_grants"("tenant_id", "grant_id");

INSERT INTO "iam_team_segment_scope_active_grants" ("tenant_id", "team_id", "segment_id", "permission", "grant_id")
SELECT g."tenant_id", g."team_id", g."segment_id", g."permission", g."id"
FROM "iam_team_segment_scope_grants" AS g
WHERE NOT EXISTS (
  SELECT 1
  FROM "iam_team_segment_scope_revocations" AS r
  WHERE r."tenant_id" = g."tenant_id" AND r."grant_id" = g."id"
);

ALTER TABLE "iam_team_segment_scope_active_grants" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "iam_team_segment_scope_active_grants"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON "iam_team_segment_scope_active_grants" TO dcontact_app;
