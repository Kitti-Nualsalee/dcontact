/**
 * Owner: Delivery/Channels — LINE webhook ingress (S2.5 #369, #359 §A–§E)
 *
 * ลำดับที่เปลี่ยนไม่ได้:
 *   1. เลือก binding + channel secret จาก trusted deployment config **ก่อน** แตะ body
 *   2. verify HMAC-SHA256 บน raw bytes แบบ constant-time — ไม่ผ่าน = `401` และไม่ parse/persist อะไรเลย
 *   3. หลัง verify จึง decode/parse/validate และเทียบ `destination` กับ binding
 *   4. commit inbox rows + encrypted payload + inbound events ของทั้ง request แบบ atomic
 *   5. ตอบ `200` หลัง durable commit เท่านั้น; commit ไม่สำเร็จตอบ `503` ให้ LINE redeliver
 *
 * `{events: []}` (verify request ของ LINE Console) ตอบ `200` โดยไม่สร้าง business row
 * destination ไม่ตรง: persist quarantine + audit แล้วตอบ `200` เพื่อไม่สร้าง redelivery storm (#359 §A)
 */
import { createHash, createCipheriv, randomBytes, randomUUID } from 'node:crypto';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  tenantId as toTenantId,
  type LineInboundEventV1,
  type LineWebhookCode,
} from '@d-contact/cxa-contracts';
import { LineEventOutboxRepository } from './line-event-outbox.js';
import { LineIdempotencyConflictError } from './line-repository-support.js';
import type { LineWebhookEventInput } from './line-webhook-repository.js';
import { LINE_WEBHOOK_MAX_BODY_BYTES, verifyLineSignature } from './line-webhook-signature.js';

/** binding ของ S2 singleton profile — มาจาก deployment config ไม่ใช่จาก body */
export interface LineWebhookBinding {
  tenantId: string;
  channelAccountId: string;
  /** bot destination ที่คาดไว้ (LINE ส่งมาใน `destination`) */
  destination: string;
  channelSecret: string;
  /** ชื่อ keychain reference ของ key ที่ใช้เข้ารหัส operational payload */
  payloadKeyRef: string;
  payloadKey: Buffer;
}

export interface LineWebhookRequest {
  rawBody: Buffer;
  signature: string | undefined;
  receivedAt: Date;
}

export interface LineWebhookIngressResult {
  status: 200 | 400 | 401 | 413 | 503;
  code: LineWebhookCode;
  accepted: number;
  duplicates: number;
  conflicts: number;
}

interface ParsedLineEvent {
  webhookEventId: string;
  eventType: string;
  deliveryMode: 'active' | 'standby';
  isRedelivery: boolean;
  providerTimestamp: Date;
  raw: Record<string, unknown>;
}

const WEBHOOK_EVENT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const INGRESS_ACTOR = 'line-webhook-ingress';

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** forward-compatible: field ใหม่ที่ไม่รู้จักผ่านได้ ชนิดที่ผิดรูปเท่านั้นที่เป็น schema invalid */
function parseEvent(value: unknown): ParsedLineEvent | null {
  const event = asObject(value);
  if (!event) return null;
  const { webhookEventId, type, mode, timestamp } = event;
  if (typeof webhookEventId !== 'string' || !WEBHOOK_EVENT_ID.test(webhookEventId)) return null;
  if (typeof type !== 'string' || type.length === 0 || type.length > 64) return null;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const context = asObject(event.deliveryContext);
  const isRedelivery = context?.isRedelivery;
  if (isRedelivery !== undefined && typeof isRedelivery !== 'boolean') return null;
  const deliveryMode = mode === 'standby' ? 'standby' : 'active';
  if (mode !== undefined && mode !== 'active' && mode !== 'standby') return null;
  return {
    webhookEventId,
    eventType: type,
    deliveryMode,
    isRedelivery: isRedelivery === true,
    providerTimestamp: new Date(timestamp),
    raw: event,
  };
}

export function lineProtectedPayloadRef(channelAccountId: string, webhookEventId: string): string {
  const digest = createHash('sha256').update(`${channelAccountId}|${webhookEventId}`).digest('hex');
  return `wh_${digest.slice(0, 48)}`;
}

/**
 * hash ของ "ตัว event" ที่ใช้ตัดสิน duplicate กับ conflict — ไม่รวม `deliveryContext` เพราะ LINE
 * เปลี่ยน `isRedelivery` เป็น true ตอนส่งซ้ำ ถ้านับด้วย redelivery ปกติทุกครั้งจะกลายเป็น
 * idempotency conflict และถูก quarantine (#359 §D: redelivery เป็น metadata ไม่ใช่ identity)
 */
