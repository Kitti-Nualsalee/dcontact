# LINE แชทรอบแรก (#1054)

ลูกค้าทักผ่าน LINE Official Account (OA) ของ tenant → เข้าคิวผ่าน Router เดียวกับ Web Chat → Agent กดรับใน Workspace → คุยโต้ตอบ โดยข้อความของ Agent ไปถึงลูกค้าทาง LINE → ปิดงานพร้อมบันทึกผล/โน้ต → อ่านบทสนทนาย้อนหลังได้ตามสิทธิ์

ขอบเขตที่ owner ตัดสินเมื่อ 27 พฤศจิกายน 2569 อยู่ใน [#1054](https://github.com/Kitti-Nualsalee/dcontact/issues/1054) ใช้กติกาเดียวกับ [Web Chat รอบแรก](webchat.md) ยกเว้นส่วนที่ LINE ต่างออกไปด้านล่าง
ทำตาม [ADR-001](adr/001-unified-interaction-model.md) (Router เดียว), [ADR-023](adr/023-conversation-vs-interaction.md) (Conversation ยาว, Interaction เป็นหน่วยงาน) และ [ADR-024](adr/024-message-delivery-media.md) (`messages` เป็น outbox และกันซ้ำ)

## เปิดใช้

1. ตั้ง `LINE_CHAT=on` ที่ API ค่าเริ่มต้นปิด: webhook และหน้าตั้งค่าไม่มี (404) เมนูไม่แสดง และไม่มีงานเบื้องหลังของ LINE ค่าที่ไม่ใช่ `on`/`off` ทำให้ API ไม่ start
2. API ต้องมี `ACCOUNT_SECRET_KEY` (base64 ของ 32 bytes ตัวเดียวกับที่ใช้เข้ารหัส TOTP) เพราะ channel secret และ access token ถูกเข้ารหัสด้วยกุญแจนี้ ไม่มีกุญแจ API log `line_chat.readiness SECRET_KEY_MISSING` และบันทึกค่าลับไม่ได้
3. apply migration `20261128090000_line_chat_round_one` และ `pnpm db:rls`
4. Admin ของ tenant ตั้งค่าที่ Console **การเชื่อมต่อ → ช่องทางลูกค้า → LINE**: เลือกคิว ใส่ Channel ID, Channel secret, Channel access token (long-lived) จาก LINE Developers แล้วบันทึก ระบบถาม LINE ว่า token นี้เป็นของ bot ไหนก่อนเก็บ
5. คัด webhook URL จากหน้าตั้งค่าไปใส่ใน LINE Developers → Messaging API → Webhook URL เปิด "Use webhook" แล้วกด Verify
6. ใน LINE Official Account Manager ปิดข้อความตอบกลับอัตโนมัติและข้อความทักทายของ OA เอง ไม่เช่นนั้นลูกค้าได้คำตอบซ้ำสองทาง
7. เปิดใช้งานในหน้าตั้งค่า

ทั้ง Web Chat และ LINE ใช้ Agent API ชุดเดียวกัน (`/api/v1/workspace/agent/webchat`) route นี้มีเมื่อเปิดช่องทาง chat อย่างน้อยหนึ่งช่องทาง

## การทำงาน

| ส่วน | ที่อยู่ | หน้าที่ |
| --- | --- | --- |
| กฎจ่ายงาน | `apps/router/src/webchat-routing.ts` | WEBCHAT และ LINE เป็นช่องทาง chat ใช้ offer, เพดานห้อง และสถานะ Agent ชุดเดียวกัน |
| LINE | `apps/api/src/line-chat-service.ts` | webhook, เปิดงาน, ตอบอัตโนมัติ, ส่งข้อความ Agent ไป LINE |
| ตั้งค่า | `apps/api/src/line-chat-channel.ts` | อ่าน/บันทึก OA ต่อ tenant เข้ารหัสค่าลับ, audit |
| client ของ LINE | `apps/api/src/line-chat-client.ts` | push, reply, profile, bot info, ตรวจ signature |
| งานของ Agent | `apps/api/src/webchat-service.ts` | รายการแชท, ข้อความ, รับ/ส่ง/จบ, รอบเบื้องหลัง (ทั้งสองช่องทาง) |

### ข้อความเข้า

- LINE เรียก `POST /api/v1/line/webhook/<tenant id>/<channel id>` ระบบตรวจ `x-line-signature` ด้วย channel secret ของ channel นั้นกับ bytes ที่ได้รับจริง และตรวจ `destination` ว่าเป็น bot ของ token ที่บันทึกไว้ channel ที่ไม่รู้จัก ปิดอยู่ หรือ signature ไม่ตรง ตอบ 404 เหมือนกัน
- ผู้ใช้ LINE หนึ่งคนของ channel หนึ่ง = Conversation เดียวที่อยู่ยาว ข้อความที่มาตอนไม่มีงานเปิดอยู่ สร้าง Interaction ใหม่ในคิวของ channel
- `message.id` ของ LINE เป็นตัวกันซ้ำ webhook ที่ LINE ส่งซ้ำไม่สร้างข้อความหรืองานซ้ำ ข้อความสองข้อความแรกที่มาพร้อมกันเปิดงานเดียว
- ข้อความที่ไม่ใช่ตัวอักษร (สติกเกอร์ รูป ไฟล์ ตำแหน่ง ฯลฯ) เก็บเป็นประเภทเท่านั้น Agent เห็นป้าย "ลูกค้าส่งสติกเกอร์" และต้องดูของจริงใน LINE (รอบนี้ไม่ดึงไฟล์)
- ชื่อลูกค้าดึงจาก profile ของ LINE ครั้งแรกและทุก 24 ชั่วโมง ก่อนได้ชื่อแสดงเป็น `LINE` ตามด้วยท้าย user id
- event อื่น (follow, unfollow, postback) และ event ที่ mode เป็น `standby` ไม่สร้างงาน

### ไม่มี Agent ออนไลน์

ถ้าตอนเปิดงานใหม่ไม่มี Agent ของคิวออนไลน์ (Ready หรือกำลังทำงาน) และตั้งข้อความตอบอัตโนมัติไว้ ระบบตอบด้วย reply token ของข้อความนั้นหนึ่งครั้ง (ไม่นับโควตา push) แล้วงานยังรอในคิว Agent ที่เข้ามาภายหลังได้รับ offer ตามปกติ ต่างจาก Web Chat ที่ไม่เปิดงานเมื่อไม่มีคน เพราะลูกค้า LINE ไม่ได้รออยู่หน้าเว็บ

### ข้อความออก

- ข้อความของ Agent ถูกเก็บเป็น `QUEUED` (แถวใน `messages` เป็น outbox) แล้ว worker ส่งด้วย push API ทันทีและทุก 2 วินาที
- `X-Line-Retry-Key` = id ของข้อความ ส่งซ้ำหลัง API ล่มกลางทางลูกค้าได้ครั้งเดียว (LINE ตอบ 409 ว่ารับไปแล้ว ระบบนับเป็นส่งสำเร็จ)
- 429/5xx/เครือข่ายล้ม: ลองใหม่แบบ backoff (เคารพ `Retry-After`) ไม่เกิน 6 ชั่วโมงหลังเขียน จากนั้นเป็น `FAILED`
- 4xx อื่น (token ผิด, ลูกค้าบล็อก OA, ข้อความผิดรูป): `FAILED` ทันที Workspace แสดง "ไม่ถึง LINE" ใต้ข้อความ
- ข้อความ push นับโควตารายเดือนของแพ็กเกจ OA ซึ่ง tenant ต้องดูแลเอง

### งานและลูกค้า

- งาน LINE เปิดใหม่ทุกครั้งที่ลูกค้าทักหลังงานก่อนปิดแล้ว (รวมตอนที่ Agent ยังบันทึกผลงานก่อนอยู่) ทุกงานอยู่ใน Conversation เดียวกัน
- Agent เห็นเฉพาะข้อความของงานที่ถืออยู่ ประวัติแสดงบทสนทนาต่องาน
- เมื่อ Agent ผูกลูกค้า Customer 360 กับงาน LINE ระบบจำไว้ที่ Conversation งานถัดไปของลูกค้าคนนั้นเริ่มแบบผูกแล้ว (Agent เปลี่ยนหรือยกเลิกได้ตามสิทธิ์เดิม)
- ลูกค้า LINE จบแชทเองไม่ได้ งานจบเมื่อ Agent กดจบ หรือ Agent ตอบล่าสุดแล้วลูกค้าเงียบเกินเวลาที่ตั้ง (ค่าเริ่มต้น 30 นาที)
- งานที่รอในคิวไม่หมดอายุเอง

### เพดานห้อง

Agent ถือแชทของทุกช่องทาง chat รวมกันได้ไม่เกิน `maxChatsPerAgent` ในหน้าตั้งค่า Web Chat (ค่าเริ่มต้น 3 ถ้ายังไม่เคยตั้ง Web Chat) การไม่ปนกับ Voice และ "สถานะหลังจบงาน" เหมือน Web Chat ทุกข้อ

## ความปลอดภัย

- channel secret และ access token เข้ารหัส AES-256-GCM ผูกกับ tenant, channel และชนิดค่า (ย้ายไปแถวอื่นแล้วถอดไม่ได้) ไม่มี API ใดส่งค่ากลับ หน้าตั้งค่าเห็นแค่ว่ามีค่าและ 4 ตัวท้าย audit เก็บแค่นั้นเช่นกัน
- บันทึกโดยไม่ใส่ค่าลับ = ใช้ค่าเดิม token ใหม่ต้องผ่านการถาม LINE ก่อนเก็บ
- webhook ไม่ต้อง login เพราะ signature เป็นหลักฐาน ทุกคำสั่งในฐานข้อมูลอยู่ใน transaction ของ tenant จาก URL (RLS)
- token ไม่ถูก log ข้อความลูกค้าไม่อยู่ใน log

## ข้อจำกัดของรอบแรก

- ไม่ส่งรูป/สติกเกอร์/ไฟล์ออก และไม่ดึงไฟล์ที่ลูกค้าส่งเข้า
- ไม่มีโอนแชท, rich menu, broadcast, ข้อความนอกเวลาทำการ
- OA หนึ่งตัวต่อ tenant
- ปิด `LINE_CHAT` ขณะมีงานค้าง: Agent ที่ถือห้อง LINE ต้องปิดและบันทึกผลก่อน (เหมือน Web Chat) และข้อความที่ยังไม่ส่งจะค้างจนเปิดกลับ
- ไม่มีปุ่มส่งซ้ำข้อความที่ `FAILED` Agent พิมพ์ใหม่ได้

## ทดลองบน dev

`LINE_CHAT=on node scripts/sales-demo-stack.mjs` เปิดตัวจำลอง LINE (`scripts/line-simulator.mjs`) ที่ http://127.0.0.1:8890/ ให้ API คุยกับตัวจำลองแทน LINE และใช้กุญแจเข้ารหัสสำหรับ dev
ใน Console ตั้งค่า LINE ด้วย token อะไรก็ได้ (ยกเว้น `reject-token` ที่ตัวจำลองปฏิเสธ) และ secret 32 ตัวอักษร hex จากนั้นใส่ webhook URL และ secret เดียวกันในหน้าตัวจำลอง แล้วพิมพ์ในฐานะผู้ใช้ LINE ได้
ตัวจำลองรับคำสั่ง `/sim/faults` เพื่อจำลอง LINE ตอบ 429/500/400

บน Solo ตัวจำลองรันเป็น container หลัง profile `line-sim` วิธีเปิดอยู่ใน [solo-uat.md](solo-uat.md#line-แชท-1054)

ชุดทดลองทั้งเส้นบน stack จริง: `pnpm exec playwright test -c playwright.webchat-trial.config.ts e2e-real/line-trial.spec.ts` ใน `apps/workspace` (stack ต้องเปิดด้วย `LINE_CHAT=on`) ครอบคลุมตั้งค่าใน Console → ตอบอัตโนมัติ → Agent รับและตอบ (push) → สติกเกอร์ → push ที่ LINE ปฏิเสธ → บันทึกผล → งานใหม่ของลูกค้าเดิม → ประวัติของทีม
