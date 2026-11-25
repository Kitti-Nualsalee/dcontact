import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { isGovernanceContractRejection } from '@d-contact/cxa-contracts';
import {
  createConsumer,
  isKafkaEventEnvelopeV2,
  KafkaContractError,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';
import type { JourneyGovernanceInvalidationService } from './journey-governance-invalidation.js';

/**
 * `GAP` is deliberately not terminal idempotency: a redrive must be able to re-enter the handler once
 * the missing version is recovered, while other states have a committed Journey effect and are therefore strict duplicates
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
          throw new Error(
            'Journey CG3 handler must commit the owner-local inbox before succeeding',
          );
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

/** Accepts only canonical CG3 facts; validation and fail-closed version handling live in the service */
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
    handler: async ({ event, topic, partition, offset }, transaction) => {
      if (!isKafkaEventEnvelopeV2(event)) {
        throw new TypeError('Journey CG3 consumer does not accept Kafka V1 events');
      }
      const result = await options.service.apply(event, transaction);
      if (options.dlq && result.state === 'QUARANTINED') {
        await publishGovernanceContractRejection(options.dlq, result.reasonCode, {
          topic,
          partition,
          offset,
          event,
        });
      }
    },
  };
  return createConsumer(consumerOptions);
}

/**
 * CG4.8 (#191): a contract/version that cannot be interpreted must go to the DLQ (#179 §4) in addition to quarantine and
 * the hold scope committed in the same owner-local transaction. The DLQ publish is inside that transaction:
 * if the publish fails the transaction rolls back and the event is retried, so there is never a quarantine without a copy in the DLQ
 * a hash conflict is not sent to the DLQ because the contract is readable — it is an owner quarantine + alert
 */
export async function publishGovernanceContractRejection(
  dlq: DlqPublisher,
  reasonCode: string | undefined,
  source: { topic: string; partition?: number; offset?: string; event: unknown },
): Promise<boolean> {
  if (!isGovernanceContractRejection(reasonCode)) return false;
  const dlqReason =
    reasonCode === 'MALFORMED_PAYLOAD' || reasonCode === 'UNSUPPORTED_EVENT_TYPE'
      ? 'INVALID_ENVELOPE'
      : 'UNSUPPORTED_SCHEMA_VERSION';
  await dlq.publish({
    topic: source.topic,
    partition: source.partition ?? -1,
    offset: source.offset ?? '-1',
    error: new KafkaContractError(dlqReason, reasonCode),
    dlqReason,
    value: Buffer.from(JSON.stringify(source.event)),
  });
  return true;
}
