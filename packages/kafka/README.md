# `@d-contact/kafka`

Public contract สำหรับ service ที่ publish/consume domain event ผ่าน Kafka-compatible broker
ตาม [ADR-003](../../docs/adr/003-kafka-event-backbone.md) โดย dev ใช้ Redpanda

## กติกา contract

- ใช้ topic จาก `KAFKA_TOPICS` เท่านั้น; `dc.fs.events` ถูกปฏิเสธทั้ง type และ runtime
- producer กำหนด `eventId` คงที่เมื่อ retry เหตุการณ์เดิม
- `tenantId`, `eventId`, `correlationId` และ `orderingKey` อยู่ทั้ง envelope/header ตามที่ package สร้างให้
- package derive Kafka partition key จาก `orderingKey` ใน envelope และ consumer ตรวจว่าทั้งสามตำแหน่งตรงกัน
- idempotency boundary คือ unique `(consumerGroup, tenantId, eventId)`
- production consumer ต้องส่ง `EventIdempotencyStore` ที่ durable โดยใช้ฐานข้อมูลของ service ตนเอง
  และทำ business side effect กับการบันทึก idempotency key ให้ atomic
- `createInMemoryIdempotencyStore()` ใช้ได้เฉพาะ dev/test หรืองานไม่มี side effect เพราะ restart แล้วข้อมูลหาย
- Kafka/Redpanda เป็น event transport; ห้ามใช้ Redis pub/sub แทน และห้ามเข้าฐานข้อมูลของ service อื่น

## ตัวอย่าง service

```ts
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  createConsumer,
  createInMemoryIdempotencyStore,
  createProducer,
  type KafkaEventEnvelope,
} from '@d-contact/kafka';

const event: KafkaEventEnvelope<{ state: string }> = {
  eventId: '01K4...',
  type: 'agent.state_changed',
  tenantId: 'tenant-uuid',
  occurredAt: new Date().toISOString(),
  correlationId: 'request-or-workflow-id',
  orderingKey: 'agent-uuid',
  payload: { state: 'READY' },
};

const producer = await createProducer('new-service');
await producer.send(KAFKA_TOPICS.AGENT_EVENTS, event);

const consumer = await createConsumer({
  clientId: 'new-service',
  groupId: 'new-service-agent-events-v1',
  topics: [KAFKA_TOPICS.AGENT_EVENTS],
  // ตัวอย่างเท่านั้น — production ให้เปลี่ยนเป็น durable adapter ของ service นี้
  idempotency: createInMemoryIdempotencyStore(),
  handler: async ({ event, idempotencyKey }) => {
    // ทำงานเฉพาะข้อมูลที่ service นี้เป็นเจ้าของ
  },
});
```

รันหลักฐานกับ Redpanda จริงด้วย `pnpm --filter @d-contact/kafka test:integration`
