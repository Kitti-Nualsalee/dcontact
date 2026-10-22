# การตั้ง skills และ binding ของ Voice V1

ขอบเขตตาม #711 และ Phase Contract #704: Admin เปลี่ยน required skills ของคิว,
skills/ระดับของ Agent และ DIRECT_QUEUE binding ที่ operator reserve ไว้ได้
Supervisor อ่าน projection เฉพาะทีมปัจจุบันของตน ไม่มี email หรือ invitation details

## ใช้งานผ่าน Console

- เปิดตั้งค่า Voice → คิว → รายละเอียด เพื่อแทนชุด required skills และดู eligibility
- เปิดตั้งค่า Voice → ทักษะ Agent เพื่ออ่าน roster และแทนชุด skills ของ AGENT
  บัญชี PENDING_ACTIVATION เตรียม skills ได้ แต่ยังไม่รับงานแทนผู้ใช้
- เปิดตั้งค่า Voice → ปลายทาง เพื่อเลือกคิวและบันทึก inactive binding
- ใส่เหตุผลก่อนบันทึก ผลสำเร็จต้องอ่านกลับจาก server ถ้า response หายให้ตรวจคำสั่งเดิม
  ถ้า revision เปลี่ยนให้โหลดข้อมูลใหม่ก่อนแก้

managed routing ยังไม่พร้อมจน B5 ผ่าน จึงบันทึก inactive configuration ได้
แต่เปิดคิวหรือ binding ไม่ได้ คำเตือนไม่มี Agent ที่ eligible และ AVAILABLE
ไม่เปลี่ยน presence และไม่ทำให้ configuration ที่ถูกต้องกลายเป็น invalid

## Operator และ migration

`TenantVoiceProvisioningPolicy.destinationPool` เป็น operator authority:
แต่ละรายการอ้าง `destinationId` ของ VoiceDestination ที่ reserve ใน tenant เดียวกัน
operator เตรียมแถวด้วย `voiceConfigVersion=1`, `configRevision=1`, `isActive=false`
และ queue/team ที่มีอยู่แล้ว Browser สร้าง destination หรือแก้ pool ไม่ได้

migration เพิ่ม tenant-bound composite foreign keys และ FORCE RLS ให้
`agent_skills`/`queue_skills` พร้อม level checks 1–5 หากพบ assignment ข้าม tenant
จะหยุดและ rollback แทนการแก้ข้อมูลอัตโนมัติ ต้องตรวจข้อมูลเดิมก่อน deploy

## สัญญาคำสั่ง

PUT required-skills, Agent skills และ binding ใช้ `commandId`, `expectedRevision`,
`reasonCode`, `reason` พร้อมชุดข้อมูลใหม่ Server ตรวจสิทธิ์จาก domain user ปัจจุบัน
แล้วถือ command/config/reference fences และ NOWAIT locks ตรวจงานค้างรวม legacy
ก่อน commit resource/revision/audit/receipt ใน transaction เดียว

`CONFIG_BUSY` หรือ `REVISION_CONFLICT` ไม่บันทึกบางส่วน คำสั่งเดิมที่ payload ตรง
อ่าน receipt เดิมได้ผ่าน `GET /api/v1/tenant-voice/commands/:commandId`
ผล eligibility เป็น projection ที่มี `evaluatedAt` และ queue `configRevision`
ไม่มีการ reserve Agent, เปิด AVAILABLE หรือขอ SIP credential

## ตรวจบน sandbox

```sh
pnpm db:migrate
pnpm db:rls
pnpm --filter @d-contact/api exec tsx --test src/tenant-voice-configuration.integration.ts
pnpm --filter @d-contact/router test:integration
pnpm --filter @d-contact/console exec playwright test e2e/voice-configuration.spec.ts
pnpm test:d1-i18n
```

กำหนด `DATABASE_URL` และ `APPLICATION_DATABASE_URL` ของ PostgreSQL sandbox ก่อนรัน
การตรวจ migration ที่มีข้อมูลปน tenant ใช้ PostgreSQL container แยก:

```sh
VOICE_SKILL_TEST_CONTAINER=<sandbox-container> VOICE_SKILL_TEST_USER=postgres \
  pnpm --filter @d-contact/db exec tsx --test src/voice-skill-scope.integration.ts
```

เทสต์นี้สร้างและลบเฉพาะฐานข้อมูลชื่อสุ่มของตน ไม่ควรใช้ container ของ production/UAT
