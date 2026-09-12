import {
  Kafka,
  Partitioners,
  logLevel,
  type Consumer,
  type IHeaders,
  type Producer,
} from 'kafkajs';
import { KAFKA_TOPICS, type KafkaTopic } from '@d-contact/shared';
import {
  KAFKA_EVENT_HEADERS,
  KafkaContractError,
  assertKafkaTopic,
  isKafkaEventEnvelopeV2,
  validateConsumedEvent,
  validateEventEnvelope,
  type KafkaEventEnvelope,
  type KafkaEventHeaders,
} from './contract';
import {
  assertIdempotencyStoreAllowed,
  type EventConsumerRuntime,
  type EventIdempotencyStore,
  type IdempotencyResult,
} from './idempotency';

export * from './contract';
export * from './idempotency';

/**
 * Wrapper กลางรอบ kafkajs — service ใช้ public API นี้เพื่อบังคับ topic, envelope,
 * tenant/correlation headers, ordering key และ idempotency boundary ตาม ADR-003
 */

export interface KafkaConnectionOptions {
  brokers?: string[];
}

function createKafka(clientId: string, options: KafkaConnectionOptions): Kafka {
  return new Kafka({
    clientId,
    brokers: options.brokers ?? (process.env.KAFKA_BROKERS ?? 'localhost:9092').split(','),
    logLevel: logLevel.WARN,
    retry: { initialRetryTime: 300, retries: 10 },
  });
}

export interface DcProducer {
  /** key ถูก derive จาก envelope เพื่อไม่ให้ partition key กับ contract คลาดกัน */
  send<TPayload extends Record<string, unknown>>(
    topic: KafkaTopic,
    event: KafkaEventEnvelope<TPayload>,
  ): Promise<void>;
  disconnect(): Promise<void>;
}

export async function createProducer(
  clientId: string,
  options: KafkaConnectionOptions = {},
): Promise<DcProducer> {
  const producer: Producer = createKafka(clientId, options).producer({
    allowAutoTopicCreation: false,
    createPartitioner: Partitioners.DefaultPartitioner,
  });
  await producer.connect();

  return {
    async send(topic, candidate) {
      assertKafkaTopic(topic);
      const event = validateEventEnvelope(candidate);
      const headers: Record<string, string> = {
        [KAFKA_EVENT_HEADERS.TENANT_ID]: event.tenantId,
        [KAFKA_EVENT_HEADERS.EVENT_ID]: event.eventId,
        [KAFKA_EVENT_HEADERS.CORRELATION_ID]: event.correlationId,
        [KAFKA_EVENT_HEADERS.ORDERING_KEY]: event.orderingKey,
      };
      if (isKafkaEventEnvelopeV2(event)) {
        headers[KAFKA_EVENT_HEADERS.SCHEMA_VERSION] = String(event.schemaVersion);
        headers[KAFKA_EVENT_HEADERS.AGGREGATE_ID] = event.aggregateId;
      }
      await producer.send({
        topic,
        messages: [
          {
            key: event.orderingKey,
            value: JSON.stringify(event),
            headers,
          },
        ],
      });
    },
    disconnect: () => producer.disconnect(),
  };
}

export interface ConsumedEvent<TPayload extends Record<string, unknown> = Record<string, unknown>> {
  topic: KafkaTopic;
  key: string;
  event: KafkaEventEnvelope<TPayload>;
  timestamp: string;
  idempotencyKey: Readonly<{
    consumerGroup: string;
    tenantId: string;
    eventId: string;
  }>;
}

export interface InvalidKafkaMessage {
  topic: string;
  partition: number;
  offset: string;
  error: KafkaContractError;
  /** ใช้ reason นี้ route invalid contract ไปยัง DLQ ของ consumer */
  dlqReason: KafkaContractError['code'];
}

export interface DlqPublisher {
  publish(message: InvalidKafkaMessage & { value: Buffer | null }): Promise<void>;
}

export interface DcDlqPublisher extends DlqPublisher {
  disconnect(): Promise<void>;
}

/** ส่ง invalid contract เข้า DLQ กลาง; ห้ามเขียน payload/key/header ต้นฉบับลง log. */
export async function createDlqPublisher(
  clientId: string,
  options: KafkaConnectionOptions = {},
): Promise<DcDlqPublisher> {
  const producer = createKafka(clientId, options).producer({ allowAutoTopicCreation: false });
  await producer.connect();
  return {
    async publish(message) {
      await producer.send({
        topic: KAFKA_TOPICS.DEAD_LETTER,
        messages: [
          {
            value: JSON.stringify({
              sourceTopic: message.topic,
              partition: message.partition,
              offset: message.offset,
              reason: message.dlqReason,
              payloadBase64: message.value?.toString('base64') ?? null,
            }),
            headers: { reason: message.dlqReason },
          },
        ],
      });
    },
    disconnect: () => producer.disconnect(),
  };
}

