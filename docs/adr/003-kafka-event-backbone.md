# ADR 003: Kafka เป็น Event Backbone (Redis เหลือบทบาท state store)

- **สถานะ:** Accepted
- **วันที่:** 2026-07-14

## บริบท

D-Contact เป็น SaaS multi-tenant ที่ต้องมี usage metering/billing ต่อ tenant
(โมเดล billing ยังไม่ฟิกซ์ — usage-based / per-seat / hybrid จึงต้องเก็บ event ให้ครบทุกแบบ)
Redis pub/sub ที่ใช้ตอน Phase 0 เป็น fire-and-forget: consumer หลุด = event หาย
replay ไม่ได้ — ใช้เป็นฐาน billing ไม่ได้

## การตัดสินใจ

1. **Kafka เป็น event backbone ของทุก domain event** — dev ใช้ **Redpanda**
   (Kafka-compatible, binary เดียว, `--mode dev-container`); production เลือกได้ทั้ง
   Kafka/MSK/Confluent/Redpanda เพราะใช้ Kafka API เดียวกันผ่าน `kafkajs`
2. **Redis เปลี่ยนบทบาทเป็น state store เท่านั้น** (agent presence, queue realtime state,
   cache) — ห้ามใช้เป็น event bus อีก
3. **Topic design** (สร้างอัตโนมัติโดย `redpanda-init` ใน compose):

   | Topic                   | Key           | ทิศทาง                         |
   | ----------------------- | ------------- | ------------------------------ |
   | `dc.fs.events`          | callUuid      | telephony → router             |
   | `dc.interaction.events` | interactionId | router → api/reporting/billing |
   | `dc.agent.events`       | agentId       | router/api → api (WS fan-out)  |
   | `dc.telephony.commands` | callUuid      | router → telephony (Phase 1)   |

4. **Tenant isolation:** shared topics + `tenantId` ใน message header และ payload
   (topic-per-tenant ระเบิดเมื่อ tenant เยอะ; partition by key ให้ ordering ต่อ call/interaction)
5. **ทุก service ต้อง produce/consume ผ่าน `@d-contact/kafka` เท่านั้น** — บังคับ JSON envelope,
   tenantId header, และเป็นจุดเดียวที่จะเสียบ schema registry/outbox ภายหลัง
6. Retention: dev 7 วัน; `interaction_events` ใน Postgres ยังเป็น system of record
   (Kafka เป็น transport + replay buffer ไม่ใช่ database)

## ผลที่ตามมา

- (+) billing/reporting foundation: event ไม่หาย, replay ได้, audit ได้ — รองรับทุกโมเดล billing
- (+) services สเกล/deploy แยกกันได้จริง มี durable buffer คั่น
- (−) ops cost เพิ่ม (broker, consumer group, partition) — ชดเชยด้วย Redpanda ตอน dev
  และ managed service ตอน production
- (−) เส้น call signaling (router → telephony command) ผ่าน Kafka มี latency เพิ่มระดับ ms
  → ต้องวัดจริงใน Phase 1; ถ้าเกิน budget จะย้ายเฉพาะ command path เป็น direct RPC
  ซึ่งทำได้เพราะทุกอย่างผ่าน interface ใน `@d-contact/kafka`
- (−) การ resolve SIP domain → tenant UUID ยังเป็น TODO ใน telephony (ตอนนี้ใช้ domain เป็น key)
