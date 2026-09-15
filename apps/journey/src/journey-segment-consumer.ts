/**
 * J3.6 (#217) — Kafka V2 consumer ของ `dc.customer.events`
 *
 * รับเฉพาะ `customer.segment.changed` ที่ผ่าน `assertSegmentMembershipChangeEnvelope` ซึ่งเป็น
 * ตัวบังคับ contractVersion, ordering key, aggregate binding และรูปร่าง payload ทั้งหมดอยู่แล้ว
 * — consumer นี้จึงไม่ตรวจซ้ำเอง เพราะกติกาสองชุดที่ต้องคอยให้ตรงกันคือที่มาของช่องโหว่
 *
 * เจตนาแยก ingest ออกจาก trigger matching เหมือนที่ J2.7 ทำ: ที่นี่ไม่ resolve identity/scope
 * และไม่สร้าง enrollment — แค่ persist receipt แบบ durable/idempotent แล้วให้ processor ที่
 * poll แยกต่างหากทำงานต่อ การรวมสองอย่างไว้ที่เดียวจะทำให้ Kafka offset กลายเป็น authority
 * ของลำดับงาน ซึ่ง stop condition ของ #217 ห้ามไว้
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
  J3_EVENT_TYPES,
  assertSegmentMembershipChangeEnvelope,
  canonicalSegmentMembershipHash,
  tenantId as contractTenantId,
} from '@d-contact/cxa-contracts';
import { KAFKA_TOPICS } from '@d-contact/shared';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';

/**
 * ไม่ต้องมี inbox table แยก เพราะ `JourneySegmentReceiptRepository.ingest()` เป็น durable
 * dedup boundary ของตัวเองผ่าน unique (tenantId, source, eventId) อยู่แล้ว เรียกซ้ำได้ปลอดภัย
 * เสมอไม่ว่า wrapper จะรายงาน processed/duplicate อย่างไร
 */
export function createDurableJourneySegmentIdempotencyStore(): EventIdempotencyStore {
  return {
    durability: 'DURABLE',
    async execute(_key, work) {
      await work(undefined);
      return 'processed';
    },
  };
}

export interface CreateJourneySegmentConsumerOptions {
  database: PrismaClient;
  clientId: string;
  groupId: string;
  brokers?: string[];
  dlq?: DlqPublisher;
  /** transport source ที่ persist ใน receipt เพื่อกันชนกับ receipt source อื่น */
  source?: string;
}

export function createJourneySegmentConsumer(
  options: CreateJourneySegmentConsumerOptions,
): Promise<DcConsumer> {
  const receipts = new JourneySegmentReceiptRepository(options.database);
  const source = options.source ?? 'CUSTOMER_360';
  const consumerOptions: CreateConsumerOptions<Record<string, unknown>, undefined> = {
    clientId: options.clientId,
    groupId: options.groupId,
    topics: [KAFKA_TOPICS.CUSTOMER_EVENTS],
    ...(options.brokers ? { brokers: options.brokers } : {}),
    ...(options.dlq ? { dlq: options.dlq } : {}),
    idempotency: createDurableJourneySegmentIdempotencyStore(),
    handler: async ({ event }) => {
      // event ชนิดอื่นบน topic เดียวกันข้ามเงียบ ไม่ใช่ error — Customer 360 เป็นเจ้าของ topic
      // และมีสิทธิ์ประกาศ event อื่นที่ Journey ไม่เกี่ยวข้อง
      if (event.type !== J3_EVENT_TYPES.CUSTOMER_SEGMENT_CHANGED) return;
      const envelope = assertSegmentMembershipChangeEnvelope(event);
      const payload = envelope.payload;
      /**
       * `supersedesRevision` มีเฉพาะบาง changeKind ตาม discriminated union ของ contract
       * (ENTERED ไม่มีเลย) อ่านผ่าน `in` แทนการ cast เพื่อให้ contract ยังเป็นตัวบังคับอยู่ —
       * ถ้าวันหนึ่ง union เปลี่ยน ที่นี่จะยังคอมไพล์ผ่านโดยได้ undefined ไม่ใช่ค่าที่ผิด
       */
      const supersedesRevision =
        'supersedesRevision' in payload ? payload.supersedesRevision : undefined;
      await receipts.ingest({
        tenantId: envelope.tenantId,
        source,
        eventId: envelope.eventId,
        contactId: payload.contactId,
        segmentId: payload.segmentId,
        membershipRevision: payload.membershipRevision,
        changeKind: payload.changeKind,
        segmentDefinitionVersion: payload.segmentDefinitionVersion,
        payloadHash: canonicalSegmentMembershipHash(contractTenantId(envelope.tenantId), payload),
        correlationId: envelope.correlationId,
        ...(payload.entryId ? { entryId: payload.entryId } : {}),
        ...(supersedesRevision !== undefined ? { supersedesRevision } : {}),
        ...(payload.evidenceRef ? { evidenceRef: payload.evidenceRef } : {}),
        ...(envelope.causationId ? { causationId: envelope.causationId } : {}),
      });
    },
  };
  return createConsumer(consumerOptions);
}
