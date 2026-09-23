/**
 * Owner: Delivery/Channels — durable outbox ของ PII-safe events (S2.5 #369, #362 §5)
 *
 * Channels ไม่เขียน `cg_event_outbox` ซึ่งเป็นของ Contact Governance จึงมี outbox ของตัวเอง
 *
 * - `eventId` คงที่ต่อ transition เดิม: enqueue ซ้ำด้วย payload เดิมเป็น no-op ไม่ใช่ event ที่สอง
 *   payload ต่างบน eventId เดิมเป็น conflict เพราะ event ที่ประกาศออกไปแล้วแก้ไม่ได้
 * - enqueue รับ transaction จากผู้เรียกได้ เพื่อให้ event ถูก commit พร้อมแถวธุรกิจเสมอ
 *   (ไม่มีทางที่ inbox commit แล้ว event หาย หรือ event ออกไปแล้ว inbox rollback)
 * - payload ถูก CHECK ที่ database อีกชั้นว่าไม่มี field ต้องห้าม ที่นี่ตรวจซ้ำก่อนส่งเพื่อให้ error
 *   บอกตำแหน่งได้โดยไม่ต้องรอ constraint violation
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
  /** คีย์จัดลำดับของ consumer — ปกติคือ delivery/channel account ที่ event นั้นพูดถึง */
  orderingKey: string;
  availableAt?: Date;
}

const EVENT_TYPES: ReadonlySet<string> = new Set(LINE_EVENT_TYPES);

export function lineEventPayloadHash(event: LineEventV1): string {
  return createHash('sha256').update(JSON.stringify(event)).digest('hex');
}

export class LineEventOutboxRepository {
  constructor(private readonly database: PrismaClient) {}

  /** enqueue ภายใน transaction ของผู้เรียก (ถ้าให้มา) — event กับแถวธุรกิจ commit พร้อมกันเสมอ */
  async enqueue(
    input: EnqueueLineEventInput,
    transaction?: Prisma.TransactionClient,
  ): Promise<DlLineEventOutboxEntry> {
    if (!EVENT_TYPES.has(input.event.type)) {
      throw new TypeError(`LINE event type ไม่อยู่ในสัญญา: ${input.event.type}`);
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

  /** claim ด้วย lease + SKIP LOCKED เหมือน inbox — publisher หลายตัวไม่หยิบ event เดียวกัน */
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

  /** ปล่อยกลับเข้า queue พร้อม backoff — event ไม่หายแม้ broker ล่ม */
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
