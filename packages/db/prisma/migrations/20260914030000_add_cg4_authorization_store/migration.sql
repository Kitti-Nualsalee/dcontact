-- CG4.7 (#190): the canonical store the Cg4AuthorizationPort resolves a subject from.
--
-- CG4.3 declared that port as IAM's boundary, but this repository has no IAM service, and
-- `users.role` is a three-value enum (#173 forbids a role string standing in for a domain
-- capability). These two tables are that store in the meantime: swapping in a real IAM
-- service means replacing the adapter that reads them, not any repository.

CREATE TYPE "Cg4AuthenticationStrength" AS ENUM ('STANDARD', 'STRONG');

CREATE TABLE "cg_authorization_subject" (
  "id"                          UUID NOT NULL,
  "tenant_id"                   UUID NOT NULL,
  "subject_id"                  TEXT NOT NULL,
  "authentication_strength"     "Cg4AuthenticationStrength" NOT NULL DEFAULT 'STANDARD',
  "direct_compliance_authority" BOOLEAN NOT NULL DEFAULT false,
  "emergency_authority"         BOOLEAN NOT NULL DEFAULT false,
  "is_service_principal"        BOOLEAN NOT NULL DEFAULT false,
  "authorization_epoch"         INTEGER NOT NULL DEFAULT 1,
  "scope_version"               INTEGER NOT NULL DEFAULT 1,
  "updated_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at"                  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cg_authorization_subject_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_authorization_subject_epoch_check" CHECK ("authorization_epoch" >= 1),
  CONSTRAINT "cg_authorization_subject_scope_version_check" CHECK ("scope_version" >= 1)
);

CREATE UNIQUE INDEX "cg_authorization_subject_tenant_id_id_key"
  ON "cg_authorization_subject"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_authorization_subject_tenant_subject_key"
  ON "cg_authorization_subject"("tenant_id", "subject_id");

ALTER TABLE "cg_authorization_subject" ADD CONSTRAINT "cg_authorization_subject_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "cg_capability_grant" (
  "id"             UUID NOT NULL,
  "tenant_id"      UUID NOT NULL,
  "subject_id"     TEXT NOT NULL,
  "capability"     TEXT NOT NULL,
  "scope_key"      TEXT NOT NULL,
  "expires_at"     TIMESTAMP(3),
  "granted_by_ref" TEXT NOT NULL,
  "created_at"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cg_capability_grant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "cg_capability_grant_tenant_id_id_key"
  ON "cg_capability_grant"("tenant_id", "id");
CREATE UNIQUE INDEX "cg_capability_grant_tenant_subject_capability_scope_key"
  ON "cg_capability_grant"("tenant_id", "subject_id", "capability", "scope_key");
CREATE INDEX "cg_capability_grant_lookup_idx"
  ON "cg_capability_grant"("tenant_id", "subject_id", "expires_at");

ALTER TABLE "cg_capability_grant" ADD CONSTRAINT "cg_capability_grant_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── RLS and grants ───────────────────────────────────────────────────────────
ALTER TABLE "cg_authorization_subject" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_capability_grant" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "cg_authorization_subject";
CREATE POLICY tenant_isolation ON "cg_authorization_subject"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "cg_capability_grant";
CREATE POLICY tenant_isolation ON "cg_capability_grant"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- Contact Governance only ever reads its authorization state; whoever administers grants
-- does so outside the application role, so a compromised app cannot widen its own rights.
GRANT SELECT ON "cg_authorization_subject" TO dcontact_app;
GRANT SELECT ON "cg_capability_grant" TO dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON "cg_authorization_subject" FROM dcontact_app;
REVOKE INSERT, UPDATE, DELETE ON "cg_capability_grant" FROM dcontact_app;
