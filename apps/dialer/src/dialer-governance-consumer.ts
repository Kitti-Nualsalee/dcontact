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
import type { DialerGovernanceInvalidationService } from './dialer-governance.js';

/** GAP ต้องเข้ามา apply ซ้ำได้หลัง replay; completion อื่นเป็น duplicate ที่ no-op. */
export function createDurableDialerGovernanceIdempotencyStore(
  database: PrismaClient,
): EventIdempotencyStore<Prisma.TransactionClient> {
  return {
    durability: 'DURABLE',
    async execute(key, work) {
      return withTenantDatabaseTransaction(database, key.tenantId, async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`dialer-cg3-consumer:${key.consumerGroup}:${key.tenantId}:${key.eventId}`}))`,
        );
        const existing = await transaction.obGovernanceConsumerInbox.findUnique({
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
        const completed = await transaction.obGovernanceConsumerInbox.findUnique({
          where: {
            consumer_tenantId_eventId: {
              consumer: key.consumerGroup,
              tenantId: key.tenantId,
              eventId: key.eventId,
            },
          },
          select: { state: true },
        });
        if (!completed)
          throw new Error('Dialer CG3 handler ต้อง commit owner-local inbox ก่อนสำเร็จ');
        return 'processed';
      });
    },
  };
}

export interface CreateDialerGovernanceConsumerOptions {
  database: PrismaClient;
  service: DialerGovernanceInvalidationService;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
}

export function createDialerGovernanceConsumer(
  options: CreateDialerGovernanceConsumerOptions,
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
    idempotency: createDurableDialerGovernanceIdempotencyStore(options.database),
    handler: async ({ event }, transaction) => {
      if (!isKafkaEventEnvelopeV2(event))
        throw new TypeError('Dialer CG3 consumer ไม่รับ Kafka V1 event');
      await options.service.apply(event, transaction);
    },
  };
  return createConsumer(consumerOptions);
}
