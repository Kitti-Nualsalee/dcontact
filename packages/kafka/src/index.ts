import { Kafka, logLevel, type Consumer, type Producer } from 'kafkajs';
import type { KafkaTopic } from '@d-contact/shared';

/**
 * Wrapper กลางรอบ kafkajs — ทุก service ต้อง produce/consume ผ่านไฟล์นี้เท่านั้น
 * เพื่อบังคับ convention เดียวกัน (JSON serde, tenantId header, graceful shutdown)
 * และให้เปลี่ยน client lib / เพิ่ม schema registry ได้ที่จุดเดียว (ดู ADR-003)
 */

export interface EventEnvelope {
  tenantId: string;
  [key: string]: unknown;
}

export interface ConsumedMessage<T = EventEnvelope> {
  topic: string;
  key: string | null;
  value: T;
  /** tenantId จาก message header (fallback ไปที่ payload) */
  tenantId: string | null;
  timestamp: string;
}

function createKafka(clientId: string): Kafka {
  return new Kafka({
    clientId,
    brokers: (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 10 },
  });
}

export interface DcProducer {
  send(topic: KafkaTopic, key: string, event: EventEnvelope): Promise<void>;
  disconnect(): Promise<void>;
}

export async function createProducer(clientId: string): Promise<DcProducer> {
  const producer: Producer = createKafka(clientId).producer({
    allowAutoTopicCreation: false,
  });
  await producer.connect();
  console.log(`[kafka] producer connected (${clientId})`);

  return {
    async send(topic, key, event) {
      await producer.send({
        topic,
        messages: [
          {
            key,
            value: JSON.stringify(event),
            headers: { tenantId: event.tenantId },
          },
        ],
      });
    },
    disconnect: () => producer.disconnect(),
  };
}

export interface DcConsumer {
  disconnect(): Promise<void>;
}

export async function createConsumer<T = EventEnvelope>(
  groupId: string,
  topics: KafkaTopic[],
  handler: (message: ConsumedMessage<T>) => Promise<void> | void,
): Promise<DcConsumer> {
  const consumer: Consumer = createKafka(groupId).consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topics, fromBeginning: false });
  console.log(`[kafka] consumer subscribed (group=${groupId}, topics=${topics.join(',')})`);

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      if (!message.value) return;
      let value: T;
      try {
        value = JSON.parse(message.value.toString()) as T;
      } catch {
        console.error(`[kafka] skip malformed message on ${topic}`);
        return;
      }
      const headerTenant = message.headers?.tenantId?.toString() ?? null;
      await handler({
        topic,
        key: message.key?.toString() ?? null,
        value,
        tenantId: headerTenant ?? ((value as EventEnvelope)?.tenantId as string) ?? null,
        timestamp: message.timestamp,
      });
    },
  });

  return { disconnect: () => consumer.disconnect() };
}
