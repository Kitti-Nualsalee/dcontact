/**
 * Owner: Delivery/Channels — async worker ของ webhook inbox (S2.5 #369, #359 §D/§E, #361 §D/§F)
 *
 * ingress ตอบ 200 ทันทีที่ durable commit ส่วนงานที่ทำซ้ำไม่ได้อยู่ที่นี่ทั้งหมด:
 *
 * - projection dedupe ชั้นที่สอง `(tenantId, channelAccountId, providerMessageId)` ตาม ADR-024
 *   เกิดก่อน side effect ใด ๆ — message object เดิมที่มาคนละ webhookEventId ถูก project ครั้งเดียว
 * - Touch เกิดจาก explicit binding เท่านั้น: quoted response ที่ตรง `sentMessages.id` ของ accepted
 *   Attempt หรือ signed postback token ที่ consume ได้ครั้งเดียว — ไม่มี time-window inference
 * - response ที่มาก่อน acceptance commit เก็บเป็น correlation `PENDING` แล้ว retry จน window ปิด
 *   จึง quarantine เป็น `USER_RESPONSE_UNBOUND` (#361 §F) ไม่เดา candidate
 * - unknown event type ไม่ทำให้ endpoint ล้ม แต่ quarantine เป็น `WEBHOOK_UNSUPPORTED_EVENT_TYPE`
 *
 * worker ไม่เคยเห็น plaintext body: ทุกอย่างที่ใช้ตัดสินมาจาก projection/refs ที่ ingress เขียนไว้
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  withTenantDatabaseTransaction,
  type DlLineWebhookInboxEntry,
  type PrismaClient,
} from '@d-contact/db';
import {
  actionKey as toActionKey,
  deliveryId as toDeliveryId,
  outcomeRef as toOutcomeRef,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactTouchCorrelatedEventV1,
  type RecordCorrelatedTouchInput,
  type TouchEvidenceKind,
} from '@d-contact/cxa-contracts';
import { LineEventOutboxRepository } from './line-event-outbox.js';
import { LineWebhookRepository } from './line-webhook-repository.js';

/** เวลาที่ response ยังผูกกับ Attempt ได้ (#361 §D) — ตัดด้วย provider timestamp ไม่ใช่เวลาที่รับ */
export const LINE_TOUCH_WINDOW_MS = 24 * 60 * 60 * 1000;

/** event type ที่ S2 รู้จัก — นอกเหนือจากนี้ ack ได้แต่ quarantine เป็น unsupported */
export const LINE_SUPPORTED_EVENT_TYPES = Object.freeze([
  'message',
  'postback',
  'follow',
  'unfollow',
]);

/**
 * เนื้อหาที่ worker ต้องใช้จาก event หนึ่งแถว — ingress เก็บ ciphertext ไว้ ผู้เรียกจึงต้องส่ง
 * decrypted projection เข้ามา (production ใช้ vault reader, test ใช้ fixture เดียวกัน)
 */
export interface LineInboundProjection {
  providerMessageId?: string;
  quotedMessageId?: string;
  /** SHA-256 ของ userId + channel account — ใช้เทียบ recipient binding โดยไม่ถือ userId */
  sourceFingerprint: string;
  /** หนึ่งต่อหนึ่งเท่านั้น; group/room ไม่มีสิทธิ์สร้าง Touch (#361 §D) */
  isOneToOne: boolean;
  postbackToken?: string;
}

export interface LineWebhookPayloadReader {
  read(tenantId: string, entry: DlLineWebhookInboxEntry): Promise<LineInboundProjection | null>;
}

export interface LineAcceptedAttempt {
  deliveryId: string;
  attemptId: string;
  reservationId: string;
  actionKey: string;
  /** fingerprint ของผู้รับที่ accepted delivery นี้ส่งไป — ต้องตรงกับผู้ส่ง response */
  recipientFingerprint: string;
  acceptedAt: Date;
}

/**
 * Governance เป็น single writer ของ Attempt/Touch — Channels เห็นแค่ binding ที่จำเป็นและส่ง
 * evidence ref กลับไป ไม่มี raw user ID/body ผ่าน port นี้
 */
export interface LineTouchGovernancePort {
  findAcceptedAttemptByMessage(input: {
    tenantId: string;
    channelAccountId: string;
    providerMessageId: string;
  }): Promise<LineAcceptedAttempt | null>;
  recordCorrelatedTouch(input: RecordCorrelatedTouchInput): Promise<void>;
}

