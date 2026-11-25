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
import type { DialerGovernanceInvalidationService } from './dialer-governance.js';

/** A GAP must be able to apply again after a replay; any other completion is a no-op duplicate. */
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
          throw new Error(
            'The Dialer CG3 handler must commit the owner-local inbox before succeeding',
          );
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
    handler: async ({ event, topic, partition, offset }, transaction) => {
      if (!isKafkaEventEnvelopeV2(event))
        throw new TypeError('The Dialer CG3 consumer does not accept Kafka V1 events');
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
 * CG4.8 (#191): a contract/version that cannot be interpreted must go to the DLQ (#179 §4) in addition to quarantine and the
 * hold scope committed in the same owner-local transaction. The DLQ publish is inside that transaction:
 * if the publish fails the transaction rolls back and the event is retried, so there is no quarantine without a DLQ copy.
 * A hash conflict is not sent to the DLQ because the contract is readable — it is an owner quarantine + alert.
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
