import { randomUUID } from 'node:crypto';
import {
  Prisma,
  withTenantDatabaseTransaction,
  type CgAggregateType,
  type CgConsumerAckOutcome,
  type PrismaClient,
} from '@d-contact/db';
import {
  createConsumer,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';

/**
 * Contact Governance-side consumer for dc.contact-governance.acknowledgements
 * (#104: "Contact Governance consumes acknowledgements as a projection only: no
 * synchronous fan-out, shared writable inbox or distributed transaction")
 *
 * A downstream consumer (Journey/Dialer/Workspace: S1.5/S1.7/S1.8) publishes this payload
 * only after it has successfully applied its own CG3 event
 */
export interface AcknowledgementPayloadV1 {
  contractVersion: 1;
  consumer: string;
  aggregateType: 'CONTACT' | 'POLICY';
  aggregateId: string;
  appliedVersion: number;
  outcome: 'APPLIED' | 'NO_OP' | 'FAILED';
  affectedCount: number;
  /** payloadHash of the source cg event that the consumer applied: used to detect a hash conflict */
  sourcePayloadHash: string;
  /** CG4.8 (#191) additive: the Governance stateDigest that the consumer has applied */
  appliedStateDigest?: string;
}

function isAcknowledgementPayloadV1(value: unknown): value is AcknowledgementPayloadV1 {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    candidate.contractVersion === 1 &&
    typeof candidate.consumer === 'string' &&
    (candidate.aggregateType === 'CONTACT' || candidate.aggregateType === 'POLICY') &&
    typeof candidate.aggregateId === 'string' &&
    Number.isInteger(candidate.appliedVersion) &&
    (candidate.outcome === 'APPLIED' ||
      candidate.outcome === 'NO_OP' ||
      candidate.outcome === 'FAILED') &&
    Number.isInteger(candidate.affectedCount) &&
    typeof candidate.sourcePayloadHash === 'string' &&
    (candidate.appliedStateDigest === undefined ||
      (typeof candidate.appliedStateDigest === 'string' &&
        /^[a-f0-9]{64}$/.test(candidate.appliedStateDigest)))
  );
}

/**
 * cg_consumer_acknowledgements acts as both the completion record (idempotency) and the
 * projection in a single table: unique (tenantId, eventId, consumer, appliedVersion) prevents
 * a double-apply; the same eventId with a different hash is quarantined instead of overwritten
 */
export function createDurableAcknowledgementIdempotencyStore(
  database: PrismaClient,
): EventIdempotencyStore<Prisma.TransactionClient> {
  return {
    durability: 'DURABLE',
    async execute(key, work) {
      return withTenantDatabaseTransaction(database, key.tenantId, async (transaction) => {
        await transaction.$queryRaw(
          Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg3-ack:${key.consumerGroup}:${key.tenantId}:${key.eventId}`}))`,
        );
        const existing = await transaction.cgConsumerAcknowledgement.findFirst({
          where: { tenantId: key.tenantId, eventId: key.eventId },
          select: { id: true },
        });
        if (existing) return 'duplicate';

        await work(transaction);
        return 'processed';
      });
    },
  };
}

export interface CreateCg3AcknowledgementConsumerOptions {
  database: PrismaClient;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
}

async function applyAcknowledgement(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  eventId: string,
  payload: AcknowledgementPayloadV1,
): Promise<void> {
  const conflicting = await transaction.cgConsumerAcknowledgement.findFirst({
    where: {
      tenantId,
      consumer: payload.consumer,
      aggregateType: payload.aggregateType as CgAggregateType,
      aggregateId: payload.aggregateId,
      appliedVersion: payload.appliedVersion,
    },
    select: { payloadHash: true },
  });
  const outcome: CgConsumerAckOutcome =
    conflicting && conflicting.payloadHash !== payload.sourcePayloadHash
      ? 'QUARANTINED'
      : (payload.outcome as CgConsumerAckOutcome);

  await transaction.cgConsumerAcknowledgement.create({
    data: {
      id: randomUUID(),
      tenantId,
      eventId,
      consumer: payload.consumer,
      aggregateType: payload.aggregateType as CgAggregateType,
      aggregateId: payload.aggregateId,
      appliedVersion: payload.appliedVersion,
      outcome,
      affectedCount: payload.affectedCount,
      payloadHash: payload.sourcePayloadHash,
      ...(payload.appliedStateDigest ? { appliedStateDigest: payload.appliedStateDigest } : {}),
      appliedAt: new Date(),
    },
  });
}

export function createCg3AcknowledgementConsumer(
  options: CreateCg3AcknowledgementConsumerOptions,
): Promise<DcConsumer> {
  const consumerOptions: CreateConsumerOptions<
    Record<string, unknown>,
    Prisma.TransactionClient
  > = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.CONTACT_GOVERNANCE_ACKNOWLEDGEMENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableAcknowledgementIdempotencyStore(options.database),
    handler: async ({ event }, transaction) => {
      if (!isAcknowledgementPayloadV1(event.payload)) {
        // contract mismatch: drop silently without throwing (throwing would block the offset commit and retry in a loop)
        // because this side's producers do not really exist in S1.4 yet (S1.5/S1.7/S1.8 are the producers)
        return;
      }
      await applyAcknowledgement(transaction, event.tenantId, event.eventId, event.payload);
    },
  };
  return createConsumer(consumerOptions);
}
