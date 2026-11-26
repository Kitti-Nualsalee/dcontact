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
  /** exponential backoff per attempt before retrying; the default maximum is five minutes */
  backoffMs?: (attempts: number) => number;
}

function defaultBackoffMs(attempts: number): number {
  return Math.min(2 ** attempts * 1_000, 5 * 60_000);
}

/**
 * an error caused by the row itself being broken (payload fails validation, hash differs from the committed one,
 * envelope cannot be assembled) — retrying any number of times gives the same result because the data in that row does not change
 *
 * Distinct from a broker outage/network drop, where a retry can actually succeed. Collapsing both into FAILED
 * would leave a permanently broken row circulating in the queue forever with nobody noticing
 */
class MembershipOutboxCorruptionError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'MembershipOutboxCorruptionError';
  }
}

/**
 * Transactional-outbox relay for Customer 360. eventId and occurredAt come from the canonical
 * row that was already committed, so they stay the same on every broker retry; duplicate delivery is handled by eventId.
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

  /** publishes a single ready outbox row; undefined means there is no work in this tenant */
  async publishNext(tenantId: string): Promise<C360MembershipPublishAttempt | undefined> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      // SKIP LOCKED alone cannot guarantee ordering within a stream: a second worker skips the row that is
      // locked and picks the next revision of the same contact/segment, and may send N+1 before N
      // if the first worker is slow, so consumers see membership changes out of order
      //
      // Prevent this by not picking a row while an earlier revision of the same stream is still pending — that row
      // is picked only once the previous revision is PUBLISHED or QUARANTINED (i.e. finished)
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
            `the outbox payload does not satisfy the contract: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        const payloadHash = canonicalSegmentMembershipHash(contractTenantId(tenantId), payload);
        if (payloadHash !== row.payloadHash) {
          throw new MembershipOutboxCorruptionError(
            'payload hash does not match the one committed when the outbox row was created',
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
            `the envelope assembled from this row does not satisfy the contract: ${error instanceof Error ? error.message : String(error)}`,
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
