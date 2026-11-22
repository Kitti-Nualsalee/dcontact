# Tenant ใหม่: จาก provisioning ถึง Agent รับสายและบันทึกผล

Authority: [#977](https://github.com/Kitti-Nualsalee/dcontact/issues/977) (เลือกจาก backlog #888 วันที่ 22 พ.ย. 2569)

เอกสารนี้บอกลำดับงานตั้งแต่ Platform operator สร้าง tenant จนถึง Agent คนแรกรับสายและบันทึกผล
และแยกว่าขั้นไหนเกิดเองจาก provisioning ขั้นไหน Admin ทำใน Console และขั้นไหน operator ต้องทำ
รายละเอียดของแต่ละส่วนอยู่ใน [Platform provisioning](platform-provisioning-rollout.md),
[คำเชิญของ Tenant People](tenant-people-invitations.md), [คิวและ skill](voice/catalog-v1.md) และ
[การตั้ง skills และ binding](tenant-voice-configuration.md)

## ลำดับและผู้ทำ

| # | ขั้น | ผู้ทำ | ทางที่ใช้ |
| --- | --- | --- | --- |
| 1 | สร้าง tenant, Organization, first admin และส่งคำเชิญ | Platform operator | Platform Console/API (เกิดเองใน saga) |
| 2 | first admin ยืนยันอีเมล ตั้งรหัสผ่าน ตั้ง OTP แล้ว login Console | first admin | ลิงก์ในอีเมล |
| 3 | เตรียม People และ Voice ของ tenant | operator | `scripts/tenant-voice-onboarding.mjs` + env ของ API |
| 4 | เปิด shell ใหม่ (`ui.shell.v2`) ให้ tenant | operator | `pnpm d1:shell-flag` ([d1-shell-rollout](d1-shell-rollout.md)) |
| 5 | สร้างทีมที่รับสาย | Admin | Console → ตั้งค่าองค์กร → ทีม |
| 6 | เชิญ Agent เลือกทีมและหมายเลขภายในจาก pool | Admin | Console → บัญชีผู้ใช้ |
| 7 | Agent รับคำเชิญ ทำ required actions เอง | Agent | ลิงก์ในอีเมล; ระบบเปลี่ยนเป็น ACTIVE ใน activation poll |
| 8 | สร้างทักษะ คิว ทักษะที่คิวต้องการ เปิดคิว และให้ทักษะ Agent | Admin | Console → ตั้งค่า Voice |
| 9 | ผูกเบอร์ปลายทางที่ operator จองไว้กับคิวและเปิดใช้ | Admin | Console → ตั้งค่า Voice → ปลายทาง |
| 10 | Agent เข้า Workspace เลือก Ready รับสาย จบสาย บันทึกผล และเปิดประวัติ | Agent | Workspace + dphone |

ขั้น 1–2 และ 5–10 ไม่ต้องมี operator ขั้น 3–4 ต้องทำครั้งเดียวต่อ tenant ก่อน Admin เริ่มขั้น 6
ถ้ายังไม่ทำขั้น 3 Console จะแสดงคิว/ทักษะเป็น `RESOURCE_POLICY_NOT_READY` และเชิญ Agent ไม่ได้

## ขั้น 3: เตรียม People และ Voice ด้วยสคริปต์

สคริปต์รวมงานของ operator ที่ก่อนหน้านี้ต้องเขียน SQL และตั้ง Keycloak เอง เป็น dry-run โดยปริยาย
และรันซ้ำได้ (ของที่ตรงแล้วข้าม) ต้องใช้บัญชี operator ของฐานข้อมูลและ Keycloak admin ของ deployment

```sh
DATABASE_URL=<operator> KEYCLOAK_ADMIN_URL=<keycloak> \
KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME=<admin> KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD=<secret> \
node scripts/tenant-voice-onboarding.mjs --tenant <slug> \
  --approval-ref <ticket> --operator-subject <subject> --reason "<เหตุผล>" \
  --accounts <n> --agents <n> --voice-queues <n> --skills <n> \
  --node <telephonyNodeId> --release-digest <sha256> --dialplan-digest <sha256> \
  --extensions 1100-1109 --destination 2000 \
  --worker-principal <role> [--create-worker-principal] \
  --env-out <ไฟล์ env> --apply
```

สิ่งที่สคริปต์ทำ

- **Keycloak realm**: attribute ใน user profile ที่ extension tenant-people ตรวจ (`dc_identity_class`,
  `tenant_id`, `tenant_slug`, `dc_user_id`, `dc_tenant_people_operation_id`, `dc_invitation_not_before`)
  เป็น single value และ view/edit เฉพาะ admin ตาม AC6 (#599)
- **Keycloak client** `dcontact-tenant-people-<tenantId>`: confidential, service account, ไม่มี browser flow,
  audience `dc-tenant-people` และ attribute ที่ผูก Organization ของ tenant (ค้นจาก `tenant_id` ที่ provisioning ตั้งไว้)
- **TenantVoiceProvisioningPolicy**: revision 1 หรือ +1 เมื่อค่าเปลี่ยน, `PLAN_SNAPSHOT` ตรง digest ของ plan binding
  (`UAT_EXPLICIT` เมื่อไม่มี binding), caps ระบุเองทั้ง 4 ค่า ไม่เดาจาก entitlements, extension pool และ destination pool
  trigger เดิมเขียน policy audit และปฏิเสธเมื่อมีสาย Voice ค้าง
- **เบอร์ปลายทาง**: แถว `voice_destinations` แบบ managed v1 ที่ inactive ผูกคิวแรกจาก bootstrap ไว้ก่อน
  Admin เปลี่ยนเป็นคิวจริงและเปิดใช้เองใน Console
- **Worker binding**: `tenant_people_worker_bindings` ของ principal ที่เป็น LOGIN NOINHERIT NOBYPASSRLS
  และเป็นสมาชิก `dcontact_tenant_people_worker` (`--create-worker-principal` สร้าง role และรหัสผ่านใหม่ให้)
- ไม่สร้างคิว ทักษะ ผู้ใช้ หรือ identity binding รายคน และไม่เปิดเบอร์ปลายทาง

หลัง `--apply` ไฟล์ `--env-out` (mode 600) มีค่าที่ต้องใส่ใน env ของ API แล้ว restart (API อ่านตอน start)

- รวมค่า `TENANT_PEOPLE_BINDING_<SLUG>` เข้า array ของ `TENANT_PEOPLE_BINDINGS_JSON` (หนึ่งรายการต่อ tenant)
- `TENANT_PEOPLE_SECRET_<TENANT_ID>` เป็น secret ของ client ข้างบน
- `TENANT_PEOPLE_WORKER_DATABASE_URL` เมื่อสร้าง principal ใหม่
- ตั้ง `TENANT_PEOPLE_INVITATIONS_ENABLED=true` และให้ `SIP_BROWSER_NODES_JSON` มี node ที่ระบุ

`--release-digest` และ `--dialplan-digest` ต้องตรงกับ node ใน `TENANT_PEOPLE_BINDINGS_JSON` ทุกตัว
issuer ของ binding ต้องเป็น https หรือ `http://127.0.0.1` (dev ใช้ `http://127.0.0.1:8081/realms/dcontact`
ซึ่งสคริปต์ตั้งให้เมื่อ `KEYCLOAK_ADMIN_URL` เป็น localhost)

## เงื่อนไขของ runtime ที่ต้องมี

- **Managed routing**: คิวที่ Admin สร้างใน Console เป็น managed v1 เสมอ และรับสายได้เมื่อ telephony ที่ต่อกับ
  FreeSWITCH ส่ง heartbeat ของ managed runtime ให้ tenant นั้น ตอนนี้มีเฉพาะ entrypoint `e1-sandbox-main`
  ที่รับ managed runtime (ใช้กับ tenant เดียวและ SIP domain เดียวต่อ process)
  ส่วน `apps/telephony/src/main.ts` ที่ dev compose และ Solo UAT ใช้ ส่งสายให้ legacy router ผ่าน Kafka เท่านั้น
  legacy router ปฏิเสธคิว managed (`VOICE_CONFIG_V1_REQUIRED`) **คิวที่สร้างใน Console จึงยังรับสายบน Solo ไม่ได้**
  งานต่อแยกเป็น issue ติดตาม
- **SIP domain**: สายเข้าต้องมี SIP domain ของ tenant (`<slug>.<PLATFORM_SIP_BASE_DOMAIN>`) ซึ่ง FreeSWITCH
  ตั้งจาก header `X-DContact-Domain` ที่ Kamailio ใส่ (ADR-038) dialplan dev ของ context `pstn` park เฉพาะ
  เบอร์ 2000/2001 จึงต้องจองเบอร์ปลายทางเป็น 2000 หรือ 2001 บน dev
- **คิว managed ไม่บันทึกเสียง**: การเปิดคิว/เบอร์ managed ต้องมี recording, auto QM และ transcription ปิด
  (`dc_voice_managed_activation_check`) งาน Supervisor ฟังเสียง (#967) และ QM (#971) จึงยังใช้ได้กับคิว legacy เท่านั้น
- **ฐานข้อมูลของ API**: API ต้องต่อด้วย role `dcontact_app` เหมือน deployment จริง ถ้าใช้ owner/superuser
  (เช่น `DATABASE_URL` ของ migration) trigger ของ Core Settings ข้ามการบันทึก transaction แล้วสร้างทีมไม่ได้
  (`CORE_TEAM_EFFECT_RECEIPT_REQUIRED`, ตอบ 500)

## ผลทดลองบน dev — 22 พ.ย. 2569

Branch `feat/977-new-tenant-onboarding` จาก main `ffeadb0` บน dev stack ในเครื่อง ฐานแยก `dcontact_977`,
Keycloak dev realm `dcontact`, FreeSWITCH dev, Mailpit และ SIPp เป็นสายจำลอง ผ่านทุกขั้นในตารางข้างบน

- Platform API/worker สร้าง tenant `onboard977` (plan growth) จน `SUCCEEDED` และส่งคำเชิญ first admin
- first admin รับคำเชิญจาก Mailpit ทำ required actions แล้ว login Console
- สคริปต์ขั้น 3 เตรียม Keycloak/policy/pool/เบอร์ 2000/worker binding รันซ้ำแล้วไม่มีการเปลี่ยน
- Admin สร้างทีม Customer Care, เชิญ Agent (extension 1100), สร้างทักษะ SUPPORT, คิว Support Line, ตั้งทักษะที่คิวต้องการ,
  เปิดคิว, ให้ทักษะ Agent ระดับ 3 และผูกเบอร์ 2000 แบบเปิดใช้ ทั้งหมดผ่าน Console
- Agent รับคำเชิญจนเป็น ACTIVE, login Workspace, เลือก Ready, dphone ลงทะเบียน SIP ได้, สายจาก SIPp เข้าเบอร์ 2000
  ผ่าน managed routing ถึง Agent, รับสาย, วางสาย, บันทึก `CUSTOMER_ASSISTED` พร้อมโน้ต และเปิดประวัติอ่านโน้ตกลับได้
- interaction อยู่ใน tenant ใหม่, คิว Support Line และ Agent ที่เชิญ สถานะ `COMPLETED`

ข้อจำกัดของผลนี้

- telephony ใช้ `e1-sandbox-main` ผ่าน tsx (Node 20 ในเครื่องโหลด `apps/delivery` แบบ ESM จาก build CJS ไม่ได้)
  ไม่ใช่ `main.ts` ของ Solo
- เสียงเป็น fake media ของ Chromium และ SIPp ไม่ได้ตรวจเสียงสองทางด้วยหู
- ไม่ได้เชื่อมลูกค้าในสาย (Admin ต้องให้สิทธิ์ WORK บน segment แก่ทีมก่อน ตาม #915) และไม่ได้ทดสอบบน UAT
