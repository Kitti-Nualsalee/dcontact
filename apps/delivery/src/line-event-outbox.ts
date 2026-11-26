/**
 * Owner: Delivery/Channels — durable outbox of PII-safe events (S2.5 #369, #362 §5)
 *
 * Channels does not write `cg_event_outbox`, which belongs to Contact Governance, so it has an outbox of its own
 *
 * - `eventId` is constant per transition: enqueueing again with the same payload is a no-op, not a second event;
 *   a different payload on the same eventId is a conflict because an event already announced cannot be edited
 * - enqueue accepts a transaction from the caller so the event is always committed with the business row
 *   (no way for the inbox to commit and the event to vanish, or the event to go out and the inbox to roll back)
 * - the payload is CHECKed again at the database for forbidden fields; it is re-checked here before sending so the error
 *   can point to the location without waiting for a constraint violation
 */
import { createHash } from 'node:crypto';
import {
  Prisma,
  withTenantDatabaseTransaction,
  type DlLineEventOutboxEntry,
  type PrismaClient,
} from '@d-contact/db';
import { LINE_EVENT_TYPES, type LineEventType, type LineEventV1 } from '@d-contact/cxa-contracts';
import { assertRedactedPayload } from './line-credential-boundary.js';
import { LineIdempotencyConflictError, isUniqueViolation } from './line-repository-support.js';

export interface EnqueueLineEventInput {
  id: string;
  tenantId: string;
  event: LineEventV1;
  /** Ordering key for the consumer — normally the delivery/channel account the event talks about */
  orderingKey: string;
  availableAt?: Date;
}

const EVENT_TYPES: ReadonlySet<string> = new Set(LINE_EVENT_TYPES);

export function lineEventPayloadHash(event: LineEventV1): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

export class LineEventOutboxRepository {
  constructor(private readonly database: PrismaClient) {}

  /** enqueue inside the caller's transaction (if given) — the event and the business row always commit together */
  async enqueue(
    input: EnqueueLineEventInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<DlLineEventOutboxEntry> {
    if (!EVENT_TYPES.has(input.event.type)) {
      throw new TypeError(`LINE event type is not in the contract: ${input.event.type}`);
    }
    assertRedactedPayload(input.event);
    const payload = input.event as unknown as Prisma.InputJsonValue;
    const data = {
      id: input.id,
      tenantId: input.tenantId,
      eventId: input.event.eventId,
      eventType: input.event.type,
      orderingKey: input.orderingKey,
      payload,
      payloadHash: lineEventPayloadHash(input.event),
      occurredAt: new Date(input.event.occurredAt),
      ...(input.availableAt ? { availableAt: input.availableAt } : {}),
    };

    const persist = async (client: Prisma.TransactionClient) => {
      const inserted = await client.dlLineEventOutboxEntry.createMany({
        data: [data],
        skipDuplicates: true,
      });
      if (inserted.count === 1) {
        return client.dlLineEventOutboxEntry.findFirstOrThrow({
          where: { tenantId: input.tenantId, eventId: data.eventId },
        });
      }
      const existing = await client.dlLineEventOutboxEntry.findFirstOrThrow({
        where: { tenantId: input.tenantId, eventId: data.eventId },
      });
      if (existing.payloadHash !== data.payloadHash) {
        throw new LineIdempotencyConflictError('dl_line_event_outbox');
      }
      return existing;
    };

    try {
      return transaction
        ? await persist(transaction)
        : await withTenantDatabaseTransaction(this.database, input.tenantId, persist);
    } catch (error) {
      if (isUniqueViolation(error)) throw new LineIdempotencyConflictError('dl_line_event_outbox');
      throw error;
    }
  }

  /** claim with lease + SKIP LOCKED like the inbox — multiple publishers do not pick the same event */
  claim(
    tenantId: string,
    leaseOwner: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<DlLineEventOutboxEntry[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM dl_line_event_outbox
        WHERE tenant_id = ${tenantId}::uuid
          AND available_at <= ${now}
          AND (state IN ('PENDING', 'FAILED') OR (state = 'PUBLISHING' AND lease_expires_at <= ${now}))
        ORDER BY occurred_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      if (candidates.length === 0) return [];
      const ids = candidates.map((candidate) => candidate.id);
      await transaction.dlLineEventOutboxEntry.updateMany({
        where: { tenantId, id: { in: ids } },
        data: {
          state: 'PUBLISHING',
          leaseOwner,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          attempts: { increment: 1 },
        },
      });
      return transaction.dlLineEventOutboxEntry.findMany({
        where: { tenantId, id: { in: ids } },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      });
    });
  }

  markPublished(tenantId: string, id: string, leaseOwner: string, at: Date): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineEventOutboxEntry.updateMany({
        where: { tenantId, id, state: 'PUBLISHING', leaseOwner },
        data: { state: 'PUBLISHED', publishedAt: at, leaseOwner: null, leaseExpiresAt: null },
      });
      return updated.count === 1;
    });
  }

  /** Release back into the queue with backoff — the event is not lost even if the broker is down */
  release(tenantId: string, id: string, leaseOwner: string, availableAt: Date): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineEventOutboxEntry.updateMany({
        where: { tenantId, id, state: 'PUBLISHING', leaseOwner },
        data: { state: 'FAILED', availableAt, leaseOwner: null, leaseExpiresAt: null },
      });
      return updated.count === 1;
    });
  }

  listByType(
    tenantId: string,
    eventType: LineEventType,
    limit = 50,
  ): Promise<DlLineEventOutboxEntry[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineEventOutboxEntry.findMany({
        where: { tenantId, eventType },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: limit,
      }),
    );
  }
}
