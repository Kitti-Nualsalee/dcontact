-- J2.9 (#137): แถว rollout state ต้องลบไม่ได้ด้วย application role
--
-- trigger ob_originate_rollout_guard ปิดทางยก kill ผ่าน UPDATE ไว้แล้ว แต่ DELETE เป็นช่องทางอ้อม:
-- ลบแถวที่ถูก kill ทิ้ง แล้ว gate จะสร้างแถวใหม่เป็น DISABLED ให้เองตอนอ่านครั้งถัดไป เท่ากับยก
-- kill switch ซึ่ง #124 ห้ามไว้ — owner ยังลบได้ตอน teardown/retention แบบเดียวกับ audit
REVOKE DELETE ON "ob_originate_rollout_state" FROM dcontact_app;

-- allowlist เพิ่มด้วย INSERT และถอนด้วย DELETE เท่านั้น (ทั้งสองทางเขียน audit) — UPDATE จะเปลี่ยน
-- scope_ref ของแถวเดิมได้โดยไม่มีหลักฐานว่าใครขยาย allowlist
REVOKE UPDATE ON "ob_originate_rollout_scopes" FROM dcontact_app;
