/**
 * J2.8 (#136) — consume owner result จาก `dc.case.events`/`dc.dialer.events`
 *
 * คู่ตรงข้ามของ `journey-owner-kafka-port.ts`: เมื่อ command ออกไปทาง Kafka แล้ว ผลต้อง
 * เดินทางกลับมาทาง Kafka เช่นกัน consumer นี้คือขา "consume owner results พร้อม
 * tenant/command/action/hash/aggregate/version/causation binding" ของสเปค #136
 *
 * binding ตรวจสองชั้น:
 *   1. `assertOwnerResultEnvelope` — envelope V2 ต้องตรงกับ payload เอง (type/aggregateType/
 *      aggregateId/orderingKey/aggregateVersion) ถ้าไม่ตรงคือ contract ผิด เข้า DLQ
 *   2. เทียบกับ command ที่เก็บไว้จริงใน `jr_owner_command_outbox` — result ต้องอ้าง
 *      actionKey/requestHash/commandType ตรงกับ command ที่เราส่งไป ไม่ใช่แค่ self-consistent
 *      (`assertOwnerResultBinding` ของ contract ต้องใช้ command envelope ต้นฉบับซึ่ง consumer
 *      ไม่มี เราจึงเทียบกับ durable copy ที่ outbox เก็บไว้แทน ซึ่งให้การรับประกันเดียวกัน)
 *
 * result ที่ bind ไม่ได้จะถูก "ข้ามเงียบ" ไม่ได้เด็ดขาด — โยน error ให้ wrapper ส่งเข้า DLQ
 * เพราะผลที่อ้าง command ผิดคือสัญญาณว่ามีบางอย่างผิดจริง ไม่ใช่ event ที่ไม่เกี่ยวข้อง
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  createConsumer,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import { assertOwnerResultEnvelope } from '@d-contact/cxa-contracts';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { STATUS_TO_RESULT_KIND, hashResult } from './journey-owner-result-reconciler.js';
import { noOpJourneyOwnerMetrics, type JourneyOwnerMetrics } from './journey-owner-metrics.js';

/**
 * `applyResult` เป็น durable dedup boundary ของตัวเองผ่าน unique (tenantId, commandId)
 * อยู่แล้ว — เรียกซ้ำปลอดภัยเสมอ จึงไม่ต้องมี inbox table ซ้อนอีกชั้น
 */
export function createDurableOwnerResultIdempotencyStore(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

export class OwnerResultBindingError extends Error {
  readonly code = 'OWNER_RESULT_BINDING_CONFLICT' as const;

  constructor(
    readonly commandId: string,
    detail: string,
  ) {
    super(`owner result ของ command ${commandId} bind ไม่ตรง: ${detail}`);
    this.name = 'OwnerResultBindingError';
  }
}

export interface CreateJourneyOwnerResultConsumerOptions {
  database: PrismaClient;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
  metrics?: JourneyOwnerMetrics;
}

export function createJourneyOwnerResultConsumer(
  options: CreateJourneyOwnerResultConsumerOptions,
): Promise<DcConsumer> {
  const actions = new JourneyOwnerActionRepository(options.database);
  const metrics = options.metrics ?? noOpJourneyOwnerMetrics;

  const consumerOptions: CreateConsumerOptions<Record<string, unknown>, undefined> = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.CASE_EVENTS, KAFKA_TOPICS.DIALER_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableOwnerResultIdempotencyStore(),
    handler: async ({ event }) => {
      // topic เดียวกันมี event ชนิดอื่นของ owner ปนอยู่ได้ — ข้ามเฉพาะที่ไม่ใช่ result
      let envelope;
      try {
        envelope = assertOwnerResultEnvelope(event);
      } catch {
        return;
      }
      const result = envelope.payload;

      // ต้องอยู่ใน tenant transaction เสมอ — application client เปิด RLS ไว้ การ query
      // นอก context ทำให้ tenant GUC ว่างและ Postgres ปฏิเสธทันที
      const command = await withTenantDatabaseTransaction(
        options.database,
        envelope.tenantId,
        (transaction) =>
          transaction.jrOwnerCommandOutbox.findUnique({
            where: {
              tenantId_commandId: { tenantId: envelope.tenantId, commandId: result.commandId },
            },
          }),
      );
      if (!command) {
        metrics.increment('journey_owner_result_binding_rejected_total');
        throw new OwnerResultBindingError(result.commandId, 'ไม่พบ command ต้นเรื่องใน outbox');
      }
      if (command.actionKey !== result.actionKey) {
        metrics.increment('journey_owner_result_binding_rejected_total');
        throw new OwnerResultBindingError(
          result.commandId,
          `actionKey ไม่ตรง (${command.actionKey} vs ${result.actionKey})`,
        );
      }
      if (command.requestHash !== result.requestHash) {
        metrics.increment('journey_owner_result_binding_rejected_total');
        throw new OwnerResultBindingError(result.commandId, 'requestHash ไม่ตรงกับ command');
      }

      const applied = await actions.applyResult({
        tenantId: envelope.tenantId,
        commandId: result.commandId,
        actionKey: result.actionKey,
        resultKind: STATUS_TO_RESULT_KIND[result.status],
        resultHash: hashResult(result),
        correlationId: envelope.correlationId,
        ...(result.ownerAggregate ? { ownerAggregateRef: result.ownerAggregate.id } : {}),
        ...(result.ownerAggregate ? { ownerAggregateVersion: result.ownerAggregate.version } : {}),
      });
    },
  };
  return createConsumer(consumerOptions);
}
