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
import type { JourneyGovernanceInvalidationService } from './journey-governance-invalidation.js';

/**
 * `GAP` intentionally is not terminal idempotency: a redriven event must re-enter
 * the handler after the missing version has been restored. Other states have a
 * committed Journey effect and are strict duplicates.
 */
export function createDurableJourneyGovernanceIdempotencyStore(
  database: PrismaClient,
): EventIdempotencyStore<Prisma.TransactionClient> {
  return {
    durability: 'DURABLE',
    async execute(key, work) {
      return withTenantDatabaseTransaction(database, key.tenantId, async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-cg3-consumer:${key.consumerGroup}:${key.tenantId}:${key.eventId}`}))`,
        );
        const existing = await transaction.jrGovernanceConsumerInbox.findUnique({
          where: {
            consumer_tenantId_eventId: {
              consumer: key.consumerGroup,
              tenantId: key.tenantId,
              eventId: key.eventId,
            },
          },
          select: { state: true },
        });
        if (existing && existing.state !== 'GAP') return 'duplicate';
        await work(transaction);
        const completed = await transaction.jrGovernanceConsumerInbox.findUnique({
          where: {
            consumer_tenantId_eventId: {
              consumer: key.consumerGroup,
              tenantId: key.tenantId,
              eventId: key.eventId,
            },
          },
          select: { state: true },
        });
        if (!completed) {
          throw new Error('Journey CG3 handler ต้อง commit owner-local inbox ก่อนสำเร็จ');
        }
        return 'processed';
      });
    },
  };
}

export interface CreateJourneyGovernanceConsumerOptions {
  database: PrismaClient;
  service: JourneyGovernanceInvalidationService;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
}

/** Subscribe only to canonical CG3 facts; validation and fail-closed version handling live in the service. */
export function createJourneyGovernanceConsumer(
  options: CreateJourneyGovernanceConsumerOptions,
): Promise<DcConsumer> {
  const consumerOptions: CreateConsumerOptions<
    Record<string, unknown>,
    Prisma.TransactionClient
  > = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.CONTACT_GOVERNANCE_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableJourneyGovernanceIdempotencyStore(options.database),
    handler: async ({ event }, transaction) => {
      if (!isKafkaEventEnvelopeV2(event)) {
        throw new TypeError('Journey CG3 consumer ไม่รับ Kafka V1 event');
      }
      await options.service.apply(event, transaction);
    },
  };
  return createConsumer(consumerOptions);
}
