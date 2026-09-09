# `@d-contact/kafka`

Public contract สำหรับ service ที่ publish/consume domain event ผ่าน Kafka-compatible broker
ตาม [ADR-003](../../docs/adr/003-kafka-event-backbone.md) โดย dev ใช้ Redpanda

## กติกา contract

- producer/consumer ของ business event ใช้ topic จาก `KAFKA_TOPICS` เท่านั้น; `dc.fs.events` และ DLQ ถูกปฏิเสธที่ Kafka envelope boundary
- producer กำหนด `eventId` คงที่เมื่อ retry เหตุการณ์เดิม
- V1 (ไม่มี top-level `schemaVersion`) ยัง decode ได้ระหว่าง migration; V2 ใช้ `schemaVersion: 2` พร้อม `eventKind`, `aggregateType`, `aggregateId`, `aggregateVersion` โดย `CANONICAL` เริ่ม version 1 ส่วน `INGRESS`/`COMMAND` ใช้ 0 ได้
- V2 มี `schemaVersion` และ `aggregateId` ใน header เพิ่มจาก `tenantId`, `eventId`, `correlationId` และ `orderingKey`; consumer ตรวจว่า key/header/payload ตรงกันก่อนเข้า handler
- consumer ที่เจอ schema version ไม่รองรับจะถูกส่งเข้า `DlqPublisher` พร้อม `UNSUPPORTED_SCHEMA_VERSION`; ต้องรอ broker ยืนยันการเขียน DLQ ก่อนจึง commit offset ต้นทาง
- package derive Kafka partition key จาก `orderingKey` ใน envelope และ consumer ตรวจว่าทั้งสามตำแหน่งตรงกัน
- idempotency boundary คือ unique `(consumerGroup, tenantId, eventId)`
- production consumer ต้องใช้ adapter ที่ประกาศ `durability: 'DURABLE'`, กำหนด `DlqPublisher`, และส่ง transaction context เข้า handler เพื่อให้ business side effect กับ dedupe key atomic หรือทำ durable claim/complete lifecycle ที่เทียบเท่า
- `createInMemoryIdempotencyStore()` มี `durability: 'EPHEMERAL'`; `createConsumer()` ปฏิเสธมันเมื่อ `NODE_ENV=production`
- Kafka/Redpanda เป็น event transport; ห้ามใช้ Redis pub/sub แทน และห้ามเข้าฐานข้อมูลของ service อื่น

## ตัวอย่าง service

```ts
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  createConsumer,
  createDlqPublisher,
  createInMemoryIdempotencyStore,
  createProducer,
  type KafkaEventEnvelopeV2,
} from '@d-contact/kafka';

const event: KafkaEventEnvelopeV2<{ state: string }> = {
  schemaVersion: 2,
  eventKind: 'CANONICAL',
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
const dlq = await createDlqPublisher('new-service-dlq');
await producer.send(KAFKA_TOPICS.AGENT_EVENTS, event);

const consumer = await createConsumer({
  clientId: 'new-service',
  groupId: 'new-service-agent-events-v2',
  topics: [KAFKA_TOPICS.AGENT_EVENTS],
  // ตัวอย่างเท่านั้น — production ให้เปลี่ยนเป็น durable adapter ของ service นี้
  idempotency: createInMemoryIdempotencyStore(),
  dlq,
  handler: async ({ event, idempotencyKey }) => {
    // ทำงานเฉพาะข้อมูลที่ service นี้เป็นเจ้าของ
  },
});
```

รันหลักฐานกับ Redpanda จริงด้วย `pnpm --filter @d-contact/kafka test:integration`
