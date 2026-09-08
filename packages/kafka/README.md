# `@d-contact/kafka`

Public contract สำหรับ service ที่ publish/consume domain event ผ่าน Kafka-compatible broker
ตาม [ADR-003](../../docs/adr/003-kafka-event-backbone.md) โดย dev ใช้ Redpanda

## กติกา contract

- ใช้ topic จาก `KAFKA_TOPICS` เท่านั้น; `dc.fs.events` ถูกปฏิเสธทั้ง type และ runtime
- producer กำหนด `eventId` คงที่เมื่อ retry เหตุการณ์เดิม
- V1 (ไม่มี top-level `schemaVersion`) ยัง decode ได้ระหว่าง migration; V2 ใช้ `schemaVersion: 2` พร้อม `aggregateType`, `aggregateId`, `aggregateVersion`
- V2 มี `schemaVersion` และ `aggregateId` ใน header เพิ่มจาก `tenantId`, `eventId`, `correlationId` และ `orderingKey`; consumer ตรวจว่า key/header/payload ตรงกันก่อนเข้า handler
- consumer ที่เจอ schema version ไม่รองรับจะได้รับ `UNSUPPORTED_SCHEMA_VERSION` ผ่าน `onInvalidMessage` พร้อม `dlqReason` เพื่อ route เข้า DLQ โดยไม่เดา contract
- package derive Kafka partition key จาก `orderingKey` ใน envelope และ consumer ตรวจว่าทั้งสามตำแหน่งตรงกัน
- idempotency boundary คือ unique `(consumerGroup, tenantId, eventId)`
- adapter ใหม่สำหรับ production ควรประกาศ `durability: 'DURABLE'` และส่ง transaction context เข้า handler เพื่อให้ business side effect กับ dedupe key atomic
- `createInMemoryIdempotencyStore()` มี `durability: 'EPHEMERAL'`; `createConsumer()` ปฏิเสธมันเมื่อ `NODE_ENV=production`
- Kafka/Redpanda เป็น event transport; ห้ามใช้ Redis pub/sub แทน และห้ามเข้าฐานข้อมูลของ service อื่น

## ตัวอย่าง service

```ts
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  createConsumer,
  createInMemoryIdempotencyStore,
  createProducer,
  type KafkaEventEnvelopeV2,
} from '@d-contact/kafka';

const event: KafkaEventEnvelopeV2<{ state: string }> = {
  schemaVersion: 2,
  eventId: '01K4...',
  type: 'agent.state_changed',
  tenantId: 'tenant-uuid',
  occurredAt: new Date().toISOString(),
  correlationId: 'request-or-workflow-id',
  orderingKey: 'agent-uuid',
  aggregateType: 'agent',
  aggregateId: 'agent-uuid',
  aggregateVersion: 1,
  payload: { state: 'READY' },
};

const producer = await createProducer('new-service');
await producer.send(KAFKA_TOPICS.AGENT_EVENTS, event);

const consumer = await createConsumer({
  clientId: 'new-service',
  groupId: 'new-service-agent-events-v2',
  topics: [KAFKA_TOPICS.AGENT_EVENTS],
  // ตัวอย่างเท่านั้น — production ให้เปลี่ยนเป็น durable adapter ของ service นี้
  idempotency: createInMemoryIdempotencyStore(),
  handler: async ({ event, idempotencyKey }) => {
    // ทำงานเฉพาะข้อมูลที่ service นี้เป็นเจ้าของ
  },
});
```

รันหลักฐานกับ Redpanda จริงด้วย `pnpm --filter @d-contact/kafka test:integration`
