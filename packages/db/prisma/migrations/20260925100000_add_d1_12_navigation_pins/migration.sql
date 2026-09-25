-- D1.12 (#451): หมุดแอปของ tenant/ผู้ใช้ และ audit ของหมุดเริ่มต้น
-- tenant isolation (RLS) ติดตั้งใน prisma/rls.sql ตามแบบของตารางอื่น

CREATE TABLE "navigation_tenant_default_pins" (
    "tenant_id" UUID NOT NULL,
    "app_ids" TEXT[] NOT NULL,
    "revision" INTEGER NOT NULL,
    "updated_by_user_id" UUID NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "navigation_tenant_default_pins_pkey" PRIMARY KEY ("tenant_id")
);

CREATE TABLE "navigation_user_pins" (
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "app_ids" TEXT[] NOT NULL,
    "revision" INTEGER NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "navigation_user_pins_pkey" PRIMARY KEY ("tenant_id", "user_id")
);

CREATE TABLE "navigation_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "correlation_id" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "navigation_audit_events_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "navigation_audit_events_tenant_id_created_at_idx" ON "navigation_audit_events"("tenant_id", "created_at");

ALTER TABLE "navigation_tenant_default_pins" ADD CONSTRAINT "navigation_tenant_default_pins_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "navigation_user_pins" ADD CONSTRAINT "navigation_user_pins_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "navigation_audit_events" ADD CONSTRAINT "navigation_audit_events_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- เพดาน 15 หมุด, ไม่ซ้ำ และ revision เริ่มที่ 1 — ด่านสุดท้ายถ้า API พลาด
ALTER TABLE "navigation_tenant_default_pins" ADD CONSTRAINT "navigation_tenant_default_pins_values_check" CHECK (
  cardinality("app_ids") <= 15 AND "revision" >= 1
);
ALTER TABLE "navigation_user_pins" ADD CONSTRAINT "navigation_user_pins_values_check" CHECK (
  cardinality("app_ids") <= 15 AND "revision" >= 1
);
ALTER TABLE "navigation_audit_events" ADD CONSTRAINT "navigation_audit_events_action_check" CHECK (
  "action" IN ('TENANT_DEFAULT_PINS_UPDATED')
);
