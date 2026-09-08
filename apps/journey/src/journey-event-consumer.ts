import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
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

function createDurableJourneyIdempotencyStore(database: PrismaClient): EventIdempotencyStore {
  return {
    async execute(key, work) {
      const alreadyProcessed = await withTenantDatabaseTransaction(
        database,
        key.tenantId,
        async (transaction) =>
          Boolean(
            await transaction.jrEventInbox.findFirst({
              where: { id: key.eventId, tenantId: key.tenantId, state: 'PROCESSED' },
              select: { id: true },
            }),
          ),
      );
      if (alreadyProcessed) return 'duplicate';
      await work(undefined);
      return 'processed';
    },
  };
}

export function createJourneyEventConsumer(
  options: CreateJourneyEventConsumerOptions,
): Promise<DcConsumer> {
  const consumerOptions: CreateConsumerOptions<{ event: InboundBusinessEvent }> = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.JOURNEY_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    idempotency: createDurableJourneyIdempotencyStore(options.database),
    handler: async ({ event }) => {
      if (event.type !== 'journey.business_event.received') return;
      await options.processor.processEvent(event.tenantId, {
        receiptId: event.eventId,
        ...options.definition,
      });
    },
  };
  return createConsumer(consumerOptions);
}