/** postback token ที่ fixture ฝังไว้ — verify/consume แบบ atomic ครั้งเดียว (#361 §D) */
export interface LinePostbackTokenPort {
  consume(input: {
    tenantId: string;
    token: string;
    at: Date;
  }): Promise<{ providerMessageId: string } | null>;
}

export interface LineWebhookWorkerOptions {
  database: PrismaClient;
  payloads: LineWebhookPayloadReader;
  governance: LineTouchGovernancePort;
  postbacks?: LinePostbackTokenPort;
  leaseOwner: string;
  leaseMs?: number;
  batchSize?: number;
  now?: () => Date;
  id?: () => string;
}

export interface LineWebhookWorkerResult {
  processed: number;
  projected: number;
  touches: number;
  pending: number;
  quarantined: number;
}

export function lineSourceFingerprint(channelAccountId: string, userId: string): string {
  return createHash('sha256').update(`${channelAccountId}|${userId}`).digest('hex');
}

export function lineResponseEvidenceRef(channelAccountId: string, webhookEventId: string): string {
  const digest = createHash('sha256')
    .update(`resp|${channelAccountId}|${webhookEventId}`)
    .digest('hex');
  return `resp_${digest.slice(0, 48)}`;
}

export class LineWebhookWorker {
  private readonly inbox: LineWebhookRepository;
  private readonly events: LineEventOutboxRepository;
  private readonly now: () => Date;
  private readonly id: () => string;

  constructor(private readonly options: LineWebhookWorkerOptions) {
    this.inbox = new LineWebhookRepository(options.database);
    this.events = new LineEventOutboxRepository(options.database);
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
  }

  async runOnce(tenantId: string): Promise<LineWebhookWorkerResult> {
    const result: LineWebhookWorkerResult = {
      processed: 0,
      projected: 0,
      touches: 0,
      pending: 0,
      quarantined: 0,
    };
    const claimed = await this.inbox.claim(
      tenantId,
      this.options.leaseOwner,
      this.now(),
      this.options.leaseMs ?? 30_000,
      this.options.batchSize ?? 20,
    );
    for (const entry of claimed) {
      result.processed += 1;
      await this.process(tenantId, entry, result);
    }
    return result;
  }

  private async process(
    tenantId: string,
    entry: DlLineWebhookInboxEntry,
    result: LineWebhookWorkerResult,
  ) {
    if (!LINE_SUPPORTED_EVENT_TYPES.includes(entry.eventType)) {
      await this.inbox.quarantine(tenantId, entry.id, 'WEBHOOK_UNSUPPORTED_EVENT_TYPE', this.now());
      result.quarantined += 1;
      return;
    }

    const projection = await this.options.payloads.read(tenantId, entry);
    if (!projection) {
      await this.inbox.quarantine(tenantId, entry.id, 'WEBHOOK_SCHEMA_INVALID', this.now());
      result.quarantined += 1;
      return;
    }

    if (entry.eventType === 'message' && projection.providerMessageId) {
      const projected = await this.project(tenantId, entry, projection);
      if (projected) result.projected += 1;
    }

    const evidence = this.evidenceOf(entry, projection);
    if (!evidence) {
      // follow/unfollow, plain message, group/room: เก็บ inbound signal ไว้แต่ไม่มี Touch
      await this.inbox.complete(tenantId, entry.id, this.options.leaseOwner, this.now());
      return;
    }

    const bound = await this.correlate(tenantId, entry, projection, evidence, result);
    if (bound) result.touches += 1;
    else result.pending += 1;
    await this.inbox.complete(tenantId, entry.id, this.options.leaseOwner, this.now());
  }

  /** projection dedupe ชั้นที่ 2 — unique violation แปลว่ามีคน project message นี้ไปแล้ว */
  private async project(
    tenantId: string,
    entry: DlLineWebhookInboxEntry,
    projection: LineInboundProjection,
  ): Promise<boolean> {
    const inserted = await withTenantDatabaseTransaction(
      this.options.database,
      tenantId,
      (transaction) =>
        transaction.dlLineInboundMessage.createMany({
          data: [
            {
              id: this.id(),
              tenantId,
              channelAccountId: entry.channelAccountId,
              providerMessageId: projection.providerMessageId!,
              inboxEntryId: entry.id,
              quotedMessageId: projection.quotedMessageId ?? null,
              sourceFingerprint: projection.sourceFingerprint,
              providerTimestamp: entry.providerTimestamp,
              projectedAt: this.now(),
            },
          ],
          skipDuplicates: true,
        }),
    );
    return inserted.count === 1;
  }

