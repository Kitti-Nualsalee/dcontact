import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  createConsumer,
  type CreateConsumerOptions,
  type DcConsumer,
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
}

/**
 * ใช้ jr_event_inbox เป็น complete record ของ Journey consumer. Advisory lock
 * ทำให้ worker พร้อมกันมีผู้เรียก handler สำเร็จได้เพียงรายเดียว; เมื่อ handler
 * commit state PROCESSED แล้ว retry/restart จะคืน duplicate โดยไม่เรียก handler.
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
        const inbox = await transaction.jrEventInbox.findFirst({
          where: { id: key.eventId, tenantId: key.tenantId },
          select: { state: true },
        });
        if (!inbox) {
          throw new Error('ไม่พบ Journey inbox event สำหรับ Kafka idempotency boundary');
        }
        if (inbox.state === 'PROCESSED') return 'duplicate';

        await work(transaction);

        const completed = await transaction.jrEventInbox.findFirst({
          where: { id: key.eventId, tenantId: key.tenantId, state: 'PROCESSED' },
          select: { id: true },
        });
        if (!completed) {
          throw new Error(
            'Journey Kafka handler ต้อง commit inbox state เป็น PROCESSED ก่อนสำเร็จ',
          );
        }
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
