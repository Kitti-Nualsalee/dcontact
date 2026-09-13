/**
 * J2.7 — Kafka V2 consumer ของ `dc.interaction.events`; ingest เฉพาะ
 * `interaction.outcome_recorded` allowlist (#120) เข้า durable receipt (J2.3)
 *
 * เจตนาแยก ingest ออกจาก trigger matching (`journey-outcome-trigger-processor.ts`)
 * เหมือนที่ J2.3 ออกแบบไว้แต่แรก: consumer นี้ไม่ resolve identity/scope หรือสร้าง
 * enrollment ใด ๆ — แค่ persist receipt แบบ durable/idempotent แล้วให้ processor ที่
 * poll แยกต่างหากทำงานต่อ
 */
import type { PrismaClient } from '@d-contact/db';
import {
  createConsumer,
  type CreateConsumerOptions,
  type DcConsumer,
  type DlqPublisher,
  type EventIdempotencyStore,
} from '@d-contact/kafka';
import {
  J2_EVENT_TYPES,
  assertInteractionOutcomeEnvelope,
  canonicalInteractionOutcomeHash,
} from '@d-contact/cxa-contracts';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { JourneyOutcomeReceiptRepository } from './journey-outcome-receipt-repository.js';

/**
 * ไม่ต้องมี inbox table แยกเหมือน governance consumer เพราะ
 * `JourneyOutcomeReceiptRepository.ingest()` เป็น durable dedup boundary ของตัวเองอยู่แล้ว
 * ผ่าน unique (tenantId, source, eventId) — เรียกซ้ำได้ปลอดภัยเสมอไม่ว่า wrapper
 * จะรายงาน processed/duplicate อย่างไร
 */
export function createDurableJourneyOutcomeIdempotencyStore(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

export interface CreateJourneyOutcomeConsumerOptions {
  database: PrismaClient;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
  /** transport source ที่ persist ใน receipt เพื่อกันชนกับ receipt source อื่น */
  source?: string;
}

/** รับเฉพาะ canonical interaction outcome facts; event type อื่นบน topic เดียวกันข้ามเงียบ */
export function createJourneyOutcomeConsumer(
  options: CreateJourneyOutcomeConsumerOptions,
): Promise<DcConsumer> {
  const receipts = new JourneyOutcomeReceiptRepository(options.database);
  const source = options.source ?? 'INTERACTION';
  const consumerOptions: CreateConsumerOptions<Record<string, unknown>, undefined> = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.INTERACTION_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableJourneyOutcomeIdempotencyStore(),
    handler: async ({ event }) => {
      if (event.type !== J2_EVENT_TYPES.INTERACTION_OUTCOME_RECORDED) return;
      const envelope = assertInteractionOutcomeEnvelope(event);
      await receipts.ingest({
        tenantId: envelope.tenantId,
        source,
        eventId: envelope.eventId,
        outcomeType: envelope.payload.outcomeType,
        outcomeId: envelope.payload.outcomeId,
        outcomeVersion: envelope.payload.outcomeVersion,
        payloadHash: canonicalInteractionOutcomeHash(envelope.payload),
        payload: envelope.payload,
        correlationId: envelope.correlationId,
        ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
      });
    },
  };
  return createConsumer(consumerOptions);
}