  private evidenceOf(
    entry: DlLineWebhookInboxEntry,
    projection: LineInboundProjection,
  ): { kind: TouchEvidenceKind; quotedMessageId?: string; token?: string } | null {
    if (!projection.isOneToOne) return null;
    if (entry.eventType === 'message' && projection.quotedMessageId) {
      return { kind: 'USER_QUOTED_RESPONSE', quotedMessageId: projection.quotedMessageId };
    }
    if (entry.eventType === 'postback' && projection.postbackToken && this.options.postbacks) {
      return { kind: 'SIGNED_POSTBACK', token: projection.postbackToken };
    }
    return null;
  }

  /**
   * เปิด correlation ก่อนเสมอ (durable) แล้วค่อยพยายาม bind — ถ้า acceptance ยังไม่ commit
   * correlation ค้างเป็น PENDING ให้ `resolvePending` ตามต่อภายใน window
   */
  private async correlate(
    tenantId: string,
    entry: DlLineWebhookInboxEntry,
    projection: LineInboundProjection,
    evidence: { kind: TouchEvidenceKind; quotedMessageId?: string; token?: string },
    result: LineWebhookWorkerResult,
  ): Promise<boolean> {
    const responseEvidenceRef = lineResponseEvidenceRef(
      entry.channelAccountId,
      entry.webhookEventId,
    );
    let quotedMessageId = evidence.quotedMessageId;
    if (evidence.kind === 'SIGNED_POSTBACK' && evidence.token) {
      const consumed = await this.options.postbacks!.consume({
        tenantId,
        token: evidence.token,
        at: this.now(),
      });
      if (!consumed) {
        result.quarantined += 1;
        return false;
      }
      quotedMessageId = undefined;
      const attempt = await this.options.governance.findAcceptedAttemptByMessage({
        tenantId,
        channelAccountId: entry.channelAccountId,
        providerMessageId: consumed.providerMessageId,
      });
      return this.bind(tenantId, entry, projection, {
        kind: evidence.kind,
        responseEvidenceRef,
        attempt,
      });
    }

    const attempt = quotedMessageId
      ? await this.options.governance.findAcceptedAttemptByMessage({
          tenantId,
          channelAccountId: entry.channelAccountId,
          providerMessageId: quotedMessageId,
        })
      : null;
    return this.bind(tenantId, entry, projection, {
      kind: evidence.kind,
      responseEvidenceRef,
      quotedMessageId,
      attempt,
    });
  }

  private async bind(
    tenantId: string,
    entry: DlLineWebhookInboxEntry,
    projection: LineInboundProjection,
    input: {
      kind: TouchEvidenceKind;
      responseEvidenceRef: string;
      quotedMessageId?: string;
      attempt: LineAcceptedAttempt | null;
    },
  ): Promise<boolean> {
    const windowExpiresAt = new Date(entry.providerTimestamp.getTime() + LINE_TOUCH_WINDOW_MS);
    const correlation = await this.inbox.openCorrelation({
      id: this.id(),
      tenantId,
      inboxEntryId: entry.id,
      evidenceKind: input.kind,
      responseEvidenceRef: input.responseEvidenceRef,
      ...(input.quotedMessageId ? { quotedMessageId: input.quotedMessageId } : {}),
      providerTimestamp: entry.providerTimestamp,
      windowExpiresAt,
      ...(input.attempt ? { deliveryId: input.attempt.deliveryId } : {}),
    });
    if (correlation.state !== 'PENDING') return correlation.state === 'BOUND';
    if (!input.attempt) return false;
    return this.commitTouch(tenantId, correlation.id, input, projection, entry);
  }

