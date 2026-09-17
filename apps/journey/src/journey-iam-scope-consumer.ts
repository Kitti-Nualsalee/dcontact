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

/** Event inbox คือ durable completion boundary; cursor และ inbox ต้อง commit พร้อมกันเสมอ. */
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
          throw new Error('Journey IAM handler ต้อง commit owner-local inbox ก่อนสำเร็จ');
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

/** รับเฉพาะ IAM canonical facts จาก ADMIN_EVENTS; malformed contract จะ throw/fail closed ไป DLQ. */
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
        throw new TypeError('Journey IAM consumer ไม่รับ Kafka V1 event');
      }
      await options.service.apply(event, options.groupId, transaction);
    },
  };
  return createConsumer(consumerOptions);
}
