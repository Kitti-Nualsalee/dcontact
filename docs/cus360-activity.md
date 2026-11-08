# กิจกรรม Customer 360

Console อ่าน `GET /api/v1/customer-360/activity` ผ่านสิทธิ์ Tenant Admin ปัจจุบัน ส่วนกิจกรรมโปรไฟล์และการเพิ่มหรือถอดแท็กจะอ่านได้เมื่อยังมีสิทธิ์ VIEW ลูกค้ารายนั้น การแบ่งหน้าใช้ `CUSTOMER_360_CURSOR_KEYS` ชุดเดียวกับ Customer 360 และตรวจสิทธิ์ใหม่ทุกครั้ง

API ฉายเหตุการณ์จาก append-only audit โดยคืนเวลา ชนิดเหตุการณ์ รหัสรายการที่อ่านได้ และชื่อฟิลด์ที่เปลี่ยน ผู้ดำเนินการแสดงว่าไม่ทราบจนมีแหล่งข้อมูลย้อนหลังที่อนุญาตให้เผยแพร่ การเพิ่มและถอดแท็กใช้เหตุการณ์แยกกันเมื่อคำสั่งมีผลจริง เหตุการณ์ `CONTACT_TAGS_UPDATE` เดิมไม่ระบุทิศทาง จึงไม่มีการฉายย้อนหลังเป็นเหตุการณ์เพิ่มหรือถอด

ความครอบคลุมเริ่มที่ `UNKNOWN` ผู้ดูแล release ส่งหลักฐานที่ตรวจ producer, retention และความต่อเนื่องแล้วผ่าน `C360_ACTIVITY_EVIDENCE_MANIFEST` ตอนเริ่ม API รูปแบบเป็น JSON object ที่มี `version` เท่ากับ `c360-activity-v1` และ `entries` แต่ละ entry ระบุ `tenantId`, `from`, `to`, `types`, `sourceVersion` และ `evidenceRef` โดยใช้เวลา ISO 8601 พร้อม timezone, ชนิดเหตุการณ์ใน public allowlist และรหัสหลักฐานสาธารณะแบบ opaque ที่ขึ้นต้นด้วย `ev_` ช่วงที่ manifest ไม่ครอบคลุมจะแสดงเป็น gap เหตุการณ์ที่ฉายไม่ได้ในช่วงที่อ่านได้ทำให้สถานะลดเป็น `UNKNOWN` ควรใช้ค่า manifest เดียวกันทุก API instance ของ release

ทำซ้ำ local trial ด้วย `pnpm --filter @d-contact/api test:customer-activity:dev-sandbox` ชุดนี้ใช้ PostgreSQL/RLS และ Keycloak แยกพร้อมข้อมูลสังเคราะห์