export function lineEventPayloadDigest(event: Record<string, unknown>): string {
  const { deliveryContext: _redeliveryMetadata, ...identity } = event;
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

export class LineWebhookIngress {
  private readonly events: LineEventOutboxRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly binding: LineWebhookBinding,
    private readonly id: () => string = randomUUID,
  ) {
    this.events = new LineEventOutboxRepository(database);
  }

  async handle(request: LineWebhookRequest): Promise<LineWebhookIngressResult> {
    const empty = { accepted: 0, duplicates: 0, conflicts: 0 };
    if (request.rawBody.byteLength > LINE_WEBHOOK_MAX_BODY_BYTES) {
      return { status: 413, code: 'WEBHOOK_SCHEMA_INVALID', ...empty };
    }
    // signature เป็น authority เดียว (#359 §B) — IP หรือ header อื่นไม่ใช่
    if (!verifyLineSignature(request.rawBody, this.binding.channelSecret, request.signature)) {
      return { status: 401, code: 'WEBHOOK_SIGNATURE_INVALID', ...empty };
    }

    let body: Record<string, unknown> | null;
    try {
      body = asObject(JSON.parse(request.rawBody.toString('utf8')) as unknown);
    } catch {
      return { status: 400, code: 'WEBHOOK_SCHEMA_INVALID', ...empty };
    }
    if (!body || !Array.isArray(body.events)) {
      return { status: 400, code: 'WEBHOOK_SCHEMA_INVALID', ...empty };
    }
    if (body.events.length === 0) {
      return { status: 200, code: 'WEBHOOK_EMPTY_VERIFICATION', ...empty };
    }

    const parsed: ParsedLineEvent[] = [];
    for (const candidate of body.events) {
      const event = parseEvent(candidate);
      if (!event) return { status: 400, code: 'WEBHOOK_SCHEMA_INVALID', ...empty };
      parsed.push(event);
    }

    const destination = typeof body.destination === 'string' ? body.destination : '';
    const mismatch = destination !== this.binding.destination;

    try {
      return await withTenantDatabaseTransaction(
        this.database,
        this.binding.tenantId,
        async (transaction) => {
          if (mismatch) {
            await this.recordDestinationMismatch(transaction, parsed, request.receivedAt);
            return {
              status: 200 as const,
              code: 'WEBHOOK_DESTINATION_MISMATCH' as const,
              ...empty,
            };
          }
          return this.persist(transaction, parsed, request.receivedAt);
        },
      );
    } catch (error) {
      if (error instanceof LineIdempotencyConflictError) {
        return { status: 200, code: 'WEBHOOK_IDEMPOTENCY_CONFLICT', ...empty };
      }
      // ยังไม่ durable — ห้ามตอบ 2xx เพราะ LINE จะไม่ redeliver ให้ (#359 §C)
      return { status: 503, code: 'WEBHOOK_DURABILITY_UNAVAILABLE', ...empty };
    }
  }

  /**
   * inbox + payload + event ของทั้ง request อยู่ใน transaction เดียว: ล้มกลางทางแปลว่าไม่มีแถวใดเลย
   * และผู้เรียกตอบ 503 ให้ provider ส่งซ้ำ
   */
  private async persist(
    transaction: Prisma.TransactionClient,
    events: ParsedLineEvent[],
    receivedAt: Date,
  ): Promise<LineWebhookIngressResult> {
    let accepted = 0;
    let duplicates = 0;
    let conflicts = 0;

    for (const event of events) {
      const payloadHash = lineEventPayloadDigest(event.raw);
      const protectedPayloadRef = lineProtectedPayloadRef(
        this.binding.channelAccountId,
        event.webhookEventId,
      );
      const entry: LineWebhookEventInput & { tenantId: string; channelAccountId: string } = {
        id: this.id(),
        tenantId: this.binding.tenantId,
        channelAccountId: this.binding.channelAccountId,
        webhookEventId: event.webhookEventId,
        payloadHash,
        eventType: event.eventType,
        deliveryMode: event.deliveryMode,
        isRedelivery: event.isRedelivery,
        providerTimestamp: event.providerTimestamp,
        protectedPayloadRef,
      };

      const inserted = await transaction.dlLineWebhookInboxEntry.createMany({
        data: [{ ...entry, receivedAt }],
        skipDuplicates: true,
      });
      if (inserted.count !== 1) {
        const existing = await transaction.dlLineWebhookInboxEntry.findFirstOrThrow({
          where: {
            tenantId: this.binding.tenantId,
            channelAccountId: this.binding.channelAccountId,
            webhookEventId: event.webhookEventId,
          },
        });
        if (existing.payloadHash === payloadHash) {
          duplicates += 1;
          continue;
        }
        // payload ต่างบน event ID เดิม: quarantine ของเดิม ไม่เขียนทับ (#359 §C)
        await transaction.dlLineWebhookInboxEntry.updateMany({
          where: {
            tenantId: this.binding.tenantId,
            id: existing.id,
            state: { in: ['PENDING', 'PROCESSING'] },
          },
          data: {
            state: 'QUARANTINED',
            outcomeCode: 'WEBHOOK_IDEMPOTENCY_CONFLICT',
            completedAt: receivedAt,
            leaseOwner: null,
            leaseExpiresAt: null,
          },
        });
        await this.audit(
          transaction,
          `webhook-conflict:${existing.id}:${payloadHash}`,
          'WEBHOOK_IDEMPOTENCY_CONFLICT',
          existing.id,
          payloadHash,
          receivedAt,
        );
        conflicts += 1;
        continue;
      }

      await this.storePayload(transaction, protectedPayloadRef, event, payloadHash, receivedAt);
      const inbound: LineInboundEventV1 = {
        type: 'channel.line.inbound.v1',
        eventId: `line-inbound:${this.binding.channelAccountId}:${event.webhookEventId}`,
        tenantId: toTenantId(this.binding.tenantId),
        occurredAt: event.providerTimestamp.toISOString(),
        correlationId: protectedPayloadRef,
        channelAccountId: this.binding.channelAccountId,
        webhookEventId: event.webhookEventId,
        eventType: event.eventType,
        providerTimestamp: event.providerTimestamp.toISOString(),
        payloadHash,
        protectedPayloadRef,
      };
      await this.events.enqueue(
        {
          id: this.id(),
          tenantId: this.binding.tenantId,
          event: inbound,
          orderingKey: this.binding.channelAccountId,
        },
        transaction,
      );
      accepted += 1;
    }

    const code: LineWebhookCode =
      conflicts > 0
        ? 'WEBHOOK_IDEMPOTENCY_CONFLICT'
        : accepted > 0
          ? 'WEBHOOK_ACCEPTED'
          : 'WEBHOOK_DUPLICATE';
    return { status: 200, code, accepted, duplicates, conflicts };
  }

  /** ciphertext เท่านั้น — plaintext ของ body ไม่เคยถูกเขียนลง database */
  private async storePayload(
    transaction: Prisma.TransactionClient,
    protectedPayloadRef: string,
    event: ParsedLineEvent,
    payloadHash: string,
    receivedAt: Date,
  ) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.binding.payloadKey, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(event.raw), 'utf8'),
      cipher.final(),
    ]);
    await transaction.dlLineWebhookPayload.createMany({
      data: [
        {
          id: this.id(),
          tenantId: this.binding.tenantId,
          protectedPayloadRef,
          channelAccountId: this.binding.channelAccountId,
          keyRef: this.binding.payloadKeyRef,
          iv,
          authTag: cipher.getAuthTag(),
          ciphertext,
          payloadHash,
          receivedAt,
        },
      ],
      skipDuplicates: true,
    });
  }

  private async recordDestinationMismatch(
    transaction: Prisma.TransactionClient,
    events: ParsedLineEvent[],
    receivedAt: Date,
  ) {
    for (const event of events) {
      const id = this.id();
      await transaction.dlLineWebhookInboxEntry.createMany({
        data: [
          {
            id,
            tenantId: this.binding.tenantId,
            channelAccountId: this.binding.channelAccountId,
            webhookEventId: event.webhookEventId,
            payloadHash: lineEventPayloadDigest(event.raw),
            eventType: event.eventType,
            deliveryMode: event.deliveryMode,
            isRedelivery: event.isRedelivery,
            providerTimestamp: event.providerTimestamp,
            receivedAt,
            protectedPayloadRef: lineProtectedPayloadRef(
              this.binding.channelAccountId,
              event.webhookEventId,
            ),
            state: 'QUARANTINED',
            outcomeCode: 'WEBHOOK_DESTINATION_MISMATCH',
            completedAt: receivedAt,
          },
        ],
        skipDuplicates: true,
      });
      await this.audit(
        transaction,
        `webhook-destination:${this.binding.channelAccountId}:${event.webhookEventId}`,
        'WEBHOOK_DESTINATION_MISMATCH',
        id,
        lineEventPayloadDigest(event.raw),
        receivedAt,
      );
    }
  }

  private audit(
    transaction: Prisma.TransactionClient,
    eventId: string,
    code: LineWebhookCode,
    subjectId: string,
    evidenceDigest: string,
    occurredAt: Date,
  ) {
    return transaction.dlLineAuditEvent.createMany({
      data: [
        {
          tenantId: this.binding.tenantId,
          eventId,
          category: 'WEBHOOK',
          code,
          actorKind: 'SYSTEM',
          actorRef: INGRESS_ACTOR,
          subjectId,
          evidenceDigest,
          occurredAt,
        },
      ],
      skipDuplicates: true,
    });
  }
}
