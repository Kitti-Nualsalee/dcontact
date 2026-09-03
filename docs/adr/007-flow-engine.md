# ADR 007: Omnichannel Flow engine (เปลี่ยนชื่อจาก IVR) + Flow Designer ด้วย React Flow

- **สถานะ:** Accepted
- **วันที่:** 2026-07-26

> **อัปเดต (2026-08-09):** digital ขาเข้าย้ายไป `dc.channel.events` (เดิม `dc.fs.events`) ตาม [ADR-023](023-conversation-vs-interaction.md) ข้อ 6;
> node taxonomy ขยายเป็น 18 ชนิดตาม [flow-engine.md §2](../flow-engine.md) และ [ADR-021](021-flow-expression-node.md)


## บริบท

ก่อนหน้านี้ระบบมีแนวคิด "IVR flows" เป็น **เมนูเสียงสำหรับ voice เท่านั้น** (ยังเป็น mockup
static card ไม่มี model/engine จริง) แต่ [ADR-001](001-unified-interaction-model.md) วางให้ทุกช่องทาง
เป็น interaction เดียวกัน และ [interaction-data-flow §4](../interaction-data-flow.md) ขั้นที่ 3
(เลือกคิว + เช็คเวลาทำการ) เป็นจุดตัดสินใจ **ก่อน** จับคู่ agent ซึ่งทุกช่องทางต้องใช้ร่วมกัน

ความต้องการคือ layer ตัดสินใจก่อนเข้าคิวที่ทำงานได้ทั้ง 6 ช่องทาง
(VOICE, WEBCHAT, LINE, FACEBOOK, WHATSAPP, EMAIL) พร้อมเครื่องมือแบบลากวางให้ลูกค้าออกแบบเอง
— IVR เป็นคำที่แคบเกินไปสำหรับสิ่งนี้ (Interactive **Voice** Response)

## การตัดสินใจ

1. **เปลี่ยนชื่อ IVR → "Flow" ทั้งระบบ**; เครื่องมือแก้ไขเรียก **"Flow Designer"**
   สอดคล้องกับมาตรฐานอุตสาหกรรม omnichannel (Twilio Studio, Genesys ใช้ "Flows")
   — ยังไม่รองรับ SMS (channel model มี 6 ช่องทาง ตาม `ChannelType` enum)
2. **Flow เป็น tenant metadata** ([ADR-005](005-multitenant-metadata-architecture.md)) —
   เก็บเป็น JSON แบบมี version, cache ใน Redis, invalidate ผ่าน `dc.tenant.events`
   ไม่ใช่ schema หรือโค้ดต่อ tenant
3. **Flow Engine เป็น module/interpreter ภายใน `apps/router` ไม่ใช่ service ใหม่** —
   flow ทำงานที่ router ขั้นที่ 3 (ก่อน matching ขั้นที่ 4) จึงใช้ tenant config cache, Redis,
   และ Kafka wiring ของ router เดิม ไม่มี network hop เพิ่ม และไม่มี split-brain
   เรื่อง interaction state
4. **การทำงานเป็น state machine แบบ async ต่อ 1 interaction, state อยู่ใน Redis
   key `flow:{interactionId}`** — voice ส่งคำสั่งผ่าน `dc.telephony.commands` แล้วรอ event
   จาก `dc.fs.events`; digital ส่งผ่าน `dc.channel.commands` แล้วรอข้อความตอบกลับ
5. **เพิ่ม topic ใหม่ 1 ตัว: `dc.channel.commands`** (router → channels gateway,
   key = `interactionId`) สมมาตรกับ `dc.telephony.commands` — จำเป็นเพราะทุกวันนี้มีแต่ *agent*
   ที่ส่งข้อความ digital ออก; flow ที่ต้องส่ง quick-reply/template เองยังไม่มีเส้นทาง
   **ไม่เพิ่ม** `dc.flow.events` ใน MVP (step transition ลงใน `interaction_events` เดิม)
6. **1 flow version ผูก 1 channel** (`channelBinding`) — validation ตาม capability ทำได้จริง
   และ palette/canvas ไม่กำกวม (DTMF ใช้ได้แค่ voice, email ไม่มี sync collect);
   การใช้ซ้ำข้ามช่องทางทำด้วยการ **duplicate flow** ไม่ใช่ flow polymorphic ตัวเดียว
7. **เส้นแบ่ง flow กับ router ชัดเจน**: flow เป็นเจ้าของทุกอย่างจนถึงการเลือกปลายทาง
   (queue/agent) หรือ terminal (voicemail/callback/hangup); **router/ACD เป็นเจ้าของ
   การจับคู่ agent, reserve, ring, requeue** (§4 ขั้น 4–6) — node `routeToQueue` คือจุดส่งมอบ
8. **Designer ใช้ React Flow (`@xyflow/react`) โหลดผ่าน esm.sh CDN** ในหน้า static
   ตามแนว mockup เดิม (Tailwind/Chart.js/Tabler ก็มาจาก CDN) — ไม่ต้องมี build step
   โครงสร้าง node JSON ใช้ shape ของ React Flow ตรง ๆ (`nodes[].position`, `edges[].sourceHandle`)
   จึง serialize/deserialize โดยไม่ต้องแปลง

รายละเอียด node taxonomy, capability matrix, JSON schema, execution sequence, versioning
และตัวอย่าง 10 flow อยู่ใน [`docs/flow-engine.md`](../flow-engine.md)

## ผลที่ตามมา

- (+) layer ตัดสินใจก่อนเข้าคิว **ใช้ร่วมกันทุกช่องทาง** — ไม่มี "IVR สำหรับ voice"
  แยกจาก "auto-reply สำหรับ chat" ที่ต้อง maintain สองชุด
- (+) ลูกค้าปรับ flow เองได้ผ่าน designer โดยไม่ต้อง deploy — ตรงตามหลัก metadata-driven (ADR-005)
- (+) เพราะ interpreter อยู่ใน router จึงใช้ dedupe (`eventId`), timer tick, และ config cache เดิม
- (−) **router ซับซ้อนขึ้นมาก** — กลายเป็น durable state machine ที่มี timer/resume
  (ความเสี่ยงงานสร้างอันดับหนึ่ง) → คุมด้วย module ที่มีขอบเขตชัด + Redis namespace แยก
  + วินัย idempotency เดิม; ถ้าโตเกินไปยัง **แยกเป็น `flow-runner` ได้ภายหลังโดยไม่แก้ JSON contract/topics**
- (−) ต้อง validate ตอน publish ตาม capability matrix ไม่ให้สร้าง flow ที่ทำงานไม่ได้จริง
  (เช่น DTMF บน email)
- (−) `dc.channel.commands` ต้องมี outbound implementation ฝั่ง channels gateway —
  ระหว่างที่ยังไม่มี digital flow จะ "ตัดสินใจ/route ได้ แต่ส่งข้อความเชิงรุกไม่ได้"
  → ลำดับงาน: voice flow ใช้ topic เดิมได้เลย, digital ต้องรอ topic + gateway outbound
- (−) React Flow ผ่าน CDN มีความเสี่ยงเรื่อง version drift/offline (mockup เท่านั้น ไม่กระทบ production)
  → pin เวอร์ชันใน importmap
