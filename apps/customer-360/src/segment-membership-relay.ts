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
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM c360_segment_membership_outbox
        WHERE tenant_id = ${tenantId}::uuid
          AND state IN ('PENDING', 'FAILED')
          AND available_at <= ${now}
        ORDER BY created_at, id
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
        const payload = validateSegmentMembershipChangePayload(row.payload);
        const payloadHash = canonicalSegmentMembershipHash(contractTenantId(tenantId), payload);
        if (payloadHash !== row.payloadHash) {
          throw new Error('membership outbox payload hash mismatch');
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
        const validated = assertSegmentMembershipChangeEnvelope(envelope);
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
      } catch {
        await transaction.c360SegmentMembershipOutbox.update({
          where: { id: row.id },
          data: {
            state: 'FAILED',
            attempts,
            availableAt: new Date(now.getTime() + this.backoffMs(attempts)),
          },
        });
        return { outboxId: row.id, eventId: row.eventId, state: 'FAILED', attempts };
      }
    });
  }
}
