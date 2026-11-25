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
 * Shared wrapper around kafkajs — services use this public API to enforce topics, envelope,
 * tenant/correlation headers, ordering key and idempotency boundary per ADR-003
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
  /** the key is derived from the envelope so the partition key and the contract cannot drift apart */
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
  /** additive: source position, used when a handler must send a business-level contract rejection to the DLQ */
  partition?: number;
  offset?: string;
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
  /** use this reason to route an invalid contract to the consumer's DLQ */
  dlqReason: KafkaContractError['code'];
}

export interface DlqPublisher {
  publish(message: InvalidKafkaMessage & { value: Buffer | null }): Promise<void>;
}

export interface DcDlqPublisher extends DlqPublisher {
  disconnect(): Promise<void>;
}

/**
 * a handler that decides a message passes the envelope but violates a domain contract (retrying gives the same result)
 * must hold it in the DLQ and let the offset commit — if it threw instead, the wrapper would retry forever and block the whole
 * partition; with no DLQ available, throw so the message is not lost silently
 */
export async function quarantineConsumedEvent(
  dlq: DlqPublisher | undefined,
  consumed: Pick<
    ConsumedEvent<Record<string, unknown>>,
    'topic' | 'partition' | 'offset' | 'event'
  >,
  reasonCode: string,
): Promise<void> {
  if (!dlq) {
    throw new Error(`message was quarantined (${reasonCode}) but the consumer has no DlqPublisher`);
  }
  await dlq.publish({
    topic: consumed.topic,
    partition: consumed.partition ?? -1,
    offset: consumed.offset ?? '-1',
    error: new KafkaContractError('INVALID_ENVELOPE', reasonCode),
    dlqReason: 'INVALID_ENVELOPE',
    value: Buffer.from(JSON.stringify(consumed.event)),
  });
}

/** Sends an invalid contract to the central DLQ; never write the original payload/key/header to the log. */
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
  /** defaults by NODE_ENV; production accepts only a store that declares DURABLE */
  runtime?: EventConsumerRuntime;
  idempotency: EventIdempotencyStore<TContext>;
  /** production must route invalid messages to the DLQ and wait for acknowledgement before committing the offset */
  dlq?: DlqPublisher;
  handler: (message: ConsumedEvent<TPayload>, context: TContext) => Promise<void> | void;
  onInvalidMessage?: (message: InvalidKafkaMessage) => Promise<void> | void;
  onDuplicate?: (message: ConsumedEvent<TPayload>) => Promise<void> | void;
}

export interface DcConsumer {
  /**
   * resolves after the consumer group has joined *and* the starting offset of every partition that received
   * an assignment has been pinned with consumer.seek() — so the producer can send events without loss.
   * Previously relying on the GROUP_JOIN event alone was not enough: a new consumer group subscribing with
   * `fromBeginning: false` has not finished resolving the "latest" offset when it joins the group (that happens
   * lazily later in fetch loop initialization), a real race where messages published between these two moments were lost
   * permanently (found from a flaky test that really failed ~25% of the time, not just timing — raising the timeout did not help). Fixed by
   * fetching the high-water-mark offset of each topic through the Admin client before subscribe/run, then seeking
   * to that offset as soon as the partition assignment is known from GROUP_JOIN — closing the race deterministically
   * instead of depending on kafkajs's internal event timing
   */
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
    throw new Error('production Kafka consumer must have a DlqPublisher configured');
  }
  for (const topic of options.topics) assertKafkaTopic(topic);

  const kafka = createKafka(options.clientId, options);
  const consumer: Consumer = kafka.consumer({
    groupId: options.groupId,
  });
  await consumer.connect();

  // capture the current high-water-mark offset of each topic before subscribe/run so we can seek deterministically
  // later — see the DcConsumer.ready() doc comment for the race this fixes
  const admin = kafka.admin();
  await admin.connect();
  const startOffsetsByTopic = new Map<string, Array<{ partition: number; offset: string }>>();
  for (const topic of options.topics) {
    const offsets = await admin.fetchTopicOffsets(topic);
    startOffsetsByTopic.set(
      topic,
      offsets.map(({ partition, offset }) => ({ partition, offset })),
    );
  }
  await admin.disconnect();

  await consumer.subscribe({ topics: options.topics, fromBeginning: false });
  let removeGroupJoin: () => void = () => undefined;
  const ready = new Promise<void>((resolve) => {
    removeGroupJoin = consumer.on(consumer.events.GROUP_JOIN, (event) => {
      removeGroupJoin();
      for (const [topic, partitions] of Object.entries(event.payload.memberAssignment)) {
        const startOffsets = startOffsetsByTopic.get(topic);
        if (!startOffsets) continue;
        for (const partition of partitions) {
          const startOffset = startOffsets.find((entry) => entry.partition === partition);
          if (startOffset) {
            consumer.seek({ topic, partition, offset: startOffset.offset });
          }
        }
      }
      resolve();
    });
  });

  await consumer.run({
    eachMessage: async ({ topic, partition, message }) => {
      let event: KafkaEventEnvelope<TPayload>;
      try {
        if (!message.value) {
          throw new KafkaContractError('INVALID_JSON', 'message has no JSON payload');
        }

        let decoded: unknown;
        try {
          decoded = JSON.parse(message.value.toString());
        } catch {
          throw new KafkaContractError('INVALID_JSON', 'message payload is not valid JSON');
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
            `Kafka invalid message must have onInvalidMessage for DLQ routing: ${error.code}`,
          );
        }
        return;
      }

      // do not put the business handler inside the contract-error catch: a failing handler must send the error
      // back to KafkaJS so the offset is not committed and it can be retried
      assertKafkaTopic(topic);
      const consumed: ConsumedEvent<TPayload> = {
        topic,
        key: event.orderingKey,
        event,
        timestamp: message.timestamp,
        partition,
        offset: message.offset,
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

  return { ready: () => ready, disconnect: () => consumer.disconnect() };
}
