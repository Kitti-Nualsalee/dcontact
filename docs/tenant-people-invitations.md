# คำเชิญและ activation ของบัญชี tenant

Authority: [V1-B #704](https://github.com/Kitti-Nualsalee/dcontact/issues/704),
[B3 #710](https://github.com/Kitti-Nualsalee/dcontact/issues/710) และ ADR-035.

## การเปิดใช้งานโดย operator

ค่าเริ่มต้นไม่ส่งคำเชิญและไม่ activate บัญชีอัตโนมัติ ตั้ง
`TENANT_PEOPLE_INVITATIONS_ENABLED=true` เฉพาะ release ที่ผ่าน acceptance ของ B3 แล้ว
พร้อม `TENANT_PEOPLE_BINDINGS_JSON`, `TENANT_PEOPLE_WORKER_DATABASE_URL` และ secrets
แบบ server-only ตาม B2. ค่าอื่นนอกจาก `true`/`false` ถูกปฏิเสธ.
แต่ละ binding ต้องเป็น tenant/Organization ที่ operator อนุมัติ มี service client แบบ narrow authority,
worker principal แบบ NOINHERIT/NOBYPASSRLS ที่ได้รับ binding และ SMTP ที่ readiness ผ่าน.
ไม่ใช้ owner/superuser/application connection แทน worker.

flag นี้ต่อ initial delivery, resend, read-only reconcile และ activation เข้ากับ runtime
ใน main API และ Workspace UAT composition เดียวกัน. Readiness ปิดเมื่อ runtime หยุด,
binding ไม่ตรง หรือ provider ไม่พร้อม; ไม่ถือว่า config มีอยู่เท่ากับ runtime พร้อม.
activation poll ข้ามบัญชีที่ยังมี resend ไม่จบ และเว้นอย่างน้อยหนึ่งนาทีหลัง probe ล่าสุด
เพื่อลดการอ่านบัญชี pending ซ้ำ. การ activate ต้องใช้ fresh provider proof และ claim อายุ 30 วินาที,
CAS ทั้ง config/lifecycle revision และบันทึก receipt/audit ใน transaction เดียว.

## พฤติกรรมของ Admin และผู้ใช้

Console แสดง provisioning, delivery และ activation แยกกัน. Admin ต้องระบุเหตุผล
ก่อน resend หรือ reconcile. SENT/FAILED/EXPIRED ที่ยัง pending ส่งรุ่นใหม่ได้เมื่อ server อนุญาต;
DISPATCHING/AMBIGUOUS ตรวจหลักฐานอย่างเดียว ไม่ปลดให้ resend เพราะ lease หมด.
server จำกัด 3 resends ต่อ rolling 60 นาที ไม่นับ initial send และ serialize ที่ DB/provider.

หลังส่งคำสั่ง Console เก็บเฉพาะ command/operation reference ใน sessionStorage แยกตาม
identity/tenant/user. response หายหรือ reload ให้อ่านคำสั่งเดิม ไม่สร้าง command ใหม่
หรือ POST ซ้ำอัตโนมัติ. ไม่มี action link/password/TOTP ใน Console, application DB,
audit หรือหลักฐาน. ผู้ใช้เปิดอีเมลและทำ required actions ด้วยตนเอง; การ activate
ไม่สร้าง SIP credential/work lease และไม่เปิด AVAILABLE แทนผู้ใช้.

## ตรวจและ rollback

รัน `pnpm voice:tenant-people:boundary` บน dev/CI ที่มี Docker และ Chromium ของ Console.
ชุดนี้ใช้ Keycloak/PostgreSQL/Mailpit แยก, รับอีเมลจริงใน sandbox และให้ browser ทำ
required actions/PKCE login โดยไม่บันทึก trace, screenshot, action link หรือ credential.
รัน Console browser specs `tenant-people*.spec.ts`, API/Console typecheck/build,
`pnpm test:d1-i18n` และ `pnpm e1:auth:boundary` ตาม acceptance ก่อน merge.

หากต้องหยุด admission ให้ปิด flag และหยุด runtime อย่าง graceful เพื่อรอ in-flight work.
เก็บ additive ledgers และ domain state เดิม; ไม่ลบ attempts/receipts, down-migrate,
reset credential หรือ restore shared Keycloak DB เพื่อย้อนผู้ใช้รายคน.
proof/SMTP outcome ไม่ชัดให้คง local deny/ambiguity และ read-only reconcile;
ห้ามส่งซ้ำหรือเปิด ACTIVE โดยเดา. การปิด flag ไม่ถอน activation ที่ commit แล้ว.
