-- CG4.2 (#185) follow-up: fix review findings without touching already-deployed
-- migration history (see 20260913121000 for why we append instead of editing).

-- 1. CG4 exceptions must not share CgContactStateHead's optimistic-concurrency
--    counter/digest chain with CG3 preferences on the same contact.
CREATE TABLE "cg_exception_contact_head" (
  "tenant_id" UUID NOT NULL,
  "contact_id" UUID NOT NULL,
  "aggregate_version" INTEGER NOT NULL DEFAULT 0,
  "current_digest" CHAR(64) NOT NULL,
  "latest_mutation_id" UUID,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "cg_exception_contact_head_pkey" PRIMARY KEY ("tenant_id", "contact_id"),
  CONSTRAINT "cg_exception_contact_head_version_check" CHECK ("aggregate_version" >= 0),
  CONSTRAINT "cg_exception_contact_head_digest_check" CHECK ("current_digest" ~ '^[a-f0-9]{64}$')
);
ALTER TABLE "cg_exception_contact_head" ADD CONSTRAINT "cg_exception_contact_head_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception_contact_head" ADD CONSTRAINT "cg_exception_contact_head_tenant_contact_fkey"
  FOREIGN KEY ("tenant_id", "contact_id") REFERENCES "contacts"("tenant_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "cg_exception_contact_head" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "cg_exception_contact_head" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "cg_exception_contact_head" TO dcontact_app;
REVOKE DELETE ON "cg_exception_contact_head" FROM dcontact_app;

-- 2. cg4_backfill_ledger was included in the narrowing REVOKE but never GRANTed
--    SELECT/INSERT in the first place, leaving dcontact_app unable to use it at all.
GRANT SELECT, INSERT ON "cg4_backfill_ledger" TO dcontact_app;

-- 3. cg4_reject_immutable_policy_update blocked the schema's own designed forward
--    lifecycle (APPROVED -> PUBLISHED -> SCHEDULED -> ACTIVE[/SUPERSEDED]) because it
--    rejected any UPDATE once OLD.status left DRAFT/IN_REVIEW. Content stays immutable;
--    only the defined forward transitions (and their timestamp columns) are now allowed.
CREATE OR REPLACE FUNCTION cg4_reject_immutable_policy_update() RETURNS trigger AS $$
BEGIN
  IF OLD.status = 'SUPERSEDED' THEN
    RAISE EXCEPTION 'cg_policy superseded history is immutable';
  END IF;
  IF OLD.status IN ('APPROVED', 'PUBLISHED', 'SCHEDULED', 'ACTIVE') THEN
    IF NOT (
      (OLD.status = 'APPROVED' AND NEW.status = 'PUBLISHED')
      OR (OLD.status = 'PUBLISHED' AND NEW.status IN ('SCHEDULED', 'SUPERSEDED'))
      OR (OLD.status = 'SCHEDULED' AND NEW.status IN ('ACTIVE', 'SUPERSEDED'))
      OR (OLD.status = 'ACTIVE' AND NEW.status = 'SUPERSEDED')
    ) THEN
      RAISE EXCEPTION 'cg_policy published/approved history only allows forward lifecycle transitions';
    END IF;
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.id IS DISTINCT FROM OLD.id
       OR NEW.policy_id IS DISTINCT FROM OLD.policy_id
       OR NEW.version IS DISTINCT FROM OLD.version
       OR NEW.scope_key IS DISTINCT FROM OLD.scope_key
       OR NEW.content IS DISTINCT FROM OLD.content
       OR NEW.content_digest IS DISTINCT FROM OLD.content_digest
       OR NEW.registry_version IS DISTINCT FROM OLD.registry_version
       OR NEW.effective_from IS DISTINCT FROM OLD.effective_from
       OR NEW.effective_to IS DISTINCT FROM OLD.effective_to
       OR NEW.maker_actor_ref IS DISTINCT FROM OLD.maker_actor_ref
       OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
       OR NEW.approved_at IS DISTINCT FROM OLD.approved_at
       OR NEW.supersedes_id IS DISTINCT FROM OLD.supersedes_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION 'cg_policy published/approved history is immutable except lifecycle status/published_at progression';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
