import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Kafka } from 'kafkajs';
import { KAFKA_TOPICS } from '@d-contact/shared';
import {
  createConsumer,
  createDlqPublisher,
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
      eventKind: 'CANONICAL',
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
      await consumer.ready();
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

test(
  'schema version ที่ไม่รองรับถูกเขียนเข้า DLQ ก่อน consumer commit offset ต้นทาง',
  { timeout: 30_000 },
  async () => {
    const suffix = randomUUID();
    const clientId = `issue-66-dlq-${suffix}`;
    const broker = 'localhost:9092';
    const kafka = new Kafka({ clientId, brokers: [broker] });
    const admin = kafka.admin();
    const dlqConsumer = kafka.consumer({ groupId: `${clientId}-dlq-observer` });
    const rawProducer = kafka.producer({ allowAutoTopicCreation: false });
    const dlqMessages: Array<Record<string, unknown>> = [];
    let resolveDlq!: () => void;
    const dlqObserved = new Promise<void>((resolve) => {
      resolveDlq = resolve;
    });

    await admin.connect();
    const topics = await admin.listTopics();
    if (!topics.includes(KAFKA_TOPICS.DEAD_LETTER)) {
      await admin.createTopics({ topics: [{ topic: KAFKA_TOPICS.DEAD_LETTER }] });
    }
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({ topic: KAFKA_TOPICS.DEAD_LETTER, fromBeginning: false });
    let resolveDlqGroupJoin!: () => void;
    const dlqGroupJoined = new Promise<void>((resolve) => {
      resolveDlqGroupJoin = resolve;
    });
    dlqConsumer.on(dlqConsumer.events.GROUP_JOIN, () => resolveDlqGroupJoin());
    await dlqConsumer.run({
      eachMessage: async ({ message }) => {
        if (!message.value) return;
        dlqMessages.push(JSON.parse(message.value.toString()) as Record<string, unknown>);
        resolveDlq();
      },
    });
    await dlqGroupJoined;

    const dlq = await createDlqPublisher(`${clientId}-publisher`, { brokers: [broker] });
    const sourceGroupId = `${clientId}-source`;
    const consumer = await createConsumer({
      clientId: `${clientId}-consumer`,
      groupId: sourceGroupId,
      topics: [KAFKA_TOPICS.AGENT_EVENTS],
      brokers: [broker],
      idempotency: createInMemoryIdempotencyStore(),
      dlq,
      handler: async () => assert.fail('invalid event must not reach business handler'),
    });
    await consumer.ready();
    await rawProducer.connect();

    try {
      const invalid = {
        schemaVersion: 3,
        eventId: `event-${suffix}`,
        type: 'agent.state_changed',
        tenantId: `tenant-${suffix}`,
        occurredAt: new Date().toISOString(),
        correlationId: `correlation-${suffix}`,
        orderingKey: `agent-${suffix}`,
        aggregateType: 'agent',
        aggregateId: `agent-${suffix}`,
        aggregateVersion: 1,
        payload: { state: 'READY' },
      };
      const sourceMetadata = await rawProducer.send({
        topic: KAFKA_TOPICS.AGENT_EVENTS,
        messages: [
          {
            key: invalid.orderingKey,
            value: JSON.stringify(invalid),
            headers: {
              tenantId: invalid.tenantId,
              eventId: invalid.eventId,
              correlationId: invalid.correlationId,
              orderingKey: invalid.orderingKey,
              schemaVersion: '3',
              aggregateId: invalid.aggregateId,
            },
          },
        ],
      });
      let timeout: NodeJS.Timeout | undefined;
      await Promise.race([
        dlqObserved,
        new Promise<never>(
          (_, reject) =>
            (timeout = setTimeout(
              () => reject(new Error('ไม่พบ invalid event ใน DLQ ภายในเวลา')),
              10_000,
            )),
        ),
      ]);
      if (timeout) clearTimeout(timeout);

      const source = sourceMetadata[0];
      assert.ok(source);
      const sourceOffset = BigInt(source.baseOffset);
      const deadline = Date.now() + 10_000;
      while (true) {
        const offsets = await admin.fetchOffsets({
          groupId: sourceGroupId,
          topics: [KAFKA_TOPICS.AGENT_EVENTS],
        });
        const committed = offsets
          .flatMap((topic) => topic.partitions)
          .find((partition) => partition.partition === source.partition)?.offset;
        if (committed && BigInt(committed) > sourceOffset) break;
        if (Date.now() >= deadline) {
          throw new Error('source offset ไม่ถูก commit หลัง DLQ acknowledgement');
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      assert.equal(dlqMessages.length, 1);
      assert.equal(dlqMessages[0]?.sourceTopic, KAFKA_TOPICS.AGENT_EVENTS);
      assert.equal(dlqMessages[0]?.reason, 'UNSUPPORTED_SCHEMA_VERSION');
    } finally {
      await Promise.all([
        rawProducer.disconnect(),
        consumer.disconnect(),
        dlq.disconnect(),
        dlqConsumer.disconnect(),
        admin.disconnect(),
      ]);
    }
  },
);
