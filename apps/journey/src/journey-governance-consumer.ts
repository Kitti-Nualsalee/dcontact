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
 * `GAP` ไม่เป็น terminal idempotency โดยตั้งใจ: redrive ต้องกลับเข้า handler ได้เมื่อ
 * version ที่หายถูกกู้แล้ว ส่วน state อื่นมี Journey effect ที่ commit แล้วจึงเป็น duplicate เคร่งครัด
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

/** รับเฉพาะ canonical CG3 facts; validation และ fail-closed version handling อยู่ใน service */
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
        throw new TypeError('Journey CG3 consumer ไม่รับ Kafka V1 event');
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
 * CG4.8 (#191): contract/version ที่ตีความไม่ได้ต้องเข้า DLQ (#179 §4) นอกเหนือจาก quarantine และ
 * hold scope ที่ commit ใน owner-local transaction เดียวกัน DLQ publish อยู่ใน transaction นั้น:
 * ถ้า publish ล้มเหลว transaction rollback แล้ว event ถูก retry จึงไม่มี quarantine ที่ไม่มีสำเนาใน DLQ
 * hash conflict ไม่ส่ง DLQ เพราะ contract อ่านได้ — เป็น quarantine + alert ของ owner
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
