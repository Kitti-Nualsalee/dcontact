-- E1.10 (#484): one-time SIP credential ผูกกับ work-session lease

CREATE TABLE "agent_sip_credentials" (
    "work_session_lease_id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "extension" TEXT NOT NULL,
    "sip_domain" TEXT NOT NULL,
    "telephony_node_id" TEXT NOT NULL,
    "a1_hash" TEXT NOT NULL,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "revoked_at" TIMESTAMP(3),

    CONSTRAINT "agent_sip_credentials_pkey" PRIMARY KEY ("work_session_lease_id")
);

ALTER TABLE "agent_sip_credentials" ADD CONSTRAINT "agent_sip_credentials_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_sip_credentials" ADD CONSTRAINT "agent_sip_credentials_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_sip_credentials" ADD CONSTRAINT "agent_sip_credentials_work_session_lease_id_fkey"
  FOREIGN KEY ("work_session_lease_id") REFERENCES "agent_work_session_leases"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "agent_sip_credentials" ADD CONSTRAINT "agent_sip_credentials_values_check" CHECK (
  length("extension") BETWEEN 1 AND 64
  AND "extension" ~ '^[A-Za-z0-9_.-]+$'
  AND length("sip_domain") BETWEEN 1 AND 253
  AND "sip_domain" ~ '^[A-Za-z0-9.-]+$'
  AND length("telephony_node_id") BETWEEN 1 AND 128
  AND "a1_hash" ~ '^[0-9a-f]{32}$'
  AND ("revoked_at" IS NULL OR "revoked_at" >= "issued_at")
);

CREATE UNIQUE INDEX "agent_sip_credentials_tenant_extension_key"
  ON "agent_sip_credentials" ("tenant_id", "extension") WHERE "revoked_at" IS NULL;
CREATE INDEX "agent_sip_credentials_tenant_user_idx"
  ON "agent_sip_credentials" ("tenant_id", "user_id");

ALTER TABLE "agent_sip_credentials" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "agent_sip_credentials"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE ON "agent_sip_credentials" TO dcontact_app;
REVOKE DELETE ON "agent_sip_credentials" FROM dcontact_app;
