-- D1.13 (#452): UI flag ระดับ tenant (`ui.shell.v2`) + audit
-- tenant isolation และสิทธิ์ของ role อยู่ใน prisma/rls.sql

CREATE TABLE "tenant_ui_flags" (
    "tenant_id" UUID NOT NULL,
    "flag_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "updated_by_actor" TEXT NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_ui_flags_pkey" PRIMARY KEY ("tenant_id", "flag_key")
);

CREATE TABLE "tenant_ui_flag_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "flag_key" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "reason" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tenant_ui_flag_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "tenant_ui_flag_audit_events_tenant_id_created_at_idx" ON "tenant_ui_flag_audit_events"("tenant_id", "created_at");

ALTER TABLE "tenant_ui_flags" ADD CONSTRAINT "tenant_ui_flags_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_ui_flag_audit_events" ADD CONSTRAINT "tenant_ui_flag_audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- flag ที่รู้จักเท่านั้น และต้องมีเหตุผลเสมอ (การเปิด shell ใหม่ผูกกับ gate ของ #77)
ALTER TABLE "tenant_ui_flags" ADD CONSTRAINT "tenant_ui_flags_values_check" CHECK (
  "flag_key" IN ('ui.shell.v2') AND length(btrim("reason")) BETWEEN 3 AND 500
);
ALTER TABLE "tenant_ui_flag_audit_events" ADD CONSTRAINT "tenant_ui_flag_audit_events_values_check" CHECK (
  "flag_key" IN ('ui.shell.v2') AND length(btrim("reason")) BETWEEN 3 AND 500
);
