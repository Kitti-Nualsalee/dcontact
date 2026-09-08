import assert from 'node:assert/strict';
import test from 'node:test';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  KafkaContractError,
  assertIdempotencyStoreAllowed,
  assertKafkaTopic,
  createConsumer,
  createInMemoryIdempotencyStore,
  normalizeKafkaEventEnvelope,
  validateConsumedEvent,
  validateEventEnvelope,
  type KafkaEventEnvelope,
  type KafkaEventEnvelopeV2,
  type EventIdempotencyStore,
} from './index';

const event: KafkaEventEnvelope<{ state: string }> = {
  eventId: 'event-34',
  type: 'agent.state_changed',
  tenantId: 'tenant-a',
  occurredAt: '2026-09-04T10:00:00.000Z',
  correlationId: 'correlation-34',
  orderingKey: 'agent-34',
  payload: { state: 'READY' },
};

const headers = {
  tenantId: event.tenantId,
  eventId: event.eventId,
  correlationId: event.correlationId,
  orderingKey: event.orderingKey,
};

const v2Event: KafkaEventEnvelopeV2<{ state: string }> = {
  schemaVersion: 2,
  eventId: 'event-35',
  type: 'agent.state_changed',
  tenantId: 'tenant-a',
  occurredAt: '2026-09-04T10:00:00.000Z',
  correlationId: 'correlation-35',
  orderingKey: 'agent-35',
  aggregateType: 'agent',
  aggregateId: 'agent-35',
  aggregateVersion: 7,
  payload: { state: 'READY' },
};

const v2Headers = {
  tenantId: v2Event.tenantId,
  eventId: v2Event.eventId,
  correlationId: v2Event.correlationId,
  orderingKey: v2Event.orderingKey,
  schemaVersion: '2',
  aggregateId: v2Event.aggregateId,
};

test('อนุญาตเฉพาะ topic กลางและปฏิเสธ dc.fs.events', () => {
  assert.doesNotThrow(() => assertKafkaTopic(KAFKA_TOPICS.AGENT_EVENTS));
  assert.throws(
    () => assertKafkaTopic('dc.fs.events'),
    (error: unknown) => error instanceof KafkaContractError && error.code === 'UNAPPROVED_TOPIC',
  );
});

test('ตรวจ envelope, tenant/correlation headers และ ordering key ก่อนเข้า handler', () => {
  assert.deepEqual(
    validateConsumedEvent(KAFKA_TOPICS.AGENT_EVENTS, event.orderingKey, headers, event),
    event,
  );

  assert.throws(
    () =>
      validateConsumedEvent(
        KAFKA_TOPICS.AGENT_EVENTS,
        event.orderingKey,
        { ...headers, tenantId: 'tenant-b' },
        event,
      ),
    (error: unknown) =>
      error instanceof KafkaContractError && error.code === 'HEADER_PAYLOAD_MISMATCH',
  );
  assert.throws(
    () => validateConsumedEvent(KAFKA_TOPICS.AGENT_EVENTS, 'agent-other', headers, event),
    (error: unknown) =>
      error instanceof KafkaContractError && error.code === 'ORDERING_KEY_MISMATCH',
  );
});

test('รับ V1 แบบ legacy และ normalize โดยไม่สร้าง aggregate fact', () => {
  const validated = validateEventEnvelope(event);
  assert.deepEqual(normalizeKafkaEventEnvelope(validated), { format: 'V1_LEGACY', event });
});

test('ตรวจ V2 aggregate metadata และ headers ก่อนเข้า handler', () => {
  assert.deepEqual(
    validateConsumedEvent(KAFKA_TOPICS.AGENT_EVENTS, v2Event.orderingKey, v2Headers, v2Event),
    v2Event,
  );

  assert.throws(
    () =>
      validateConsumedEvent(
        KAFKA_TOPICS.AGENT_EVENTS,
        v2Event.orderingKey,
        { ...v2Headers, aggregateId: 'agent-other' },
        v2Event,
      ),
    (error: unknown) =>
      error instanceof KafkaContractError && error.code === 'HEADER_PAYLOAD_MISMATCH',
  );
  assert.throws(
    () =>
      validateConsumedEvent(
        KAFKA_TOPICS.AGENT_EVENTS,
        v2Event.orderingKey,
        { ...v2Headers, schemaVersion: undefined },
        v2Event,
      ),
    (error: unknown) => error instanceof KafkaContractError && error.code === 'MISSING_HEADER',
  );
});