  /** ผูก correlation → Attempt แล้วให้ Governance append Touch; Channels ไม่เขียน cg_* เอง */
  private async commitTouch(
    tenantId: string,
    correlationId: string,
    input: {
      kind: TouchEvidenceKind;
      responseEvidenceRef: string;
      attempt: LineAcceptedAttempt | null;
    },
    projection: LineInboundProjection,
    entry: DlLineWebhookInboxEntry,
  ): Promise<boolean> {
    const attempt = input.attempt!;
    // ผู้ตอบต้องเป็นผู้รับคนเดียวกับที่ accepted delivery ส่งไป (#361 §D)
    if (attempt.recipientFingerprint !== projection.sourceFingerprint) {
      await this.inbox.quarantineCorrelation(
        tenantId,
        correlationId,
        'USER_RESPONSE_UNBOUND',
        this.now(),
      );
      return false;
    }
    if (entry.providerTimestamp.getTime() < attempt.acceptedAt.getTime()) {
      await this.inbox.quarantineCorrelation(
        tenantId,
        correlationId,
        'USER_RESPONSE_UNBOUND',
        this.now(),
      );
      return false;
    }

    const bound = await this.inbox.bindCorrelation(
      tenantId,
      correlationId,
      attempt.deliveryId,
      attempt.attemptId,
      this.now(),
    );
    if (!bound) return false;

    await this.options.governance.recordCorrelatedTouch({
      tenantId: toTenantId(tenantId),
      correlationId,
      reservationId: toReservationId(attempt.reservationId),
      actionKey: toActionKey(attempt.actionKey),
      deliveryId: toDeliveryId(attempt.deliveryId),
      attemptId: attempt.attemptId,
      responseEvidenceRef: toOutcomeRef(input.responseEvidenceRef),
      evidenceKind: input.kind,
      occurredAt: entry.providerTimestamp.toISOString(),
    });

    const event: ContactTouchCorrelatedEventV1 = {
      type: 'contact.touch.correlated.v1',
      eventId: `line-touch:${attempt.attemptId}`,
      tenantId: toTenantId(tenantId),
      occurredAt: entry.providerTimestamp.toISOString(),
      correlationId,
      attemptId: attempt.attemptId,
      deliveryId: toDeliveryId(attempt.deliveryId),
      responseEvidenceRef: toOutcomeRef(input.responseEvidenceRef),
      evidenceKind: input.kind,
    };
    await this.events.enqueue({
      id: this.id(),
      tenantId,
      event,
      orderingKey: attempt.deliveryId,
    });
    return true;
  }

  /**
   * correlation ที่ยัง PENDING: ลอง bind ใหม่ (acceptance อาจ commit ไปแล้ว) และ quarantine เมื่อ
   * window ปิด — redelivery ที่มาช้ายัง bind ได้ถ้า provider timestamp เดิมยังอยู่ใน window
   */
  async resolvePending(tenantId: string, limit = 50): Promise<LineWebhookWorkerResult> {
    const result: LineWebhookWorkerResult = {
      processed: 0,
      projected: 0,
      touches: 0,
      pending: 0,
      quarantined: 0,
    };
    const pending = await this.inbox.listPendingCorrelations(tenantId, limit);
    for (const correlation of pending) {
      result.processed += 1;
      const now = this.now();
      const entry = await withTenantDatabaseTransaction(
        this.options.database,
        tenantId,
        (transaction) =>
          transaction.dlLineWebhookInboxEntry.findFirstOrThrow({
            where: { tenantId, id: correlation.inboxEntryId },
          }),
      );
      const projection = await this.options.payloads.read(tenantId, entry);
      const providerMessageId = correlation.quotedMessageId ?? undefined;
      const attempt =
        projection && providerMessageId
          ? await this.options.governance.findAcceptedAttemptByMessage({
              tenantId,
              channelAccountId: entry.channelAccountId,
              providerMessageId,
            })
          : null;
      if (attempt && projection) {
        const bound = await this.commitTouch(
          tenantId,
          correlation.id,
          {
            kind: correlation.evidenceKind,
            responseEvidenceRef: correlation.responseEvidenceRef,
            attempt,
          },
          projection,
          entry,
        );
        if (bound) {
          result.touches += 1;
          continue;
        }
      }
      if (correlation.windowExpiresAt.getTime() <= now.getTime()) {
        await this.inbox.quarantineCorrelation(
          tenantId,
          correlation.id,
          'USER_RESPONSE_UNBOUND',
          now,
        );
        result.quarantined += 1;
        continue;
      }
      result.pending += 1;
    }
    return result;
  }
}
