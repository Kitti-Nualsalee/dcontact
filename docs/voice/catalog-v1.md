# B1 — คิวและ skill ผ่าน Console

Authority คือ [สเปก V1-B](https://github.com/Kitti-Nualsalee/dcontact/issues/704) และ [B1 สร้างคิวและ skill](https://github.com/Kitti-Nualsalee/dcontact/issues/708)

เปิด Console ที่ `/?view=voice-routing&tenant=<tenant-alias>` แล้วใช้เมนูการกระจายงาน → คิว Voice หรือทักษะ ตัวเลือกทีมอ่านจาก API จริง Admin สร้างรายการและ reload ดูรายละเอียดได้ Supervisor อ่านเฉพาะ active team ของตน Agent ไม่มีหน้า/API นี้ หน้า Console ไม่ขอ lease/SIP หรือเชื่อม routing WebSocket

คิวใหม่เริ่ม inactive มี `voiceConfigVersion=1` แยกจาก `voiceWrapupPolicy=VOICE_NOTE_V1` ของ A นโยบายเมื่อเปิด runtime คือ offer 20 วินาที รอรวม 60 วินาทีแล้ว HANGUP แต่ B1 ยังไม่เปิด managed routing จึงไม่ใช่หลักฐานทดสอบสายหรือ VM UAT

## เตรียมสภาพแวดล้อม

- ใช้ additive migration และ `pnpm db:rls` ก่อนรัน API รุ่นนี้ ทั้ง default และ uat-workspace mount เฉพาะ catalog ที่ทำแล้ว uat-e1 ไม่เพิ่ม catalog
- operator เตรียม tenant, active team และ bootstrap/enrollment ของบัญชี tenant ตามขั้นตอนด้านล่าง บัญชีที่มีเพียง domain role/Org mapping ยังเข้า B ไม่ได้; legacy API ของ A ใช้ policy เดิม
- หลังรวมการแก้ history จาก main หน้า Voice/History ต้องผ่าน production auth root โดยไม่บังคับ Interaction context เมนูคิว/skill ไฮไลต์และสลับหน้าในเอกสารเดิมได้ เมื่อ shell ปิดหรือ API รุ่นเก่าให้ใช้เมนูภายในหน้า
- operator เขียน `TenantVoiceProvisioningPolicy` ด้วยบัญชี operator ของฐานข้อมูลตามกระบวนการ configuration ที่อนุมัติแล้วเท่านั้น ต้องระบุ caps ทั้ง 4 ค่า (0–1,000,000), revision, sourceKind, approvedByOperatorSubject, approvedAt, approvalRef และ reason ไม่มีค่า unlimited โดยปริยาย
- เมื่อมี TenantPlanBinding ให้ pin sourceKind=PLAN_SNAPSHOT และ sourcePlanDigest เท่ากับ binding.snapshotDigest; UAT_EXPLICIT ใช้เมื่อไม่มี binding เปลี่ยน binding แล้ว policy ยังไม่ตรงจะหยุด create ด้วย RESOURCE_POLICY_STALE ไม่เดา quota จาก entitlements JSON
- ตาราง policy ไม่ให้ application role INSERT/UPDATE/DELETE การเปลี่ยนต้องเพิ่ม revision ทีละหนึ่ง เก็บ policy audit พร้อมกัน และใช้ config fence/idle guard; ไม่มีหน้าแก้ caps ใน browser
- operator ไม่สร้าง business queue/skill แทน UI และไม่มีการลงทะเบียน ID ของคิว/skill ทีละรายการ

## Bootstrap identity authority ก่อนเปิด B

ใช้ `tenant_voice_identity_bindings` เป็น positive binding ของบัญชีเดิมเท่านั้น ไม่ auto-enroll จาก token, email, username หรือ Org บัญชีใหม่ของ B2 ต้องได้ authority จาก verified lifecycle/correlation/receipts โดยอัตโนมัติ ไม่ให้ operator ลงทะเบียนบัญชีใหม่รายคน

operator ทำตามนี้ในสภาพแวดล้อมที่ได้รับอนุญาตก่อนเขียน binding ด้วย DB operator (B1 ไม่รันขั้นตอนนี้บน VM):

1. อ่าน bootstrap manifest จริงหรือ explicit enrollment evidence ที่อนุมัติ เก็บ reference และ SHA-256 ของหลักฐาน ตรวจ tenant UUID/slug, issuer, Keycloak subject, domain user UUID, Org UUID และ Console client ของ deployment ให้ตรงกัน ห้ามใช้ค่าจาก request เพื่อรับรองตัวเอง
2. ตรวจ Keycloak ด้วย operator authority: Org ยัง enabled และสมาชิกของ subject ทั้งหมดมีเพียง Org นี้; ตรวจ user representation/service-account link, reserved platform subjects จากทะเบียน operator และ effective realm/client-role mappings รวม composite/inherited roles ทั้งหมด ห้ามมี platform/service/realm-management privilege แม้ tenant membership ถูกผูกผิดตาม #685 ห้ามล้าง role/ย้าย Org เพื่อให้ผ่าน และไม่ใช้ roles ใน access token ซึ่งอาจถูก scope กรองแทนการตรวจนี้
3. ตรวจ domain User.keycloakId ตรง subject, active role/team และ claims จาก Console session จริงมี verified issuer/sub/azp, tenant UUID/slug และ Org context ตรง deployment; token ไม่จำเป็นต้องมี Org UUID จึงไม่เดา claim field นั้น หากมี `dc_identity_class` ต้องเป็น `TENANT_USER` เท่านั้น
4. บันทึก binding `identity_class=TENANT_USER`, `source_kind=BOOTSTRAP_MANIFEST` หรือ `VERIFIED_ENROLLMENT`, evidence reference/digest, verified operator subject/time, revision=1 และ is_active ตามผลจริง การให้สิทธิ์นี้เป็นการรับรองของ operator ที่ตรวจหลักฐานแล้ว ห้ามคัดลอก fixture ของ test ไปใช้เป็นหลักฐานจริง
5. เปลี่ยนหรือ revoke binding ต้องเพิ่ม revision ทีละหนึ่งและรอ tenant Voice idle; DB ใช้ exclusive try-fence/User NOWAIT และเก็บ snapshot audit พร้อมกัน ทุก API/navigation ตรวจ binding active, live User.keycloakId/role/team และ verified issuer/sub/client/tenant ใหม่เสมอ ไม่มี binding หรือ mismatch ตอบ 403/ซ่อนเมนู การเปลี่ยนไม่แก้ credentials หรือเปิดสิทธิ์ให้ API รุ่นเดิม

application role มีเพียง SELECT ของ binding/audit พร้อม RLS ไม่มี endpoint enroll หรือ client flag ข้าม gate นี้ การยังไม่มี binding บน VM เป็น readiness blocker ที่ต้องแก้ด้วยหลักฐานจริงก่อน B7 ไม่ใช่เหตุให้ใช้ denylist อย่างเดียว

## API ที่ B1 เปิด

namespace `/api/v1/tenant-voice`: GET capabilities, teams, queues, skills, queues/:id, skills/:id, commands/:commandId และ POST queues/skills ทุก mutation ใช้ commandId UUID จาก browser actor/tenant มาจาก verified request เท่านั้น

create ส่ง name/teamId และ skill เพิ่ม code uppercase ตามสเปก server normalize ชื่อและบันทึก descriptor → resource/policy → audit → receipt ใน transaction เดียว ผล POST เป็น 201 ของ committed resource UI อ่าน GET detail ซ้ำก่อนแจ้งสำเร็จ

เมื่อ POST ตอบไม่ชัดเจน หน้าเดิมคง intent และปิด create ใหม่ โดยเก็บเฉพาะ commandId ใน sessionStorage แยกตาม identity/ชนิดทรัพยากร จึง reload แล้วตรวจผลเดิมได้ ไม่มีชื่อหรือ payload ใน storage ให้กด “ตรวจผลคำสั่งเดิม” ซึ่ง lookup command แล้ว GET detail ไม่สร้าง POST ใหม่โดยอัตโนมัติ command ที่ยังไม่พบยังไม่ยืนยันว่าไม่เคยรับคำสั่ง ห้ามใช้การเปลี่ยน commandId เพื่อหลบ unknown state

รายการใช้ keyset createdAt/id default 20/max 100 cursor ผูก actor/tenant/live role+team/filter การเปลี่ยนสิทธิ์ทำให้ cursor เดิมใช้ไม่ได้ legacy skill code/team=null แสดงอ่านอย่างเดียว

legacy queue APIs ไม่แสดงหรือแก้ managed queue ข้าม coordinator; Supervisor live queue availability ปฏิเสธ managed queue เช่นกัน B4/B5 จะเพิ่ม configuration/runtime ตาม native dependencies

## Concurrency และสิทธิ์ฐานข้อมูล

config ใช้ command advisory lock → exclusive try-lock ที่ `dc:v1:voice-config:<tenantUuid>` → NOWAIT reference locks → ตรวจ policy/quota → transaction receipt กำหนด lock_timeout 250ms และ statement_timeout 2s ไม่มี network call ภายใน transaction

runtime User/state-log และ Voice Interaction ใช้ shared fence ที่ DB trigger รวม writer รุ่นเดิม เริ่มรับ shared fence ก่อน operator เปิด policy ครั้งแรกด้วย เพื่อไม่ให้ in-flight writer หลุดช่วงเปิด coordination config ไม่รอ User row ที่ A1 ถืออยู่

การล็อก policy/plan ที่อ่านได้อย่างเดียวใช้ narrow SECURITY DEFINER function ซึ่งตรวจ tenant session และล็อกได้เฉพาะสองแถวของ tenant นั้น ไม่ให้ application role ได้ UPDATE policy descriptor/receipt/audit เป็น append-only และตรวจ receipt constraint ภายใน transaction ก่อน commit เพื่อรองรับพฤติกรรม deferred error ของ Prisma 5

## ตรวจรับ

ใช้ isolated PostgreSQL/role dcontact_app NOBYPASSRLS และ sandbox Mailpit สำหรับ regression ของ API เดิม ไม่ใช้ VM เป็น test DB

- `pnpm --filter @d-contact/api test` และ `test:integration` (ตั้ง DATABASE_URL/APPLICATION_DATABASE_URL/MAILPIT_API_URL/MAILPIT_SMTP_HOST/MAILPIT_SMTP_PORT ให้ชี้ sandbox)
- `pnpm --filter @d-contact/db test:integration` ใช้ Docker Compose project ที่แยกและมี demo seed; กำหนด COMPOSE_PROJECT_NAME ให้ชี้ sandbox ของตน
- `pnpm --filter @d-contact/console test` และ `test:e2e`
- `pnpm test:d1-i18n` และ build/typecheck ของ DB/API/Console

ชุด API integration เดิมมี UAT evidence test ที่ใช้ `node:zlib.crc32` ต้องใช้ Node ที่รองรับ (เช่น runtime Node 24 ที่ใช้ตรวจงานนี้) ไม่แก้ test เดิมให้ skip เพราะ shell ใช้ Node 20

B1 ไม่รวม People provisioning/email activation, assignment/binding, เปิด managed routing หรือ deploy VM งานเหล่านั้นอยู่ B2–B7 และ final C ยังต้องทีมรับรองตามสเปก
