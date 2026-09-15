import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrEventInboxState,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { InboundBusinessEvent } from '@d-contact/shared';

export interface EventInboxReceipt {
  receiptId: string;
  source: string;
  eventId: string;
  state: JrEventInboxState;
  acceptedAt: string;
}

export interface EventInboxServiceOptions {
  now?: () => Date;
  id?: () => string;
}

export interface JourneyEventPublisher {
  publish(message: {
    tenantId: string;
    receiptId: string;
    event: InboundBusinessEvent;
  }): Promise<void>;
}

export interface EventPublishAttempt {
  receiptId: string;
  state: 'PUBLISHED' | 'FAILED';
  attempts: number;
}

export class EventIdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(
    readonly source: string,
    readonly eventId: string,
  ) {
    super(`eventId ถูกใช้กับ canonical payload อื่นแล้ว: ${source}/${eventId}`);
    this.name = 'EventIdempotencyConflictError';
  }
}

/**
 * canonical JSON ที่ใช้ทำ hash ให้เสถียรข้ามลำดับคีย์
 *
 * export ออกมาให้ J3 ใช้ซ้ำ (#217) แทนที่จะเขียนสำเนาที่สี่ — การมีกติกา canonicalization
 * หลายชุดที่ต้องคอยให้ตรงกันคือที่มาของ hash ที่ไม่ตรงกันโดยไม่มีใครรู้
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError('event payload มีตัวเลขที่ไม่เป็น finite');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(',')}}`;
  }
  throw new TypeError(`event payload มี value type ที่ไม่รองรับ: ${typeof value}`);
}

function hashEvent(event: InboundBusinessEvent): string {
  return createHash('sha256').update(canonicalJson(event)).digest('hex');
}

function toReceipt(event: {
  id: string;
  source: string;
  eventId: string;
  state: JrEventInboxState;
  createdAt: Date;
}): EventInboxReceipt {
  return {
    receiptId: event.id,
    source: event.source,
    eventId: event.eventId,
    state: event.state,
    acceptedAt: event.createdAt.toISOString(),
  };
}

const receiptSelection = {
  id: true,
  source: true,
  eventId: true,
  state: true,
  payloadHash: true,
  createdAt: true,
} as const;

export class EventInboxService {
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: EventInboxServiceOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async accept(tenantId: string, event: InboundBusinessEvent): Promise<EventInboxReceipt> {
    const payloadHash = hashEvent(event);
    const occurredAt = new Date(event.occurredAt);
    if (Number.isNaN(occurredAt.getTime()))
      throw new TypeError('event occurredAt ต้องเป็นรูปแบบ ISO-8601');

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`event:${tenantId}:${event.source}:${event.eventId}`}))`,
      );
      const existing = await transaction.jrEventInbox.findUnique({
        where: {
          tenantId_source_eventId: {
            tenantId,
            source: event.source,
            eventId: event.eventId,
          },
        },
        select: receiptSelection,
      });
      if (existing) {
        if (existing.payloadHash !== payloadHash) {
          throw new EventIdempotencyConflictError(event.source, event.eventId);
        }
        return toReceipt(existing);
      }

      const created = await transaction.jrEventInbox.create({
        data: {
          id: this.id(),
          tenantId,
          source: event.source,
          eventId: event.eventId,
          eventType: event.type,
          occurredAt,
          payload: event as unknown as Prisma.InputJsonValue,
          payloadHash,
          state: 'PENDING',
          createdAt: this.now(),
        },
        select: receiptSelection,
      });
      return toReceipt(created);
    });
  }

  async publishNext(
    tenantId: string,
    publisher: JourneyEventPublisher,
  ): Promise<EventPublishAttempt | undefined> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_event_inbox
        WHERE tenant_id = ${tenantId}::uuid
          AND state IN ('PENDING', 'FAILED')
        ORDER BY created_at, id
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `);
      const candidate = candidates[0];
      if (!candidate) return undefined;

      const inboxEvent = await transaction.jrEventInbox.findFirstOrThrow({
        where: { id: candidate.id, tenantId },
        select: { id: true, payload: true, publishAttempts: true },
      });
      const attempts = inboxEvent.publishAttempts + 1;
      const now = this.now();

      try {
        await publisher.publish({
          tenantId,
          receiptId: inboxEvent.id,
          event: inboxEvent.payload as unknown as InboundBusinessEvent,
        });
        await transaction.jrEventInbox.update({
          where: { id: inboxEvent.id },
          data: {
            state: 'PUBLISHED',
            publishAttempts: attempts,
            lastError: null,
            publishedAt: now,
          },
        });
        return { receiptId: inboxEvent.id, state: 'PUBLISHED', attempts };
      } catch (error) {
        await transaction.jrEventInbox.update({
          where: { id: inboxEvent.id },
          data: {
            state: 'FAILED',
            publishAttempts: attempts,
            lastError: error instanceof Error ? error.message : String(error),
          },
        });
        return { receiptId: inboxEvent.id, state: 'FAILED', attempts };
      }
    });
  }
}