export interface CreateConsumerOptions<
  TPayload extends Record<string, unknown>,
  TContext = undefined,
> extends KafkaConnectionOptions {
  clientId: string;
  groupId: string;
  topics: KafkaTopic[];
  /** default ตาม NODE_ENV; production รับเฉพาะ store ที่ประกาศ DURABLE */
  runtime?: EventConsumerRuntime;
  idempotency: EventIdempotencyStore<TContext>;
  /** production ต้อง route invalid message เข้า DLQ และรอ acknowledgement ก่อน commit offset */
  dlq?: DlqPublisher;
  handler: (message: ConsumedEvent<TPayload>, context: TContext) => Promise<void> | void;
  onInvalidMessage?: (message: InvalidKafkaMessage) => Promise<void> | void;
  onDuplicate?: (message: ConsumedEvent<TPayload>) => Promise<void> | void;
}

export interface DcConsumer {
  /** resolve หลัง consumer group join เสร็จ เพื่อให้ producer ส่ง event โดยไม่ตกหล่น */
  ready(): Promise<void>;
  disconnect(): Promise<void>;
}

function decodeHeaders(headers: IHeaders | undefined): KafkaEventHeaders {
  if (!headers) return {};
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [name, value?.toString()]),
  ) as KafkaEventHeaders;
}

export async function createConsumer<
  TPayload extends Record<string, unknown> = Record<string, unknown>,
  TContext = undefined,
>(options: CreateConsumerOptions<TPayload, TContext>): Promise<DcConsumer> {
  assertIdempotencyStoreAllowed(
    options.idempotency,
    options.runtime ?? (process.env.NODE_ENV === 'production' ? 'production' : 'non-production'),
  );
  if (
    (options.runtime ??
      (process.env.NODE_ENV === 'production' ? 'production' : 'non-production')) === 'production' &&
    !options.dlq
  ) {
    throw new Error('production Kafka consumer ต้องกำหนด DlqPublisher');
  }
  for (const topic of options.topics) assertKafkaTopic(topic);

  const consumer: Consumer = createKafka(options.clientId, options).consumer({
    groupId: options.groupId,
  });
  await consumer.connect();
  await consumer.subscribe({ topics: options.topics, fromBeginning: false });
  let removeGroupJoin: () => void = () => undefined;
  const groupJoined = new Promise<void>((resolve) => {
    removeGroupJoin = consumer.on(consumer.events.GROUP_JOIN, () => {
      removeGroupJoin();
      resolve();
    });
  });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let event: KafkaEventEnvelope<TPayload>;
      try {
        if (!message.value) {
          throw new KafkaContractError('INVALID_JSON', 'message ไม่มี JSON payload');
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(message.value.toString());
        } catch {
          throw new KafkaContractError('INVALID_JSON', 'message payload ไม่ใช่ JSON ที่ถูกต้อง');
        }

        event = validateConsumedEvent<TPayload>(
          topic,
          message.key?.toString() ?? null,
          decodeHeaders(message.headers),
          decoded,
        );
      } catch (error) {
        if (!(error instanceof KafkaContractError)) throw error;
        const invalid = {
          topic,
          partition,
          offset: message.offset,
          error,
          dlqReason: error.code,
        };
        if (options.dlq) {
          await options.dlq.publish({ ...invalid, value: message.value ?? null });
        } else if (options.onInvalidMessage) {
          await options.onInvalidMessage(invalid);
        } else {
          throw new Error(
            `Kafka invalid message ต้องมี onInvalidMessage สำหรับ DLQ routing: ${error.code}`,
          );
        }
        return;
      }

      // อย่ารวม business handler ไว้ใน contract-error catch: handler ที่ล้มเหลวต้องส่ง error
      // กลับให้ KafkaJS เพื่อไม่ commit offset และต้อง retry ได้
      assertKafkaTopic(topic);
      const consumed: ConsumedEvent<TPayload> = {
        topic,
        key: event.orderingKey,
        event,
        timestamp: message.timestamp,
        idempotencyKey: {
          consumerGroup: options.groupId,
          tenantId: event.tenantId,
          eventId: event.eventId,
        },
      };

      const result: IdempotencyResult = await options.idempotency.execute(
        consumed.idempotencyKey,
        async (context) => options.handler(consumed, context),
      );
      if (result === 'duplicate') await options.onDuplicate?.(consumed);
    },
  });

  return { ready: () => groupJoined, disconnect: () => consumer.disconnect() };
}
