/**
 * Owner: Delivery/Channels — durable inbox of the LINE webhook and Touch correlation (S2.1 #365)
 *
 * Only the primitives of #359 §C/§D and #361 §D/§F: signature verification, parsing and deciding
 * which Attempt a response binds to belong to S2.5. What is guaranteed here:
 * - the events of a whole request commit atomically (failing = no row at all, the caller answers 503)
 * - the same event ID + the same hash = a duplicate no-op; a different hash = a conflict that quarantines the original
 *   and records audit without overwriting the original payload
 * - the worker claims with `FOR UPDATE SKIP LOCKED` + lease so it does not pick the same event concurrently
 * No body, userId, replyToken or signature passes through this repository — only a hash and an opaque ref
 */
import {
  Prisma,
  type DlLineTouchCorrelation,
  type DlLineWebhookInboxEntry,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { LineWebhookCode, TouchEvidenceKind } from '@d-contact/cxa-contracts';
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
}

export interface LineWebhookAcceptance {
  webhookEventId: string;
  inboxEntryId: string;
  code: Extract<
    LineWebhookCode,
    'WEBHOOK_ACCEPTED' | 'WEBHOOK_DUPLICATE' | 'WEBHOOK_IDEMPOTENCY_CONFLICT'
  >;
}

/** codes that can end an inbox entry as quarantine — matches the CHECK of `dl_line_webhook_inbox` */
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

  /** an empty batch (the LINE verify request) does not touch the database and creates no business row */
  async acceptBatch(input: AcceptLineWebhookBatchInput): Promise<LineWebhookAcceptance[]> {
    if (input.events.length === 0) return [];
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
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
   * pick events that are PENDING or PROCESSING with an expired lease (the worker died) in the order received —
   * does not assume the provider sends in order, only makes sure work is not stuck after a restart
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

  /** can be finished only by the worker holding the lease — a lease that was taken over returns false */
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

  /** the same evidence ref + the same input returns the original row (redelivery); a different input is a conflict */
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
   * PENDING -> BOUND exactly once with the specified delivery/Attempt; one Attempt can have a Touch only once
   * (partial unique) — a second correlation of the same Attempt is a conflict, not a second Touch
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

  /** correlations still waiting to bind, ordered by the window closest to expiry first — so the worker quarantines once past the window */
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
