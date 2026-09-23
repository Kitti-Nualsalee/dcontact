/**
 * Owner: Delivery/Channels — durable inbox ของ LINE webhook และ Touch correlation (S2.1 #365)
 *
 * primitive ของ #359 §C/§D และ #361 §D/§F เท่านั้น: signature verification, parse และการตัดสิน
 * ว่า response ผูกกับ Attempt ใดเป็นของ S2.5 ที่นี่รับประกันว่า
 * - event ทั้ง request commit แบบ atomic (ล้ม = ไม่มีแถวใดเลย ผู้เรียกตอบ 503)
 * - event ID เดิม + hash เดิม = duplicate no-op; hash ต่าง = conflict ที่ quarantine ของเดิม
 *   และบันทึก audit โดยไม่เขียนทับ payload เดิม
 * - worker claim ด้วย `FOR UPDATE SKIP LOCKED` + lease จึงไม่หยิบ event เดียวกันพร้อมกัน
 * ไม่มี body, userId, replyToken หรือ signature ผ่าน repository นี้ — มีแค่ hash และ opaque ref
 */
import {
  Prisma,
  type DlLineTouchCorrelation,
  type DlLineWebhookInboxEntry,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import { randomUUID } from 'node:crypto';
import type { LineWebhookCode, TouchEvidenceKind } from '@d-contact/cxa-contracts';
import type { SealedLinePayload } from './line-protected-payload.js';
import {
  LineIdempotencyConflictError,
  isUniqueViolation,
  rejectingForeignBinding,
} from './line-repository-support.js';

export interface LineWebhookEventInput {
  id: string;
  webhookEventId: string;
  payloadHash: string;
  eventType: string;
  deliveryMode: 'active' | 'standby';
  isRedelivery: boolean;
  providerTimestamp: Date;
  protectedPayloadRef: string;
}

export interface AcceptLineWebhookBatchInput {
  tenantId: string;
  channelAccountId: string;
  receivedAt: Date;
  events: LineWebhookEventInput[];
  /**
   * S2.5: ciphertext ของแต่ละ event — เขียนใน transaction เดียวกับ inbox row จึงไม่มี ref กำพร้า
   * ref คำนวณจาก event ID + hash จึง duplicate ได้ ref เดิม (no-op) ส่วน conflict ได้ ref ใหม่
   * ทำให้ payload ที่ขัดกันถูกเก็บเป็นหลักฐานโดยไม่ทับของเดิม
   */
  payloads?: SealedLinePayload[];
  /** S2.5: request ที่ signature ผ่านแต่ต้องกักทั้งก้อน เช่น destination ไม่ตรง binding (#359 §A) */
  quarantineAccepted?: LineWebhookQuarantineCode;
}

export interface LineWebhookAcceptance {
  webhookEventId: string;
  inboxEntryId: string;
  code: Extract<
    LineWebhookCode,
    'WEBHOOK_ACCEPTED' | 'WEBHOOK_DUPLICATE' | 'WEBHOOK_IDEMPOTENCY_CONFLICT'
  >;
}

/** code ที่ทำให้ inbox entry จบแบบ quarantine ได้ — ตรงกับ CHECK ของ `dl_line_webhook_inbox` */
export type LineWebhookQuarantineCode = Extract<
  LineWebhookCode,
  | 'WEBHOOK_DESTINATION_MISMATCH'
  | 'WEBHOOK_SCHEMA_INVALID'
  | 'WEBHOOK_IDEMPOTENCY_CONFLICT'
  | 'WEBHOOK_UNSUPPORTED_EVENT_TYPE'
  | 'WEBHOOK_QUARANTINED'
>;

export interface OpenLineTouchCorrelationInput {
  id: string;
  tenantId: string;
  inboxEntryId: string;
  evidenceKind: TouchEvidenceKind;
  responseEvidenceRef: string;
  quotedMessageId?: string;
  providerTimestamp: Date;
  windowExpiresAt: Date;
  deliveryId?: string;
}

const INGRESS_ACTOR = 'line-webhook-ingress';

export class LineWebhookRepository {
  constructor(private readonly database: PrismaClient) {}

  // ── Inbox ─────────────────────────────────────────────────────────────────

  /** batch ว่าง (LINE verify request) ไม่แตะ database และไม่สร้าง business row */
  async acceptBatch(input: AcceptLineWebhookBatchInput): Promise<LineWebhookAcceptance[]> {
    if (input.events.length === 0) return [];
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      if (input.payloads && input.payloads.length > 0) {
        await transaction.dlLineProtectedPayload.createMany({
          data: input.payloads.map((payload) => ({
            id: randomUUID(),
            tenantId: input.tenantId,
            ...payload,
          })),
          skipDuplicates: true,
        });
      }
      const results: LineWebhookAcceptance[] = [];
      for (const event of input.events) {
        const inserted = await transaction.dlLineWebhookInboxEntry.createMany({
          data: [
            {
              ...event,
              tenantId: input.tenantId,
              channelAccountId: input.channelAccountId,
              receivedAt: input.receivedAt,
            },
          ],
          skipDuplicates: true,
        });
        if (inserted.count === 1) {
          if (input.quarantineAccepted) {
            await transaction.dlLineWebhookInboxEntry.updateMany({
              where: { tenantId: input.tenantId, id: event.id, state: 'PENDING' },
              data: {
                state: 'QUARANTINED',
                outcomeCode: input.quarantineAccepted,
                completedAt: input.receivedAt,
              },
            });
            await transaction.dlLineAuditEvent.createMany({
              data: [
                {
                  tenantId: input.tenantId,
                  eventId: `webhook-quarantine:${event.id}`,
                  category: 'WEBHOOK',
                  code: input.quarantineAccepted,
                  actorKind: 'SYSTEM',
                  actorRef: INGRESS_ACTOR,
                  subjectId: event.id,
                  evidenceDigest: event.payloadHash,
                  occurredAt: input.receivedAt,
                },
              ],
              skipDuplicates: true,
            });
          }
          results.push({
            webhookEventId: event.webhookEventId,
            inboxEntryId: event.id,
            code: 'WEBHOOK_ACCEPTED',
          });
          continue;
        }

        const existing = await transaction.dlLineWebhookInboxEntry.findFirstOrThrow({
          where: {
            tenantId: input.tenantId,
            channelAccountId: input.channelAccountId,
            webhookEventId: event.webhookEventId,
          },
        });
        if (existing.payloadHash === event.payloadHash) {
          results.push({
            webhookEventId: event.webhookEventId,
            inboxEntryId: existing.id,
            code: 'WEBHOOK_DUPLICATE',
          });
          continue;
        }

        await transaction.dlLineWebhookInboxEntry.updateMany({
          where: {
            tenantId: input.tenantId,
            id: existing.id,
            state: { in: ['PENDING', 'PROCESSING'] },
          },
          data: {
            state: 'QUARANTINED',
            outcomeCode: 'WEBHOOK_IDEMPOTENCY_CONFLICT',
            completedAt: input.receivedAt,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        await transaction.dlLineAuditEvent.createMany({
          data: [
            {
              tenantId: input.tenantId,
              eventId: `webhook-conflict:${existing.id}:${event.payloadHash}`,
              category: 'WEBHOOK',
              code: 'WEBHOOK_IDEMPOTENCY_CONFLICT',
              actorKind: 'SYSTEM',
              actorRef: INGRESS_ACTOR,
              subjectId: existing.id,
              evidenceDigest: event.payloadHash,
              occurredAt: input.receivedAt,
            },
          ],
          skipDuplicates: true,
        });
        results.push({
          webhookEventId: event.webhookEventId,
          inboxEntryId: existing.id,
          code: 'WEBHOOK_IDEMPOTENCY_CONFLICT',
        });
      }
      return results;
    });
  }

  /**
   * หยิบ event ที่ PENDING หรือ PROCESSING ที่ lease หมด (worker ตาย) ตามลำดับที่รับเข้ามา —
   * ไม่สมมติว่า provider ส่งมาตามลำดับ แค่ทำให้ restart แล้วงานไม่ค้าง
   */
  claim(
    tenantId: string,
    leaseOwner: string,
    now: Date,
    leaseMs: number,
    limit: number,
  ): Promise<DlLineWebhookInboxEntry[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const candidates = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM dl_line_webhook_inbox
        WHERE tenant_id = ${tenantId}::uuid
          AND (state = 'PENDING' OR (state = 'PROCESSING' AND lease_expires_at <= ${now}))
        ORDER BY received_at, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      if (candidates.length === 0) return [];
      const ids = candidates.map((candidate) => candidate.id);
      await transaction.dlLineWebhookInboxEntry.updateMany({
        where: { tenantId, id: { in: ids } },
        data: {
          state: 'PROCESSING',
          leaseOwner,
          leaseExpiresAt: new Date(now.getTime() + leaseMs),
          attempts: { increment: 1 },
        },
      });
      return transaction.dlLineWebhookInboxEntry.findMany({
        where: { tenantId, id: { in: ids } },
        orderBy: [{ receivedAt: 'asc' }, { id: 'asc' }],
      });
    });
  }

  /** จบได้เฉพาะ worker ที่ถือ lease อยู่ — lease ที่ถูกแย่งไปแล้วคืน false */
  complete(tenantId: string, id: string, leaseOwner: string, at: Date): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineWebhookInboxEntry.updateMany({
        where: { tenantId, id, state: 'PROCESSING', leaseOwner },
        data: {
          state: 'COMPLETED',
          outcomeCode: 'WEBHOOK_ACCEPTED',
          completedAt: at,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      return updated.count === 1;
    });
  }

  quarantine(
    tenantId: string,
    id: string,
    code: LineWebhookQuarantineCode,
    at: Date,
  ): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineWebhookInboxEntry.updateMany({
        where: { tenantId, id, state: { in: ['PENDING', 'PROCESSING'] } },
        data: {
          state: 'QUARANTINED',
          outcomeCode: code,
          completedAt: at,
          leaseOwner: null,
          leaseExpiresAt: null,
        },
      });
      return updated.count === 1;
    });
  }

  // ── Touch correlation ─────────────────────────────────────────────────────

  /** evidence ref เดิม + input เดิมคืนแถวเดิม (redelivery); input ต่างเป็น conflict */
  async openCorrelation(input: OpenLineTouchCorrelationInput): Promise<DlLineTouchCorrelation> {
    try {
      return await rejectingForeignBinding(() =>
        withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
          transaction.dlLineTouchCorrelation.create({
            data: {
              ...input,
              quotedMessageId: input.quotedMessageId ?? null,
              deliveryId: input.deliveryId ?? null,
            },
          }),
        ),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await withTenantDatabaseTransaction(
        this.database,
        input.tenantId,
        (transaction) =>
          transaction.dlLineTouchCorrelation.findFirst({
            where: { tenantId: input.tenantId, responseEvidenceRef: input.responseEvidenceRef },
          }),
      );
      if (
        existing &&
        existing.inboxEntryId === input.inboxEntryId &&
        existing.evidenceKind === input.evidenceKind &&
        existing.quotedMessageId === (input.quotedMessageId ?? null) &&
        existing.providerTimestamp.getTime() === input.providerTimestamp.getTime()
      ) {
        return existing;
      }
      throw new LineIdempotencyConflictError('dl_line_touch_correlations');
    }
  }

  /**
   * PENDING -> BOUND ครั้งเดียวกับ delivery/Attempt ที่ระบุ; Attempt หนึ่งมี Touch ได้ครั้งเดียว
   * (partial unique) — correlation ที่สองของ Attempt เดิมเป็น conflict ไม่ใช่ Touch ที่สอง
   */
  async bindCorrelation(
    tenantId: string,
    id: string,
    deliveryId: string,
    attemptId: string,
    at: Date,
  ): Promise<DlLineTouchCorrelation | null> {
    try {
      return await rejectingForeignBinding(() =>
        withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
          const updated = await transaction.dlLineTouchCorrelation.updateMany({
            where: {
              tenantId,
              id,
              state: 'PENDING',
              OR: [{ deliveryId: null }, { deliveryId }],
            },
            data: { state: 'BOUND', deliveryId, attemptId, resolvedAt: at },
          });
          if (updated.count === 0) return null;
          return transaction.dlLineTouchCorrelation.findFirst({ where: { tenantId, id } });
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error))
        throw new LineIdempotencyConflictError('dl_line_touch_correlations');
      throw error;
    }
  }

  quarantineCorrelation(tenantId: string, id: string, code: string, at: Date): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const updated = await transaction.dlLineTouchCorrelation.updateMany({
        where: { tenantId, id, state: 'PENDING' },
        data: { state: 'QUARANTINED', quarantineCode: code, resolvedAt: at },
      });
      return updated.count === 1;
    });
  }

  /** correlation ที่ยังรอ bind เรียงตาม window ที่ใกล้หมดก่อน — ให้ worker quarantine เมื่อเลย window */
  listPendingCorrelations(tenantId: string, limit: number): Promise<DlLineTouchCorrelation[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineTouchCorrelation.findMany({
        where: { tenantId, state: 'PENDING' },
        orderBy: { windowExpiresAt: 'asc' },
        take: limit,
      }),
    );
  }
}
