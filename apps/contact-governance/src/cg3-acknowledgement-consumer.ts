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
 * Consumer ฝั่ง Contact Governance สำหรับ dc.contact-governance.acknowledgements
 * (#104: "Contact Governance consume acknowledgement เป็น projection เท่านั้น ไม่มี
 * synchronous fan-out, shared writable inbox หรือ distributed transaction")
 *
 * downstream consumer (Journey/Dialer/Workspace — S1.5/S1.7/S1.8) publish payload นี้
 * หลัง apply CG3 event ของตัวเองสำเร็จแล้วเท่านั้น
 */
export interface AcknowledgementPayloadV1 {
  contractVersion: 1;
  consumer: string;
  aggregateType: 'CONTACT' | 'POLICY';
  aggregateId: string;
  appliedVersion: number;
  outcome: 'APPLIED' | 'NO_OP' | 'FAILED';
  affectedCount: number;
  /** payloadHash ของ cg event ต้นทางที่ consumer นั้น apply — ใช้ตรวจ hash conflict */
  sourcePayloadHash: string;
  /** CG4.8 (#191) additive: stateDigest ของ Governance ที่ consumer apply แล้ว */
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
 * cg_consumer_acknowledgements ทำหน้าที่ทั้ง completion record (idempotency) และ
 * projection ในตัวเดียว — unique (tenantId, eventId, consumer, appliedVersion) ป้องกัน
 * double-apply; eventId เดียวกันแต่ hash ต่างกันถูก quarantine แทนที่จะ overwrite
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
        // contract ไม่ตรง — ทิ้งแบบ silent ไม่ throw (จะทำให้ offset commit ไม่ได้และ retry วนซ้ำ)
        // เนื่องจาก producer ฝั่งนี้ยังไม่มีจริงใน S1.4 (S1.5/S1.7/S1.8 เป็นผู้ผลิต)
        return;
      }
      await applyAcknowledgement(transaction, event.tenantId, event.eventId, event.payload);
    },
  };
  return createConsumer(consumerOptions);
}
