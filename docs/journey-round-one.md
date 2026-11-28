# Journey รอบแรก (#1067)

Admin publish journey หนึ่งตัว → เหตุการณ์จริงจากงานของ Agent เกิดขึ้น → Journey สั่ง action หนึ่งตัว → ดูผลได้ใน Console
รอบนี้คือ "Agent บันทึกผลงานเป็น `FOLLOW_UP_REQUIRED` → เปิดเคสติดตามให้ทีมปลายทาง" ตาม [ADR-025](adr/025-journey-orchestration.md) และ [ADR-016](adr/016-case-management.md)

ตัวเลือกที่ใช้ (คำถาม 5 ข้อใน #1067 ใช้ตัวเลือกแนะนำเป็นสมมติฐาน): action `ENSURE_CASE`, trigger จาก disposition ที่ Agent บันทึก, worker แยก process, ส่วนผลการทำงานใน Console

## เส้นทาง

1. Agent บันทึกผลงานแบบ `VOICE_NOTE_V1` (สาย, Web Chat, LINE) API เขียน `interaction_outcome_outbox` หนึ่งแถวใน transaction เดียวกับผล wrap-up
2. relay ใน process ของ API ส่ง `interaction.outcome_recorded` (Kafka V2, contract J2) เข้า `dc.interaction.events` แบบ at-least-once `eventId` คือ id ของแถว outbox
3. worker `apps/journey` เก็บ receipt (กันซ้ำด้วย tenant + eventId) จับคู่กับ journey ที่ publish แล้วซึ่ง trigger เป็น `INTERACTION_OUTCOME` ตรวจสิทธิ์ WORK ของทีมเจ้าของและทีมปลายทางต่อลูกค้า สร้าง enrollment และคำสั่ง `ENSURE_CASE` ใน transaction เดียว แล้วส่งเข้า `dc.case.commands`
4. worker `apps/cases` สร้างเคส (หรือผูกกับเคส OPEN เดิมของลูกค้า ประเภทเดียวกัน ทีมเดียวกัน) แล้วตอบผลที่ `dc.case.events`
5. Journey รับผล เปลี่ยน owner action เป็น `ACKNOWLEDGED` พร้อม id ของเคส

`outcomeId` ของ disposition คือ id ของ Interaction (ผล wrap-up มีได้หนึ่งชุดต่องาน) รหัสที่ส่งได้คือ `CUSTOMER_ASSISTED`, `FOLLOW_UP_REQUIRED` และ `CALLBACK_REQUESTED` (allowlist ใน `packages/cxa-contracts`) outcome ไม่มีโน้ตของ Agent

งานที่ไม่ได้ผูกลูกค้าไม่มี `contactId` ใน outcome Journey จึงตั้ง receipt เป็น REVIEW และไม่เปิดเคส

## เคสที่ Journey เปิด

- เคสผูกทีมปลายทางของขั้น `ENSURE_CASE` (`cs_cases.team_id`) ทีมนั้นเห็นในหน้า **เคสของทีม** และเพิ่มโน้ต มอบหมาย เปลี่ยนสถานะได้เหมือนเคสที่ Agent เปิด
- ไม่มีหัวข้อและไม่มีผู้เปิด หน้าจอแสดง "เคสติดตามจาก Journey" และ "ระบบอัตโนมัติ" ยังไม่มีผู้รับผิดชอบจนกว่าทีมจะมอบหมาย
- เหตุการณ์แรกในไทม์ไลน์อ้างงานต้นทาง
- เคส OPEN เดิมจะถูกผูกงานเพิ่มเฉพาะเมื่อเป็นเคสจาก Journey ของลูกค้า ประเภท และทีมเดียวกัน เคสที่ Agent เปิดเองและเคสของทีมอื่นไม่ถูกแตะ
- เคสจาก J2 ที่สร้างก่อน #1067 ไม่มีทีม จึงยังไม่แสดงในหน้าเคสของทีม

## หน้าผลการทำงาน

หน้า journey ใน Console มีส่วน **ผลการทำงาน** เมื่อ journey เคย publish แล้ว กดแสดงเพื่อโหลด `GET /api/v1/journey-authoring/journeys/:journeyId/runs`

- หนึ่งแถวต่อ enrollment ใหม่ไปเก่า: เวลาเริ่ม, รหัสที่กระตุ้นและ id งานต้นทาง (ย่อ), เวอร์ชัน, action, ผล และลิงก์ "เปิดเคส"
- ใช้สิทธิ์ `journey.read` เดียวกับตัว journey ผู้ที่ไม่มีสิทธิ์ได้ "ไม่พบ" เหมือน journey ที่ไม่มีอยู่
- ไม่มีข้อมูลลูกค้า ลิงก์เคสเปิดหน้าเคสของทีม ซึ่งตรวจสิทธิ์ของผู้ดูเอง (คนนอกทีมของเคสเห็น "ไม่พบเคส")

## เปิดใช้

| ส่วน | ค่า |
| --- | --- |
| API ส่ง outcome | `INTERACTION_OUTCOME_EVENTS=on` (ค่าเริ่มต้นปิด: ไม่เขียน outbox และไม่ต่อ Kafka) |
| หน้า authoring | `J5_CANVAS_WRITE_ENABLED=true`, `J5_PUBLISH_UI_ENABLED=true` และแถว `jr_authoring_rollout_state` ของ tenant |
| สิทธิ์ authoring | `iam_authoring_subjects` และ `iam_authoring_capability_grants` (จัดการนอก role ของแอป) publish ต้องมีผู้ตรวจอีกคนอนุมัติ (maker-checker) |
| worker | `apps/journey` และ `apps/cases` ต่อฐานด้วย `dcontact_app` |
| ข้อมูลอ้างอิงของเคส | `cs_case_type_policies` และ `cs_routing_policies` ที่ขั้น `ENSURE_CASE` อ้าง (`caseTypeId`, `routingIntentRef`) |
| สิทธิ์ของทีม | ทีมเจ้าของ journey และทีมปลายทางต้องมี WORK ต่อลูกค้า ([agent-usecase-dev.md](agent-usecase-dev.md)) |

migration: `20261130090000_interaction_outcome_outbox` (ตาราง outbox และ index ของ `jr_enrollments` สำหรับหน้าผลการทำงาน)

## ทดลอง

- ทั้งเส้นผ่าน broker จริง ไม่ใช้ browser: `pnpm --filter @d-contact/api trial:journey-round-one` ต้องมี broker ของ dev (`pnpm infra:up`) และฐานที่ migrate + apply RLS แล้วใน `DATABASE_URL`/`APPLICATION_DATABASE_URL` สคริปต์สร้าง tenant ของตัวเอง สร้างและ publish journey ผ่าน repository ของ authoring (รวมขั้นผู้ตรวจ) เริ่ม worker journey/cases ด้วย consumer group ของรอบนั้น แล้วตรวจว่า disposition ที่ตรงเปิดเคสหนึ่งเคส disposition อื่นไม่เปิด และส่ง outcome ซ้ำไม่เปิดเคสเพิ่ม
- dev stack พร้อมหน้าจอ: `JOURNEY=on node scripts/sales-demo-stack.mjs` เริ่ม worker ทั้งสอง เปิด flag และ seed สิทธิ์ authoring ของ tenant demo (Admin เป็นผู้สร้างและ publish, `agent1001@demo.local` เป็นผู้ตรวจ) ค่าอ้างอิงของเคสชื่อ `follow-up` ทั้งสองช่อง
- integration: `interaction-outcome-outbox.integration.ts` (API), `cases-ensure-case-service.integration.ts` (Cases), `journey-authoring-repository.integration.ts` (ผลการทำงาน)
- หน้าจอ: `apps/console/e2e/journey-authoring.spec.ts` และ `team-cases.spec.ts` (กรณี #1067)

## ข้อจำกัดของรอบแรก

- ส่ง outcome เฉพาะผลงานแบบ `VOICE_NOTE_V1` wrap-up แบบเดิม (`LEGACY`) และสายที่ลูกค้าวางก่อนรับยังไม่ส่ง
- ยังไม่มีการแก้ disposition ย้อนหลัง จึงมี outcome เวอร์ชัน 1 เท่านั้น
- ช่อง `outcomeCode`, `caseTypeId`, `routingIntentRef` และทีมปลายทางในหน้า authoring ยังเป็นช่องพิมพ์รหัส ไม่มีตัวเลือก
- ยังไม่มีหน้าจัดการประเภทเคสและสิทธิ์ authoring ต้อง seed โดย operator
- action `SEND`, `SCHEDULE_CALLBACK` และ trigger `EVENT` จาก journey ที่ publish อยู่นอกรอบนี้ (ติดตามใน #888)
