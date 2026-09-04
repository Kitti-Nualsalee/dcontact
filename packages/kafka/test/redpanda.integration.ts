import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  createConsumer,
  createInMemoryIdempotencyStore,
  createProducer,
  type KafkaEventEnvelope,
} from '@d-contact/kafka';

test(
  'service produce/consume contract ผ่าน Redpanda และ dedupe event ซ้ำ',
  { timeout: 30_000 },
  async () => {
    const suffix = randomUUID();
    const clientId = `issue-34-${suffix}`;
    const groupId = `issue-34-${suffix}`;
    const received: KafkaEventEnvelope[] = [];
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
        received.push(message.event);
      },
      onDuplicate: () => {
        duplicateCount += 1;
        resolveDuplicate();
      },
    });
    const producer = await createProducer(`${clientId}-producer`, { brokers: ['localhost:9092'] });

    const event: KafkaEventEnvelope<{ state: string; sourceService: string }> = {
      eventId: `event-${suffix}`,
      type: 'agent.state_changed',
      tenantId: `tenant-${suffix}`,
      occurredAt: new Date().toISOString(),
      correlationId: `correlation-${suffix}`,
      orderingKey: `agent-${suffix}`,
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
