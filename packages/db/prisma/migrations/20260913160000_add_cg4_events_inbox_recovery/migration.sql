-- CG4.6 (#189): canonical event propagation, consumer inbox projection and scope-level
-- recovery state. Additive: no existing table changes shape, and the outbox only gains a
-- terminal state it never entered before.

-- An event whose contract/schema/registry version this build cannot interpret, or whose
-- payload leaked a restricted field, must not be published and must not be retried —
-- retrying would republish the same bad payload forever (#179 §4/§7).
ALTER TYPE "CgEventOutboxState" ADD VALUE IF NOT EXISTS 'QUARANTINED' AFTER 'FAILED';

CREATE TYPE "CgInboxState" AS ENUM (
  'APPLIED', 'DUPLICATE', 'GAP_HELD', 'OUT_OF_ORDER', 'QUARANTINED', 'UNSUPPORTED'
);
CREATE TYPE "CgScopePauseKind" AS ENUM ('CONTACT', 'POLICY_SCOPE');
CREATE TYPE "CgScopePauseReason" AS ENUM (
  'EVENT_GAP', 'EVENT_OUT_OF_ORDER', 'HASH_CONFLICT', 'UNSUPPORTED_CONTRACT'
);
CREATE TYPE "CgScopePauseState" AS ENUM ('ACTIVE', 'CLEARED');

-- ── cg_consumer_inbox ────────────────────────────────────────────────────────
CREATE TABLE "cg_consumer_inbox" (
  "id"                UUID NOT NULL,
  "tenant_id"         UUID NOT NULL,
  "consumer_group"    TEXT NOT NULL,
  "event_id"          UUID NOT NULL,
  "aggregate_type"    "CgAggregateType" NOT NULL,
  "aggregate_id"      UUID NOT NULL,
  "aggregate_version" INTEGER NOT NULL,
  "event_type"        TEXT NOT NULL,
  "payload_hash"      CHAR(64) NOT NULL,
  "state"             "CgInboxState" NOT NULL,
  "detail"            TEXT,
  "received_at"       TIMESTAMP(3) NOT NULL,
  "created_at"        TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cg_consumer_inbox_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_consumer_inbox_hash_check" CHECK ("payload_hash" ~ '^[a-f0-9]{64}$'),
  CONSTRAINT "cg_consumer_inbox_version_check" CHECK ("aggregate_version" >= 0)
);

CREATE UNIQUE INDEX "cg_consumer_inbox_tenant_id_id_key" ON "cg_consumer_inbox"("tenant_id", "id");
-- The eventId-level key is what makes at-least-once redelivery a cheap no-op instead of
-- an ordering anomaly: a redelivered event never reaches the version comparison.
CREATE UNIQUE INDEX "cg_consumer_inbox_group_event_key"
  ON "cg_consumer_inbox"("tenant_id", "consumer_group", "event_id");
CREATE INDEX "cg_consumer_inbox_cursor_idx"
  ON "cg_consumer_inbox"("tenant_id", "consumer_group", "aggregate_type", "aggregate_id", "aggregate_version");
CREATE INDEX "cg_consumer_inbox_state_idx"
  ON "cg_consumer_inbox"("tenant_id", "consumer_group", "state");

ALTER TABLE "cg_consumer_inbox" ADD CONSTRAINT "cg_consumer_inbox_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── cg_scope_pause ───────────────────────────────────────────────────────────
CREATE TABLE "cg_scope_pause" (
  "id"                 UUID NOT NULL,
  "tenant_id"          UUID NOT NULL,
  "consumer_group"     TEXT NOT NULL,
  "scope_kind"         "CgScopePauseKind" NOT NULL,
  "scope_ref"          TEXT NOT NULL,
  "state"              "CgScopePauseState" NOT NULL DEFAULT 'ACTIVE',
  "reason"             "CgScopePauseReason" NOT NULL,
  "detail"             TEXT,
  "event_id"           UUID,
  "observed_version"   INTEGER,
  "expected_version"   INTEGER,
  "paused_at"          TIMESTAMP(3) NOT NULL,
  "cleared_at"         TIMESTAMP(3),
  "cleared_to_version" INTEGER,
  "created_at"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "cg_scope_pause_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cg_scope_pause_cleared_check"
    CHECK (("state" = 'ACTIVE' AND "cleared_at" IS NULL) OR ("state" = 'CLEARED' AND "cleared_at" IS NOT NULL))
);

CREATE UNIQUE INDEX "cg_scope_pause_tenant_id_id_key" ON "cg_scope_pause"("tenant_id", "id");
-- At most one open pause per scope per consumer group: a second anomaly on an already
-- paused scope updates the existing hold rather than stacking a new one.
CREATE UNIQUE INDEX "cg_scope_pause_one_active_per_scope"
  ON "cg_scope_pause"("tenant_id", "consumer_group", "scope_kind", "scope_ref")
  WHERE "state" = 'ACTIVE';
CREATE INDEX "cg_scope_pause_lookup_idx"
  ON "cg_scope_pause"("tenant_id", "consumer_group", "scope_kind", "scope_ref", "state");
CREATE INDEX "cg_scope_pause_open_idx" ON "cg_scope_pause"("tenant_id", "state", "paused_at");

ALTER TABLE "cg_scope_pause" ADD CONSTRAINT "cg_scope_pause_tenant_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ── RLS and grants ───────────────────────────────────────────────────────────
ALTER TABLE "cg_consumer_inbox" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "cg_scope_pause" ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON "cg_consumer_inbox";
CREATE POLICY tenant_isolation ON "cg_consumer_inbox"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

DROP POLICY IF EXISTS tenant_isolation ON "cg_scope_pause";
CREATE POLICY tenant_isolation ON "cg_scope_pause"
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

GRANT SELECT, INSERT ON "cg_consumer_inbox" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "cg_scope_pause" TO dcontact_app;

-- The inbox is the completion record for at-least-once delivery, so a row must never be
-- rewritten or removed; a pause advances state but its history stays.
REVOKE UPDATE, DELETE ON "cg_consumer_inbox" FROM dcontact_app;
REVOKE DELETE ON "cg_scope_pause" FROM dcontact_app;
