-- E1.14 (#488): ระดับข้อมูล screen-pop ต่อ origin (E1.6 #462 ข้อ 1) — ค่าเริ่มต้นปิด
-- `custom` ยังไม่เปิดให้ตั้งจนกว่ารายการ field ที่ระบบกำหนดจะถูกตัดสิน (decision gap ที่ #464)
ALTER TABLE "tenant_embed_origins" ADD COLUMN "screen_pop_level" TEXT NOT NULL DEFAULT 'off';
ALTER TABLE "tenant_embed_origins" ADD CONSTRAINT "tenant_embed_origins_screen_pop_level_check" CHECK (
  "screen_pop_level" IN ('off', 'ids', 'contact')
);

-- การเปิดหรือเปลี่ยนระดับต้องมีเหตุผลและ audit (E1.6 ข้อ 1, 5)
ALTER TABLE "tenant_embed_origin_audit_events" DROP CONSTRAINT "tenant_embed_origin_audit_events_values_check";
ALTER TABLE "tenant_embed_origin_audit_events" ADD CONSTRAINT "tenant_embed_origin_audit_events_values_check" CHECK (
  "action" IN ('CREATED', 'UPDATED', 'DISABLED', 'ENABLED', 'DELETED', 'SCREEN_POP_CHANGED')
  AND ("reason" IS NULL OR length("reason") <= 500)
  AND ("action" <> 'SCREEN_POP_CHANGED' OR length(btrim("reason")) >= 3)
);
