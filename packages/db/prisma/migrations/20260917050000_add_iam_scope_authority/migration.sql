-- IAM.1 (#301): IAM-owned team/segment authority and a projection of canonical
-- Customer 360 membership. Consumers never write these rows.

CREATE TYPE "IamScopePermission" AS ENUM ('WORK', 'CONTACT');
CREATE TYPE "IamScopeGrantState" AS ENUM ('ACTIVE', 'REVOKED');
CREATE TYPE "IamScopeProjectionState" AS ENUM ('IN', 'OUT', 'INVALIDATED');
CREATE TYPE "IamScopeOutboxState" AS ENUM ('PENDING', 'PUBLISHED', 'FAILED');
CREATE TYPE "IamScopeInvalidationKind" AS ENUM ('GRANTED', 'REVOKED', 'TEAM_DEACTIVATED', 'DELEGATION_REVOKED');

CREATE UNIQUE INDEX "teams_tenant_id_id_key" ON "teams"("tenant_id", "id");

CREATE TABLE "iam_team_segment_scope_grants" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "permission" "IamScopePermission" NOT NULL,
  "grant_version" INTEGER NOT NULL,
  "state" "IamScopeGrantState" NOT NULL DEFAULT 'ACTIVE',
  "starts_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_team_segment_scope_grants_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iam_scope_grant_version_check" CHECK ("grant_version" >= 1),
  CONSTRAINT "iam_scope_grant_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "iam_scope_grant_team_fkey" FOREIGN KEY ("tenant_id", "team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "iam_scope_grant_tenant_id_id_key" ON "iam_team_segment_scope_grants"("tenant_id", "id");
CREATE UNIQUE INDEX "iam_scope_grant_active_key" ON "iam_team_segment_scope_grants"("tenant_id", "team_id", "segment_id", "permission") WHERE "state" = 'ACTIVE';

CREATE TABLE "iam_team_segment_scope_revocations" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "grant_id" UUID NOT NULL,
  "scope_version" INTEGER NOT NULL,
  "reason_code" TEXT NOT NULL,
  "revoked_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_scope_revocation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iam_scope_revocation_version_check" CHECK ("scope_version" >= 1),
  CONSTRAINT "iam_scope_revocation_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "iam_scope_revocation_grant_fkey" FOREIGN KEY ("tenant_id", "grant_id") REFERENCES "iam_team_segment_scope_grants"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "iam_scope_revocation_tenant_grant_key" ON "iam_team_segment_scope_revocations"("tenant_id", "grant_id");

CREATE TABLE "iam_team_scope_versions" (
  "tenant_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "scope_version" INTEGER NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_team_scope_versions_pkey" PRIMARY KEY ("tenant_id", "team_id"),
  CONSTRAINT "iam_team_scope_version_check" CHECK ("scope_version" >= 0),
  CONSTRAINT "iam_team_scope_version_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "iam_team_scope_version_team_fkey" FOREIGN KEY ("tenant_id", "team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "iam_contact_segment_scope_projection" (
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "segment_id" TEXT NOT NULL,
  "state" "IamScopeProjectionState" NOT NULL,
  "membership_revision" INTEGER NOT NULL,
  "entry_id" TEXT,
  "source_event_id" TEXT NOT NULL,
  "source_occurred_at" TIMESTAMP(3) NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_scope_projection_pkey" PRIMARY KEY ("tenant_id", "contact_id", "segment_id"),
  CONSTRAINT "iam_scope_projection_revision_check" CHECK ("membership_revision" >= 1),
  CONSTRAINT "iam_scope_projection_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "iam_scope_projection_contact_fkey" FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE TABLE "iam_scope_invalidation_outbox" (
  "id" UUID NOT NULL,
  "tenant_id" UUID NOT NULL,
  "team_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "scope_version" INTEGER NOT NULL,
  "kind" "IamScopeInvalidationKind" NOT NULL,
  "payload" JSONB NOT NULL,
  "payload_hash" CHAR(64) NOT NULL,
  "state" "IamScopeOutboxState" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "available_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "published_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_scope_outbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "iam_scope_outbox_version_check" CHECK ("scope_version" >= 1 AND "attempts" >= 0),
  CONSTRAINT "iam_scope_outbox_hash_check" CHECK ("payload_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "iam_scope_outbox_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "iam_scope_outbox_team_fkey" FOREIGN KEY ("tenant_id", "team_id") REFERENCES "teams"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "iam_scope_outbox_tenant_id_id_key" ON "iam_scope_invalidation_outbox"("tenant_id", "id");
CREATE UNIQUE INDEX "iam_scope_outbox_tenant_event_key" ON "iam_scope_invalidation_outbox"("tenant_id", "event_id");
CREATE INDEX "iam_scope_outbox_ready_idx" ON "iam_scope_invalidation_outbox"("tenant_id", "state", "available_at", "created_at");

CREATE TABLE "iam_scope_consumer_inbox" (
  "consumer_group" TEXT NOT NULL,
  "tenant_id" UUID NOT NULL,
  "event_id" TEXT NOT NULL,
  "completed_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "iam_scope_consumer_inbox_pkey" PRIMARY KEY ("consumer_group", "tenant_id", "event_id"),
  CONSTRAINT "iam_scope_consumer_inbox_tenant_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['iam_team_segment_scope_grants', 'iam_team_segment_scope_revocations', 'iam_team_scope_versions', 'iam_contact_segment_scope_projection', 'iam_scope_invalidation_outbox', 'iam_scope_consumer_inbox'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.tenant_id'', true)::uuid) WITH CHECK (tenant_id = current_setting(''app.tenant_id'', true)::uuid)', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON %I TO dcontact_app', t);
  END LOOP;
END $$;
REVOKE UPDATE, DELETE ON "iam_team_segment_scope_revocations", "iam_scope_invalidation_outbox" FROM dcontact_app;
REVOKE UPDATE, DELETE ON "iam_scope_consumer_inbox" FROM dcontact_app;
