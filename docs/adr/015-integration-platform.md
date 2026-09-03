# ADR 015: Integration Platform — public API เป็นชั้นเดียวกับ UI ของเราเอง และ event ของลูกค้ามาจาก Kafka ที่มีอยู่แล้ว

- **สถานะ:** Accepted
- **วันที่:** 2026-08-08

## บริบท

ระบบที่ไม่มี API สาธารณะถูกตัดออกตั้งแต่รอบ RFP ขององค์กรใหญ่ และในไทยส่วนใหญ่ขายผ่าน SI
ที่ต้องต่อกับ CRM/ERP ของลูกค้าเอง — ความสามารถในการ**ต่อของ** สำคัญกว่าฟีเจอร์อีกหลายตัวรวมกัน

ของที่มีอยู่แล้ว: `apps/api` (REST + WS), Keycloak ที่ออก token ได้
([iam-architecture §3](../iam-architecture.md)), Kafka ที่มี event ครบทุกโดเมน
([ADR-003](003-kafka-event-backbone.md)), flow node `API call`

## การตัดสินใจ

1. **Public API คือ API ตัวเดียวกับที่ UI ของเราใช้ (dogfooding) ไม่ใช่ชั้นแยก**
   ต่างกันแค่ credential และ rate limit — ห้ามมี endpoint ลับที่ UI ใช้ได้แต่ลูกค้าใช้ไม่ได้
   ชั้น API ที่แยกกันจะเพี้ยนกันภายในสองรอบ release และเป็นหนี้ที่จ่ายคืนไม่ไหว

2. **เวอร์ชันของ API อยู่ใน path (`/api/v1/...`) และสัญญาคือ OpenAPI ที่ generate จากโค้ด**
   spec ที่เขียนมือจะไม่ตรงกับความจริง — CI ต้อง fail เมื่อ spec เปลี่ยนแบบ breaking
   (วินัยเดียวกับ entitlement key ใน [ADR-009](009-plan-entitlement-licensing.md) ที่เป็นสัญญาถาวร)

3. **Webhook ของลูกค้าเป็น consumer ของ Kafka ไม่ใช่โค้ดที่แทรกในเส้นทางงาน**
   `apps/webhook` (worker) subscribe topic ที่มีอยู่แล้ว แล้วยิง HTTP ออกไป
   ผลคือ **endpoint ของลูกค้าล่มไม่กระทบการรับสาย** — ถ้ายิงจากในเส้นทางงาน
   ลูกค้าที่ endpoint ช้า 5 วินาทีจะทำให้ระบบเราช้าไปด้วย ซึ่งเป็นความล้มเหลวที่พบบ่อยที่สุดของโมดูลนี้

4. **ส่งอย่างน้อยหนึ่งครั้ง (at-least-once) + เซ็นทุก payload + retry แบบถอยหลัง**
   ผู้รับต้องทำ idempotent เอง โดยเราส่ง `eventId` ให้ทุกครั้ง (สัญญาเดียวกับใน
   [ADR-003](003-kafka-event-backbone.md)); ลายเซ็น HMAC ต่อ endpoint; ล้มเหลวติดกัน
   N ครั้ง → พัก endpoint และแจ้ง tenant (ไม่ใช่ยิงต่อไปเงียบ ๆ ตลอดกาล)

5. **CRM connector เป็น "แอป" ที่ประกอบจาก primitive เดียวกับที่ลูกค้าใช้ได้**
   Salesforce/Dynamics/Zendesk/ServiceNow เป็น package ที่ใช้ REST + webhook + CTI adapter
   ชุดเดียวกับที่เปิดให้ทุกคน — ไม่มีทางลัดภายในให้ connector ที่เราเขียนเอง
   ข้อดี: สิ่งที่พาร์ตเนอร์เขียนได้เท่ากับสิ่งที่เราเขียนได้ = มี ecosystem จริง

6. **Embedded agent (CTI adapter) เป็นสิ่งที่ทำให้ integration ขายได้ — ไม่ใช่ screen pop**
   ฝัง workspace ลงใน CRM ผ่าน iframe + `postMessage` API ที่มีสัญญาชัดเจน
   screen pop คือฟีเจอร์ที่ตามมาเอง ไม่ใช่เป้าหมาย

7. **credential ของ tenant เก็บแยกและเข้ารหัส ไม่ปนกับ config อื่น**
   `int_credentials` เข้ารหัสด้วยคีย์ต่อ tenant, ไม่ถูกส่งกลับใน API ตอบ, หมุนเวียนได้,
   และมี audit ทุกครั้งที่ถูกอ่านโดยงานเบื้องหลัง

## ผลที่ตามมา

- service ใหม่ 1 ตัว: `apps/webhook` (worker ล้วน) — เบาและล้มได้โดยไม่กระทบ kernel
- Keycloak เพิ่ม client แบบ `client_credentials` ต่อ tenant (machine-to-machine)
  ตาม [iam-architecture §3](../iam-architecture.md)
- rate limit เป็น entitlement (`modules.api.rateLimitRps`) — ไม่ใช่ค่าคงที่ในโค้ด
- flow node `API call` ใช้ `int_connections` ตัวเดียวกับ connector (ไม่ต้องตั้งค่า URL ซ้ำ)
- entitlement: `modules.api.{enabled, publicApi, webhooks, cti, rateLimitRps}` +
  `modules.connectors.{salesforce, dynamics, zendesk, servicenow, custom}`

## ทางเลือกที่ไม่เอา

| ทางเลือก | เหตุผลที่ไม่เอา |
|---|---|
| ยิง webhook จากในเส้นทางงาน (inline) | endpoint ลูกค้าช้า/ล่ม = ระบบเราช้า/ล่ม |
| GraphQL เป็น API หลัก | ทีมพาร์ตเนอร์ในไทยคุ้น REST + OpenAPI มากกว่า; เพิ่มทีหลังได้ |
| เปิด Kafka ให้ลูกค้าต่อตรง | ผูกลูกค้ากับโครงสร้างภายในเราถาวร + isolation ต่อ tenant ทำยาก |
| ให้ connector ของเราใช้ทางลัดภายใน | ฆ่า ecosystem และทำให้เราเป็นคอขวดของทุกการต่อระบบ |
| เขียน OpenAPI spec ด้วยมือ | spec จะไม่ตรงกับความจริงภายในหนึ่งไตรมาส |

## เอกสารเกี่ยวข้อง

[integration-platform.md](../integration-platform.md) · [reporting-data-platform.md](../reporting-data-platform.md)
