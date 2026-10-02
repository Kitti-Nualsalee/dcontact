-- E1.18 (#520): control plane ของ Voice แยกจาก Dialer/LINE และ default-off.
CREATE TYPE "DlVoiceRolloutState" AS ENUM ('DISABLED', 'DRY_RUN', 'SANDBOX', 'CAPPED_PILOT');
CREATE TABLE "dl_voice_scope_gates" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "telephony_node_id" TEXT NOT NULL, "business_state" "DlVoiceRolloutState" NOT NULL DEFAULT 'DISABLED',
  "technical_switch_on" BOOLEAN NOT NULL DEFAULT false, "killed" BOOLEAN NOT NULL DEFAULT false,
  "cap_per_minute" INTEGER NOT NULL DEFAULT 1, "cap_per_day" INTEGER NOT NULL DEFAULT 10,
  "version" INTEGER NOT NULL DEFAULT 0, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "dl_voice_scope_gates_shape" CHECK ("telephony_node_id" ~ '^[A-Za-z0-9_.-]{1,128}$' AND "cap_per_minute" > 0 AND "cap_per_day" > 0)
);
CREATE UNIQUE INDEX "dl_voice_scope_gates_tenant_node_key" ON "dl_voice_scope_gates"("tenant_id", "telephony_node_id");
CREATE UNIQUE INDEX "dl_voice_scope_gates_tenant_id_key" ON "dl_voice_scope_gates"("tenant_id", "id");
CREATE TABLE "dl_voice_allowlist_entries" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "gate_id" UUID NOT NULL, "agent_user_id" UUID NOT NULL, "target_identity_id" UUID NOT NULL,
  "valid_from" TIMESTAMP(3) NOT NULL, "valid_until" TIMESTAMP(3) NOT NULL, "revoked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_voice_allowlist_window" CHECK ("valid_until" > "valid_from"),
  CONSTRAINT "dl_voice_allowlist_gate_fkey" FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "dl_voice_scope_gates"("tenant_id", "id") ON DELETE RESTRICT
);
CREATE UNIQUE INDEX "dl_voice_allowlist_tuple_key" ON "dl_voice_allowlist_entries"("tenant_id", "gate_id", "agent_user_id", "target_identity_id");
CREATE INDEX "dl_voice_allowlist_active_idx" ON "dl_voice_allowlist_entries"("tenant_id", "gate_id", "valid_until");
CREATE TABLE "dl_voice_cap_ledger" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL, "gate_id" UUID NOT NULL, "delivery_id" TEXT NOT NULL, "adapter" "DlDeliveryAdapter" NOT NULL DEFAULT 'FREESWITCH_ORIGINATE',
  "reserved_at" TIMESTAMP(3) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_voice_cap_ledger_gate_fkey" FOREIGN KEY ("tenant_id", "gate_id") REFERENCES "dl_voice_scope_gates"("tenant_id", "id") ON DELETE RESTRICT,
  CONSTRAINT "dl_voice_cap_ledger_delivery_fkey" FOREIGN KEY ("tenant_id", "delivery_id", "adapter") REFERENCES "dl_outbox_entries"("tenant_id", "delivery_id", "adapter")
);
CREATE UNIQUE INDEX "dl_voice_cap_ledger_delivery_key" ON "dl_voice_cap_ledger"("tenant_id", "delivery_id");
CREATE INDEX "dl_voice_cap_ledger_window_idx" ON "dl_voice_cap_ledger"("tenant_id", "gate_id", "reserved_at");

CREATE TABLE "dl_voice_audit_events" (
  "id" UUID PRIMARY KEY, "tenant_id" UUID NOT NULL REFERENCES "tenants"("id") ON DELETE RESTRICT,
  "event_id" TEXT NOT NULL, "code" TEXT NOT NULL, "actor_ref" TEXT NOT NULL, "subject_id" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dl_voice_audit_shape" CHECK ("event_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$' AND "code" ~ '^[A-Z0-9_]{1,96}$' AND "actor_ref" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$')
);
CREATE UNIQUE INDEX "dl_voice_audit_events_event_key" ON "dl_voice_audit_events"("tenant_id", "event_id");
CREATE INDEX "dl_voice_audit_events_timeline_idx" ON "dl_voice_audit_events"("tenant_id", "occurred_at");

ALTER TABLE "dl_voice_scope_gates" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dl_voice_allowlist_entries" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dl_voice_cap_ledger" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "dl_voice_audit_events" ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "dl_voice_scope_gates" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "dl_voice_allowlist_entries" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "dl_voice_cap_ledger" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_isolation ON "dl_voice_audit_events" USING (tenant_id = current_setting('app.tenant_id', true)::uuid) WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
GRANT SELECT, INSERT, UPDATE ON "dl_voice_scope_gates" TO dcontact_app;
GRANT SELECT, INSERT, UPDATE ON "dl_voice_allowlist_entries" TO dcontact_app;
GRANT SELECT, INSERT ON "dl_voice_cap_ledger" TO dcontact_app;
GRANT SELECT, INSERT ON "dl_voice_audit_events" TO dcontact_app;
REVOKE DELETE ON "dl_voice_scope_gates", "dl_voice_allowlist_entries", "dl_voice_cap_ledger", "dl_voice_audit_events" FROM dcontact_app;
