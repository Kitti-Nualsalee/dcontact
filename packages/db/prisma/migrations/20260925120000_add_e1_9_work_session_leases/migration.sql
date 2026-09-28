-- E1.9 (#483): agent work-session lease — จุดรับงานเดียวต่อ agent ต่อ tenant ครอบทุก surface
-- (E1.3 #459, Phase Contract #464; ADR-026 ข้อ 2)

CREATE TABLE "agent_work_session_leases" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "surface" TEXT NOT NULL,
    "host_origin" TEXT,
    "acquired_at" TIMESTAMP(3) NOT NULL,
    "heartbeat_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3) NOT NULL,
    "released_at" TIMESTAMP(3),
    "release_reason" TEXT,

    CONSTRAINT "agent_work_session_leases_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "agent_work_session_leases" ADD CONSTRAINT "agent_work_session_leases_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_work_session_leases" ADD CONSTRAINT "agent_work_session_leases_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- surface ที่รู้จัก; embedded ต้องมี host origin แบบ https exact (ไม่มี path) และ surface อื่นต้องไม่มี
ALTER TABLE "agent_work_session_leases" ADD CONSTRAINT "agent_work_session_leases_values_check" CHECK (
  "surface" IN ('workspace', 'dphone', 'embedded')
  AND (("surface" = 'embedded') = ("host_origin" IS NOT NULL))
  AND ("host_origin" IS NULL OR "host_origin" ~ '^https://[a-z0-9.-]+(:[0-9]{1,5})?$')
  AND "expires_at" > "acquired_at"
  AND (("released_at" IS NULL) = ("release_reason" IS NULL))
  AND ("release_reason" IS NULL OR "release_reason" IN ('released', 'takeover', 'expired', 'auth_revoked'))
);

-- บังคับ "lease ที่ยังไม่ปล่อยได้แค่อันเดียวต่อ agent ต่อ tenant" ที่ชั้น DB (กัน race ระหว่าง API หลาย instance)
CREATE UNIQUE INDEX "agent_work_session_leases_one_open"
  ON "agent_work_session_leases" ("tenant_id", "user_id") WHERE "released_at" IS NULL;
CREATE INDEX "agent_work_session_leases_expiry_idx"
  ON "agent_work_session_leases" ("expires_at") WHERE "released_at" IS NULL;

-- audit ของ lease (ขอ/ย้าย/ปล่อย/หมดอายุ) — append-only สำหรับ role ของแอป
CREATE TABLE "agent_work_session_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "lease_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "surface" TEXT NOT NULL,
    "host_origin" TEXT,
    "previous_lease_id" UUID,
    "previous_surface" TEXT,
    "requeued_interaction_count" INTEGER NOT NULL DEFAULT 0,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_work_session_events_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "agent_work_session_events" ADD CONSTRAINT "agent_work_session_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "agent_work_session_events" ADD CONSTRAINT "agent_work_session_events_values_check" CHECK (
  "action" IN ('ACQUIRED', 'TAKEOVER', 'RELEASED', 'EXPIRED', 'AUTH_REVOKED')
  AND "surface" IN ('workspace', 'dphone', 'embedded')
  AND ("previous_surface" IS NULL OR "previous_surface" IN ('workspace', 'dphone', 'embedded'))
  AND "requeued_interaction_count" >= 0
);
CREATE INDEX "agent_work_session_events_tenant_idx"
  ON "agent_work_session_events" ("tenant_id", "occurred_at");

-- flag `workSession.lease.enforced` ใช้ตาราง flag ระดับ tenant เดิม (ไม่มีแถว = ปิด)
ALTER TABLE "tenant_ui_flags" DROP CONSTRAINT "tenant_ui_flags_values_check";
ALTER TABLE "tenant_ui_flags" ADD CONSTRAINT "tenant_ui_flags_values_check" CHECK (
  "flag_key" IN ('ui.shell.v2', 'workSession.lease.enforced') AND length(btrim("reason")) BETWEEN 3 AND 500
);
ALTER TABLE "tenant_ui_flag_audit_events" DROP CONSTRAINT "tenant_ui_flag_audit_events_values_check";
ALTER TABLE "tenant_ui_flag_audit_events" ADD CONSTRAINT "tenant_ui_flag_audit_events_values_check" CHECK (
  "flag_key" IN ('ui.shell.v2', 'workSession.lease.enforced') AND length(btrim("reason")) BETWEEN 3 AND 500
);
