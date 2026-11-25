import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  createConsumer,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import { KAFKA_TOPICS, type InboundBusinessEvent } from '@d-contact/shared';
import type { JourneyProcessor, ProcessJourneyEventInput } from './journey-processor.js';

export type JourneyTriggerDefinition = Omit<ProcessJourneyEventInput, 'receiptId'>;

export interface CreateJourneyEventConsumerOptions {
  database: PrismaClient;
  processor: JourneyProcessor;
  definition: JourneyTriggerDefinition;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
}

/**
 * Uses jr_kafka_consumer_inbox as the complete record of the Journey consumer. An advisory
 * lock lets only one of the concurrent workers call the handler successfully; the complete
 * record has unique (consumerGroup, tenantId, eventId) and commits together with the outcome.
 */
export function createDurableJourneyIdempotencyStore(
  database: PrismaClient,
): EventIdempotencyStore<Prisma.TransactionClient> {
  return {
    durability: 'DURABLE',
    async execute(key, work) {
      return withTenantDatabaseTransaction(database, key.tenantId, async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`journey-kafka:${key.consumerGroup}:${key.tenantId}:${key.eventId}`}))`,
        );
        const completed = await transaction.jrKafkaConsumerInbox.findUnique({
          where: {
            consumerGroup_tenantId_eventId: {
              consumerGroup: key.consumerGroup,
              tenantId: key.tenantId,
              eventId: key.eventId,
            },
          },
          select: { completedAt: true },
        });
        if (completed) return 'duplicate';

        const inbox = await transaction.jrEventInbox.findFirst({
          where: { id: key.eventId, tenantId: key.tenantId },
          select: { id: true },
        });
        if (!inbox) {
          throw new Error('Journey inbox event not found for the Kafka idempotency boundary');
        }

        await work(transaction);

        const processedInbox = await transaction.jrEventInbox.findFirst({
          where: { id: key.eventId, tenantId: key.tenantId, state: 'PROCESSED' },
          select: { id: true },
        });
        if (!processedInbox) {
          throw new Error(
            'Journey Kafka handler must commit the inbox state as PROCESSED before succeeding',
          );
        }
        await transaction.jrKafkaConsumerInbox.create({
          data: {
            consumerGroup: key.consumerGroup,
            tenantId: key.tenantId,
            eventId: key.eventId,
          },
        });
        return 'processed';
      });
    },
  };
}

export function createJourneyEventConsumer(
  options: CreateJourneyEventConsumerOptions,
): Promise<DcConsumer> {
  const consumerOptions: CreateConsumerOptions<
    { event: InboundBusinessEvent },
    Prisma.TransactionClient
  > = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.JOURNEY_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableJourneyIdempotencyStore(options.database),
    handler: async ({ event }, transaction) => {
      if (event.type !== 'journey.business_event.received') return;
      await options.processor.processEvent(
        event.tenantId,
        {
          receiptId: event.eventId,
          ...options.definition,
        },
        transaction,
      );
    },
  };
  return createConsumer(consumerOptions);
}
