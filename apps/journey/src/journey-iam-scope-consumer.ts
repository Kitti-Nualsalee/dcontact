import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  createConsumer,
  isKafkaEventEnvelopeV2,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import type { JourneyIamScopeInvalidationService } from './journey-iam-scope-invalidation.js';

/** The event inbox is the durable completion boundary; the cursor and inbox must always commit together. */
export function createDurableJourneyIamScopeIdempotencyStore(
  database: PrismaClient,
): EventIdempotencyStore<Prisma.TransactionClient> {
  return {
    durability: 'DURABLE',
    async execute(key, work) {
      return withTenantDatabaseTransaction(database, key.tenantId, async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-iam-scope:${key.consumerGroup}:${key.tenantId}:${key.eventId}`}))`,
        );
        const existing = await transaction.jrIamScopeInvalidationInbox.findUnique({
          where: {
            consumer_tenantId_eventId: {
              consumer: key.consumerGroup,
              tenantId: key.tenantId,
              eventId: key.eventId,
            },
          },
          select: { eventId: true },
        });
        if (existing) return 'duplicate';
        await work(transaction);
        const completed = await transaction.jrIamScopeInvalidationInbox.findUnique({
          where: {
            consumer_tenantId_eventId: {
              consumer: key.consumerGroup,
              tenantId: key.tenantId,
              eventId: key.eventId,
            },
          },
          select: { eventId: true },
        });
        if (!completed) {
          throw new Error(
            'Journey IAM handler must commit the owner-local inbox before succeeding',
          );
        }
        return 'processed';
      });
    },
  };
}

export interface CreateJourneyIamScopeConsumerOptions {
  database: PrismaClient;
  service: JourneyIamScopeInvalidationService;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
}

/** Accepts only canonical IAM facts from ADMIN_EVENTS; a malformed contract throws/fails closed to the DLQ. */
export function createJourneyIamScopeConsumer(
  options: CreateJourneyIamScopeConsumerOptions,
): Promise<DcConsumer> {
  const consumerOptions: CreateConsumerOptions<
    Record<string, unknown>,
    Prisma.TransactionClient
  > = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.ADMIN_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableJourneyIamScopeIdempotencyStore(options.database),
    handler: async ({ event }, transaction) => {
      if (!isKafkaEventEnvelopeV2(event)) {
        throw new TypeError('Journey IAM consumer does not accept Kafka V1 events');
      }
      await options.service.apply(event, options.groupId, transaction);
    },
  };
  return createConsumer(consumerOptions);
}
