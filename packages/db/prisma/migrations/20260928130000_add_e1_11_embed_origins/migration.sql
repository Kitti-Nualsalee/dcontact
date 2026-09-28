-- E1.11 (#485): allowlist ของ origin ที่ tenant อนุญาตให้ฝัง dphone (E1.5 #461)

CREATE TABLE "tenant_embed_origins" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "origin" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "tenant_embed_origins_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "tenant_embed_origins" ADD CONSTRAINT "tenant_embed_origins_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE UNIQUE INDEX "tenant_embed_origins_tenant_origin_key" ON "tenant_embed_origins" ("tenant_id", "origin");
-- รูปแบบที่ normalize แล้วเท่านั้น (ตัวตัดสินจริงอยู่ที่ API — ชั้นนี้กันข้อมูลหลุดรูปแบบ)
ALTER TABLE "tenant_embed_origins" ADD CONSTRAINT "tenant_embed_origins_values_check" CHECK (
  "origin" ~ '^(https://[a-z0-9.-]+(:[0-9]{1,5})?|http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?)$'
  AND length(btrim("label")) BETWEEN 1 AND 80
  AND "revision" >= 1
);

-- สูงสุด 10 origin ต่อ tenant บังคับที่ชั้น DB ด้วย (API ล็อก tenant ก่อนนับอยู่แล้ว)
CREATE FUNCTION "tenant_embed_origins_limit"() RETURNS trigger AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('tenant_embed_origins:' || NEW.tenant_id::text));
  IF (SELECT count(*) FROM tenant_embed_origins WHERE tenant_id = NEW.tenant_id) >= 10 THEN
    RAISE EXCEPTION 'EMBED_ORIGIN_LIMIT_REACHED' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "tenant_embed_origins_limit" BEFORE INSERT ON "tenant_embed_origins"
  FOR EACH ROW EXECUTE FUNCTION "tenant_embed_origins_limit"();

-- audit ค่าก่อน/หลังของทุกการเพิ่ม แก้ ปิด/เปิด และลบ — append-only สำหรับ role ของแอป
CREATE TABLE "tenant_embed_origin_audit_events" (
    "id" UUID NOT NULL,
    "tenant_id" UUID NOT NULL,
    "origin_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "actor_user_id" UUID NOT NULL,
    "reason" TEXT,
    "correlation_id" TEXT NOT NULL,
    "occurred_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tenant_embed_origin_audit_events_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "tenant_embed_origin_audit_events" ADD CONSTRAINT "tenant_embed_origin_audit_events_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "tenant_embed_origin_audit_events" ADD CONSTRAINT "tenant_embed_origin_audit_events_values_check" CHECK (
  "action" IN ('CREATED', 'UPDATED', 'DISABLED', 'ENABLED', 'DELETED')
  AND ("reason" IS NULL OR length("reason") <= 500)
);
CREATE INDEX "tenant_embed_origin_audit_events_tenant_idx"
  ON "tenant_embed_origin_audit_events" ("tenant_id", "occurred_at");

-- flag `dphone.embed.enabled` ใช้ตาราง flag ระดับ tenant เดิม (ไม่มีแถว = ปิด)
ALTER TABLE "tenant_ui_flags" DROP CONSTRAINT "tenant_ui_flags_values_check";
ALTER TABLE "tenant_ui_flags" ADD CONSTRAINT "tenant_ui_flags_values_check" CHECK (
  "flag_key" IN ('ui.shell.v2', 'workSession.lease.enforced', 'dphone.embed.enabled')
  AND length(btrim("reason")) BETWEEN 3 AND 500
);
ALTER TABLE "tenant_ui_flag_audit_events" DROP CONSTRAINT "tenant_ui_flag_audit_events_values_check";
ALTER TABLE "tenant_ui_flag_audit_events" ADD CONSTRAINT "tenant_ui_flag_audit_events_values_check" CHECK (
  "flag_key" IN ('ui.shell.v2', 'workSession.lease.enforced', 'dphone.embed.enabled')
  AND length(btrim("reason")) BETWEEN 3 AND 500
);

-- lease ของ surface embedded ถูกปล่อยเมื่อ origin ถูกปิด/ลบ (หลังจบงาน — E1.5 ข้อ 3)
ALTER TABLE "agent_work_session_leases" DROP CONSTRAINT "agent_work_session_leases_values_check";
ALTER TABLE "agent_work_session_leases" ADD CONSTRAINT "agent_work_session_leases_values_check" CHECK (
  "surface" IN ('workspace', 'dphone', 'embedded')
  AND (("surface" = 'embedded') = ("host_origin" IS NOT NULL))
  AND ("host_origin" IS NULL OR "host_origin" ~ '^(https://[a-z0-9.-]+(:[0-9]{1,5})?|http://(localhost|127\.0\.0\.1)(:[0-9]{1,5})?)$')
  AND "expires_at" > "acquired_at"
  AND (("released_at" IS NULL) = ("release_reason" IS NULL))
  AND ("release_reason" IS NULL OR "release_reason" IN ('released', 'takeover', 'expired', 'auth_revoked', 'origin_revoked'))
);
ALTER TABLE "agent_work_session_events" DROP CONSTRAINT "agent_work_session_events_values_check";
ALTER TABLE "agent_work_session_events" ADD CONSTRAINT "agent_work_session_events_values_check" CHECK (
  "action" IN ('ACQUIRED', 'TAKEOVER', 'RELEASED', 'EXPIRED', 'AUTH_REVOKED', 'ORIGIN_REVOKED')
  AND "surface" IN ('workspace', 'dphone', 'embedded')
  AND ("previous_surface" IS NULL OR "previous_surface" IN ('workspace', 'dphone', 'embedded'))
  AND "requeued_interaction_count" >= 0
);
