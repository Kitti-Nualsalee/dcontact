import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  createConsumer,
  createInMemoryIdempotencyStore,
  createProducer,
  isKafkaEventEnvelopeV2,
  type KafkaEventEnvelopeV2,
} from '@d-contact/kafka';

test(
  'service produce/consume contract ผ่าน Redpanda และ dedupe event ซ้ำ',
  { timeout: 30_000 },
  async () => {
    const suffix = randomUUID();
    const clientId = `issue-34-${suffix}`;
    const groupId = `issue-34-${suffix}`;
    const received: KafkaEventEnvelopeV2[] = [];
    let duplicateCount = 0;
    let resolveDuplicate!: () => void;
    const duplicateObserved = new Promise<void>((resolve) => {
      resolveDuplicate = resolve;
    });

    const consumer = await createConsumer({
      clientId: `${clientId}-consumer`,
      groupId,
      topics: [KAFKA_TOPICS.AGENT_EVENTS],
      brokers: ['localhost:9092'],
      idempotency: createInMemoryIdempotencyStore(),
      handler: (message) => {
        assert.ok(isKafkaEventEnvelopeV2(message.event));
        received.push(message.event);
      },
      onDuplicate: () => {
        duplicateCount += 1;
        resolveDuplicate();
      },
    });
    const producer = await createProducer(`${clientId}-producer`, { brokers: ['localhost:9092'] });

    const event: KafkaEventEnvelopeV2<{ state: string; sourceService: string }> = {
      schemaVersion: 2,
      eventId: `event-${suffix}`,
      type: 'agent.state_changed',
      tenantId: `tenant-${suffix}`,
      occurredAt: new Date().toISOString(),
      correlationId: `correlation-${suffix}`,
      orderingKey: `agent-${suffix}`,
      aggregateType: 'agent',
      aggregateId: `agent-${suffix}`,
      aggregateVersion: 1,
      payload: { state: 'READY', sourceService: 'representative-service' },
    };

    try {
      await producer.send(KAFKA_TOPICS.AGENT_EVENTS, event);
      await producer.send(KAFKA_TOPICS.AGENT_EVENTS, event);
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        duplicateObserved,
        new Promise<never>(
          (_, reject) =>
            (timeout = setTimeout(
              () => reject(new Error('ไม่พบ duplicate event จาก Redpanda ภายในเวลา')),
              10_000,
            )),
        ),
      ]);
      if (timeout) clearTimeout(timeout);

      assert.equal(received.length, 1);
      assert.deepEqual(received[0], event);
      assert.equal(duplicateCount, 1);
    } finally {
      await producer.disconnect();
      await consumer.disconnect();
    }
  },
);
