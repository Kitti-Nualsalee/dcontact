import {
  assertSegmentMembershipChangeEnvelope,
  canonicalSegmentMembershipHash,
  customerSegmentMembershipStreamId,
  J3_EVENT_TYPES,
  tenantId as contractTenantId,
  validateSegmentMembershipChangePayload,
  type J3KafkaEnvelopeV2,
  type SegmentMembershipChangePayloadV1,
} from '@d-contact/cxa-contracts';
import {
  Prisma,
  withTenantDatabaseTransaction,
  type C360SegmentMembershipOutboxState,
  type PrismaClient,
} from '@d-contact/db';
import type { DcProducer } from '@d-contact/kafka';
import { KAFKA_TOPICS } from '@d-contact/shared';

export interface C360MembershipPublishAttempt {
  outboxId: string;
  eventId: string;
  state: C360SegmentMembershipOutboxState;
  attempts: number;
}

export interface C360MembershipRelayOptions {
  now?: () => Date;
  /** exponential backoff ต่อ attempt ก่อน retry; default สูงสุดห้านาที */
  backoffMs?: (attempts: number) => number;
}

function defaultBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1_000, 5 * 60_000);
}

/**
 * error ที่เกิดจากตัว row เองเสีย (payload validate ไม่ผ่าน, hash ไม่ตรงกับที่ commit ไว้,
 * envelope ประกอบไม่ได้) — retry ไปกี่ครั้งก็ได้ผลเดิมเพราะข้อมูลในแถวนั้นไม่เปลี่ยน
 *
 * แยกจาก broker ล่ม/เน็ตหลุดซึ่ง retry แล้วมีโอกาสสำเร็จจริง การยุบสองอย่างนี้เป็น FAILED
 * เหมือนกันทำให้แถวที่เสียถาวรวนอยู่ในคิวตลอดไปโดยไม่มีใครรู้
 */
class MembershipOutboxCorruptionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MembershipOutboxCorruptionError';
  }
}

/**
 * Transactional-outbox relay ของ Customer 360. eventId และ occurredAt มาจาก canonical
 * row ที่ commit แล้ว จึงคงเดิมทุก broker retry; duplicate delivery ถูกจัดการด้วย eventId.
 */
export class C360SegmentMembershipRelay {
  private readonly now: () => Date;
  private readonly backoffMs: (attempts: number) => number;

  constructor(
    private readonly database: PrismaClient,
    private readonly producer: DcProducer,
    options: C360MembershipRelayOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.backoffMs = options.backoffMs ?? defaultBackoffMs;
  }

  /** เผยแพร่ outbox row เดียวที่พร้อม; undefined หมายถึงไม่มีงานใน tenant นี้ */
  async publishNext(tenantId: string): Promise<C360MembershipPublishAttempt | undefined> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      // SKIP LOCKED อย่างเดียวรับประกันลำดับใน stream ไม่ได้: worker คนที่สองจะข้ามแถวที่
      // ถูกล็อกไปหยิบ revision ถัดไปของ contact/segment เดียวกัน แล้วอาจส่ง N+1 ออกก่อน N
      // ถ้า worker แรกช้า ผู้บริโภคจึงเห็น membership change ผิดลำดับ
      //
      // กันด้วยการไม่หยิบแถวที่ยังมี revision ก่อนหน้าของ stream เดียวกันค้างอยู่ — แถวนั้น
      // จะถูกหยิบก็ต่อเมื่อรุ่นก่อนหน้า PUBLISHED หรือ QUARANTINED (คือจบเรื่องแล้ว) เท่านั้น
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT o.id
        FROM c360_segment_membership_outbox o
        WHERE o.tenant_id = ${tenantId}::uuid
          AND o.state IN ('PENDING', 'FAILED')
          AND o.available_at <= ${now}
          AND NOT EXISTS (
            SELECT 1
            FROM c360_segment_membership_outbox earlier
            WHERE earlier.tenant_id = o.tenant_id
              AND earlier.contact_id = o.contact_id
              AND earlier.segment_id = o.segment_id
              AND earlier.membership_revision < o.membership_revision
              AND earlier.state IN ('PENDING', 'FAILED')
          )
        ORDER BY o.created_at, o.id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;

      const row = await transaction.c360SegmentMembershipOutbox.findFirstOrThrow({
        where: { tenantId, id: candidate.id },
        include: { change: { select: { createdAt: true } } },
      });
      const attempts = row.attempts + 1;

      try {
        let payload: SegmentMembershipChangePayloadV1;
        try {
          payload = validateSegmentMembershipChangePayload(row.payload);
        } catch (error) {
          throw new MembershipOutboxCorruptionError(
            `payload ใน outbox ไม่ผ่าน contract: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const payloadHash = canonicalSegmentMembershipHash(contractTenantId(tenantId), payload);
        if (payloadHash !== row.payloadHash) {
          throw new MembershipOutboxCorruptionError(
            'payload hash ไม่ตรงกับที่ commit ไว้ตอนสร้าง outbox row',
          );
        }
        const streamId = customerSegmentMembershipStreamId(payload.contactId, payload.segmentId);
        const envelope: J3KafkaEnvelopeV2<SegmentMembershipChangePayloadV1> = {
          schemaVersion: 2,
          eventKind: 'CANONICAL',
          eventId: row.eventId,
          type: J3_EVENT_TYPES.CUSTOMER_SEGMENT_CHANGED,
          tenantId,
          occurredAt: row.change.createdAt.toISOString(),
          correlationId: row.correlationId,
          ...(row.causationId ? { causationId: row.causationId } : {}),
          orderingKey: streamId,
          aggregateType: 'customer_segment_membership',
          aggregateId: streamId,
          aggregateVersion: row.membershipRevision,
          payload,
        };
        let validated;
        try {
          validated = assertSegmentMembershipChangeEnvelope(envelope);
        } catch (error) {
          throw new MembershipOutboxCorruptionError(
            `envelope ประกอบจาก row นี้ไม่ผ่าน contract: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        await this.producer.send(KAFKA_TOPICS.CUSTOMER_EVENTS, validated);
        await transaction.c360SegmentMembershipOutbox.update({
          where: { id: row.id },
          data: { state: 'PUBLISHED', attempts, publishedAt: now },
        });
        return {
          outboxId: row.id,
          eventId: row.eventId,
          state: 'PUBLISHED',
          attempts,
        };
      } catch (error) {
        const corrupted = error instanceof MembershipOutboxCorruptionError;
        const reason = error instanceof Error ? error.message : String(error);
        await transaction.c360SegmentMembershipOutbox.update({
          where: { id: row.id },
          data: corrupted
            ? {
                state: 'QUARANTINED',
                attempts,
                quarantinedAt: now,
                lastError: reason.slice(0, 1_000),
              }
            : {
                state: 'FAILED',
                attempts,
                availableAt: new Date(now.getTime() + this.backoffMs(attempts)),
                lastError: reason.slice(0, 1_000),
              },
        });
        return {
          outboxId: row.id,
          eventId: row.eventId,
          state: corrupted ? 'QUARANTINED' : 'FAILED',
          attempts,
        };
      }
    });
  }
}
