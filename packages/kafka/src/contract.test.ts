import assert from 'node:assert/strict';
import test from 'node:test';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  KafkaContractError,
  assertKafkaTopic,
  createInMemoryIdempotencyStore,
  validateConsumedEvent,
  validateEventEnvelope,
  type KafkaEventEnvelope,
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
