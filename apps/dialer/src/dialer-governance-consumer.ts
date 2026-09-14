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
    handler: async ({ event, topic, partition, offset }, transaction) => {
      if (!isKafkaEventEnvelopeV2(event))
        throw new TypeError('Dialer CG3 consumer ไม่รับ Kafka V1 event');
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