test('ปฏิเสธ schema version ที่ไม่รองรับเพื่อให้ consumer route เข้า DLQ ได้', () => {
  assert.throws(
    () => validateEventEnvelope({ ...v2Event, schemaVersion: 3 }),
    (error: unknown) =>
      error instanceof KafkaContractError && error.code === 'UNSUPPORTED_SCHEMA_VERSION',
  );
  assert.throws(
    () => validateEventEnvelope({ ...v2Event, aggregateVersion: -1 }),
    (error: unknown) => error instanceof KafkaContractError && error.code === 'INVALID_ENVELOPE',
  );
});

test('ปฏิเสธ envelope ที่ไม่มี stable event identifier หรือ correlation context', () => {
  assert.throws(() => validateEventEnvelope({ ...event, eventId: '' }), KafkaContractError);
  assert.throws(() => validateEventEnvelope({ ...event, correlationId: '' }), KafkaContractError);
});

test('idempotency boundary ประมวลผล (consumerGroup, tenantId, eventId) ครั้งเดียว', async () => {
  const store = createInMemoryIdempotencyStore();
  const key = { consumerGroup: 'router', tenantId: 'tenant-a', eventId: 'event-34' };
  let handled = 0;

  const results = await Promise.all([
    store.execute(key, async () => {
      handled += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }),
    store.execute(key, async () => {
      handled += 1;
    }),
  ]);

  assert.equal(handled, 1);
  assert.deepEqual(results.sort(), ['duplicate', 'processed']);
});

test('งานที่ล้มเหลวไม่ถูกทำเครื่องหมายว่าสำเร็จและ retry ได้', async () => {
  const store = createInMemoryIdempotencyStore();
  const key = { consumerGroup: 'router', tenantId: 'tenant-a', eventId: 'retry-34' };

  await assert.rejects(() =>
    store.execute(key, async () => Promise.reject(new Error('temporary'))),
  );
  assert.equal(await store.execute(key, async () => undefined), 'processed');
});

test('idempotency key เดียวกันคนละ tenant มี lifecycle แยกกัน', async () => {
  const store = createInMemoryIdempotencyStore();
  const key = { consumerGroup: 'router', eventId: 'event-shared' };

  assert.equal(
    await store.execute({ ...key, tenantId: 'tenant-a' }, async () => undefined),
    'processed',
  );
  assert.equal(
    await store.execute({ ...key, tenantId: 'tenant-b' }, async () => undefined),
    'processed',
  );
});

test('production consumer ปฏิเสธ in-memory store และ durable contract ส่ง context เข้า handler', async () => {
  const ephemeral = createInMemoryIdempotencyStore();
  assert.throws(
    () => assertIdempotencyStoreAllowed(ephemeral, 'production'),
    /durability เป็น DURABLE/,
  );

  const transaction = { transactionId: 'tx-1' };
  const committed = new Set<string>();
  const durableFixture: EventIdempotencyStore<typeof transaction> = {
    durability: 'DURABLE',
    async execute(key, work) {
      const serialized = `${key.consumerGroup}:${key.tenantId}:${key.eventId}`;
      if (committed.has(serialized)) return 'duplicate';
      await work(transaction);
      committed.add(serialized);
      return 'processed';
    },
  };
  const key = { consumerGroup: 'journey', tenantId: 'tenant-a', eventId: 'event-atomic' };

  await assert.rejects(() =>
    durableFixture.execute(key, async () => Promise.reject(new Error('crash'))),
  );
  assert.equal(
    await durableFixture.execute(key, async (context) => {
      assert.equal(context, transaction);
    }),
    'processed',
  );
  assert.equal(await durableFixture.execute(key, async () => undefined), 'duplicate');
  assert.doesNotThrow(() => assertIdempotencyStoreAllowed(durableFixture, 'production'));
  assert.throws(
    () =>
      assertIdempotencyStoreAllowed({ execute: async (_key, _work) => 'processed' }, 'production'),
    /durability เป็น DURABLE/,
  );
});

test('createConsumer ปฏิเสธ in-memory store ก่อนเชื่อมต่อ production broker', async () => {
  await assert.rejects(
    () =>
      createConsumer({
        clientId: 'contract-test',
        groupId: 'contract-test',
        topics: [KAFKA_TOPICS.AGENT_EVENTS],
        runtime: 'production',
        idempotency: createInMemoryIdempotencyStore(),
        handler: async () => undefined,
      }),
    /durability เป็น DURABLE/,
  );
});
