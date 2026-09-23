/**
 * Owner: Delivery/Channels — async worker ของ LINE webhook inbox และ Touch correlation (S2.5 #369)
 *
 * Authority: #359 §C/§D/§E, #361 §D/§F และ Phase Contract #362 §5/§7/§8
 *
 * หนึ่งรอบของ `runOnce`:
 * 1. claim inbox ด้วย lease (`FOR UPDATE SKIP LOCKED`) — worker สองตัวไม่หยิบ event เดียวกัน
 * 2. เปิด protected payload → ตีความ event
 *    - type นอกเอกสาร LINE → quarantine `WEBHOOK_UNSUPPORTED_EVENT_TYPE`
 *    - field ของ type ที่รู้จักขาด → quarantine `WEBHOOK_SCHEMA_INVALID`
 *    - message → dedupe ชั้นที่สองด้วย providerMessageId (ADR-024) ก่อน side effect ใด ๆ
 *    - quoted response / signed postback ในแชทหนึ่งต่อหนึ่ง → เปิด correlation แล้วลอง bind
 * 3. complete inbox แล้ว emit `channel.line.inbound.v1` (event ID คงที่ต่อ webhook event)
 *
 * `sweepCorrelations` ลอง bind correlation ที่ยัง PENDING ซ้ำ (response มาก่อน acceptance commit)
 * และ quarantine เป็น `USER_RESPONSE_UNBOUND` เมื่อเลย window — ไม่เดา candidate (#361 §F)
 *
 * worker ไม่เคยตัดสินว่า Touch นับหรือไม่: ส่งแค่ binding + evidence ref ให้ Contact Governance ผ่าน
 * `ContactTouchCorrelationPort` ซึ่งเป็น single writer ของ cg_* (#362 §2/§8)
 */
import { randomUUID } from 'node:crypto';
import {
  CorrelatedTouchError,
  deliveryId as toDeliveryId,
  actionKey as toActionKey,
  outcomeRef as toOutcomeRef,
  reservationId as toReservationId,
  tenantId as toTenantId,
  type ContactTouchCorrelatedEventV1,
  type ContactTouchCorrelationPort,
  type LineInboundEventV1,
  type TouchEvidenceKind,
} from '@d-contact/cxa-contracts';
import type { DlLineTouchCorrelation, DlLineWebhookInboxEntry } from '@d-contact/db';
import { interpretLineEvent, type LineInterpretedEvent } from './line-webhook-event.js';
import { lineResponseEvidenceRef } from './line-webhook-ingress.js';
import type { LineInboundRepository } from './line-inbound-repository.js';
import type { LinePostbackTokenCodec } from './line-postback-token.js';
import {
  LineProtectedPayloadError,
  openLinePayload,
  type LinePayloadKeyring,
} from './line-protected-payload.js';
import { LineIdempotencyConflictError } from './line-repository-support.js';
import type { LineWebhookRepository } from './line-webhook-repository.js';
import { lineRecipientFingerprint } from './line-webhook-signature.js';

/** window ของ response ต่อ submission barrier (#361 §D) */
export const LINE_RESPONSE_WINDOW_MS = 24 * 60 * 60_000;

export const LINE_CORRELATION_QUARANTINE_CODES = [
  /** เลย window แล้วยังผูกไม่ได้ หรือ response ไม่อยู่ในช่วงหลัง barrier (#361 §D/§F) */
  'USER_RESPONSE_UNBOUND',
  /** userId ของ response ไม่ตรงผู้รับที่ allowlist อนุมัติไว้ */
  'USER_RESPONSE_RECIPIENT_MISMATCH',
  /** message ID เดียวกันชี้ได้มากกว่าหนึ่ง delivery — ห้ามเดา */
  'USER_RESPONSE_AMBIGUOUS',
  /** token ของ postback ผิดลายเซ็น, หมดอายุ หรือ config digest ไม่ตรง run */
  'POSTBACK_TOKEN_INVALID',
  /** Governance ปฏิเสธ binding/evidence (Attempt ไม่ใช่ acceptance, evidence ซ้ำคนละใบ ฯลฯ) */
  'TOUCH_REJECTED_BY_GOVERNANCE',
] as const;
export type LineCorrelationQuarantineCode = (typeof LINE_CORRELATION_QUARANTINE_CODES)[number];

export type LineWebhookWorkerEvent = LineInboundEventV1 | ContactTouchCorrelatedEventV1;

/** ปลายทางของ event ที่ PII-safe — runtime ต่อเข้า durable publisher; เทสต์ใช้ array */
export interface LineWebhookEventSink {
  publish(event: LineWebhookWorkerEvent): Promise<void>;
}

export interface LineWebhookWorkerOptions {
  tenantId: string;
  channelAccountId: string;
  webhooks: Pick<
    LineWebhookRepository,
    | 'claim'
    | 'complete'
    | 'quarantine'
    | 'openCorrelation'
    | 'bindCorrelation'
    | 'quarantineCorrelation'
    | 'listPendingCorrelations'
  >;
  inbound: Pick<
    LineInboundRepository,
    'findEntry' | 'readPayload' | 'projectInboundMessage' | 'findQuotedDelivery' | 'deliveryBinding'
  >;
  keyring: LinePayloadKeyring;
  governance: ContactTouchCorrelationPort;
  events?: LineWebhookEventSink;
  /** ไม่ตั้ง = ยังไม่มี approved signed-postback template → postback เป็นแค่ inbound signal */
  postbackTokens?: LinePostbackTokenCodec;
  leaseOwner?: string;
  leaseMs?: number;
  batchSize?: number;
  now?: () => Date;
  newId?: () => string;
}

export type LineInboxOutcome =
  'COMPLETED' | 'QUARANTINED_UNSUPPORTED' | 'QUARANTINED_SCHEMA' | 'LEASE_LOST';

export type LineCorrelationOutcome =
  'BOUND' | 'PENDING' | 'ALREADY_RESOLVED' | `QUARANTINED:${LineCorrelationQuarantineCode}`;

interface CorrelationCandidate {
  evidenceKind: TouchEvidenceKind;
  quotedMessageId?: string;
  deliveryId?: string;
  windowExpiresAt: Date;
}

export class LineWebhookWorker {
  private readonly leaseOwner: string;
  private readonly leaseMs: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly newId: () => string;

  constructor(private readonly options: LineWebhookWorkerOptions) {
    this.leaseOwner = options.leaseOwner ?? `line-webhook-worker:${randomUUID()}`;
    this.leaseMs = options.leaseMs ?? 60_000;
    this.batchSize = options.batchSize ?? 20;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
  }

  /** หนึ่งรอบของ inbox — คืนผลต่อ entry เพื่อ metric/เทสต์ ไม่มี payload */
  async runOnce(): Promise<LineInboxOutcome[]> {
    const { tenantId } = this.options;
    const entries = await this.options.webhooks.claim(
      tenantId,
      this.leaseOwner,
      this.now(),
      this.leaseMs,
      this.batchSize,
    );
    const outcomes: LineInboxOutcome[] = [];
    for (const entry of entries) outcomes.push(await this.process(entry));
    return outcomes;
  }

  private async process(entry: DlLineWebhookInboxEntry): Promise<LineInboxOutcome> {
    const { tenantId } = this.options;
    const interpreted = await this.interpret(entry);

    if (interpreted.kind === 'UNSUPPORTED') {
      await this.options.webhooks.quarantine(
        tenantId,
        entry.id,
        'WEBHOOK_UNSUPPORTED_EVENT_TYPE',
        this.now(),
      );
      return 'QUARANTINED_UNSUPPORTED';
    }
    if (interpreted.kind === 'SCHEMA_INVALID') {
      await this.options.webhooks.quarantine(
        tenantId,
        entry.id,
        'WEBHOOK_SCHEMA_INVALID',
        this.now(),
      );
      return 'QUARANTINED_SCHEMA';
    }

    let firstProjection = true;
    if (interpreted.message) {
      // dedupe ก่อน side effect: message เดิมที่มาซ้ำใน event อื่นไม่เปิด correlation ใหม่
      firstProjection = await this.options.inbound.projectInboundMessage({
        tenantId,
        channelAccountId: entry.channelAccountId,
        providerMessageId: interpreted.message.providerMessageId,
        inboxEntryId: entry.id,
        webhookEventId: entry.webhookEventId,
        messageType: interpreted.message.messageType,
        providerTimestamp: entry.providerTimestamp,
      });
    }

    if (firstProjection && interpreted.oneToOneUserId) {
      const candidate = this.candidate(entry, interpreted);
      if (candidate) {
        const correlation = await this.openCorrelation(entry, candidate);
        if (correlation) await this.bind(correlation, entry, interpreted.oneToOneUserId);
      }
    }

    const completed = await this.options.webhooks.complete(
      tenantId,
      entry.id,
      this.leaseOwner,
      this.now(),
    );
    if (!completed) return 'LEASE_LOST';
    await this.options.events?.publish(this.inboundEvent(entry));
    return 'COMPLETED';
  }

  /**
   * correlation ที่ยัง PENDING: ลอง bind ซ้ำ (acceptance อาจ commit หลัง webhook) หรือ quarantine
   * เมื่อเลย window — เวลาที่ใช้ตัดคือ provider timestamp + window ไม่ใช่เวลาที่รับ (#361 §F)
   */
  async sweepCorrelations(limit = 50): Promise<LineCorrelationOutcome[]> {
    const { tenantId } = this.options;
    const pending = await this.options.webhooks.listPendingCorrelations(tenantId, limit);
    const outcomes: LineCorrelationOutcome[] = [];
    for (const correlation of pending) {
      const entry = await this.options.inbound.findEntry(tenantId, correlation.inboxEntryId);
      const interpreted = entry ? await this.interpret(entry) : undefined;
      if (!entry || interpreted?.kind !== 'SIGNAL' || !interpreted.oneToOneUserId) {
        outcomes.push(await this.quarantineCorrelation(correlation, 'USER_RESPONSE_UNBOUND'));
        continue;
      }
      outcomes.push(await this.bind(correlation, entry, interpreted.oneToOneUserId));
    }
    return outcomes;
  }

  private async interpret(entry: DlLineWebhookInboxEntry): Promise<LineInterpretedEvent> {
    const sealed = await this.options.inbound.readPayload(
      this.options.tenantId,
      entry.protectedPayloadRef,
    );
    if (!sealed) return { kind: 'SCHEMA_INVALID' };
    try {
      return interpretLineEvent(
        openLinePayload(this.options.keyring, this.options.tenantId, sealed),
      );
    } catch (error) {
      if (error instanceof LineProtectedPayloadError) return { kind: 'SCHEMA_INVALID' };
      throw error;
    }
  }

  /** มีแค่สองรูปแบบที่เป็น response ได้ (#361 §D) — อย่างอื่นเป็น inbound signal ที่ไม่สร้าง Touch */
  private candidate(
    entry: DlLineWebhookInboxEntry,
    event: Extract<LineInterpretedEvent, { kind: 'SIGNAL' }>,
  ): CorrelationCandidate | null {
    const windowCap = new Date(entry.providerTimestamp.getTime() + LINE_RESPONSE_WINDOW_MS);
    if (event.message?.quotedMessageId) {
      return {
        evidenceKind: 'USER_QUOTED_RESPONSE',
        quotedMessageId: event.message.quotedMessageId,
        windowExpiresAt: windowCap,
      };
    }
    if (event.postbackData !== undefined && this.options.postbackTokens) {
      const verified = this.options.postbackTokens.verify(
        event.postbackData,
        entry.providerTimestamp,
      );
      // token ที่ไม่ใช่ของเราคือ postback ทั่วไป ไม่ใช่ response ของ pilot — ไม่เปิด correlation
      if (verified.status === 'INVALID') return null;
      if (verified.status === 'EXPIRED') return null;
      const expiry = verified.claims.expiresAt;
      return {
        evidenceKind: 'SIGNED_POSTBACK',
        deliveryId: verified.claims.deliveryId,
        windowExpiresAt: expiry.getTime() < windowCap.getTime() ? expiry : windowCap,
      };
    }
    return null;
  }

  private async openCorrelation(
    entry: DlLineWebhookInboxEntry,
    candidate: CorrelationCandidate,
  ): Promise<DlLineTouchCorrelation | null> {
    try {
      return await this.options.webhooks.openCorrelation({
        id: this.newId(),
        tenantId: this.options.tenantId,
        inboxEntryId: entry.id,
        evidenceKind: candidate.evidenceKind,
        responseEvidenceRef: lineResponseEvidenceRef(entry.channelAccountId, entry.webhookEventId),
        ...(candidate.quotedMessageId ? { quotedMessageId: candidate.quotedMessageId } : {}),
        providerTimestamp: entry.providerTimestamp,
        windowExpiresAt: candidate.windowExpiresAt,
        ...(candidate.deliveryId ? { deliveryId: candidate.deliveryId } : {}),
      });
    } catch (error) {
      // evidence ref เดิมแต่ input ต่าง = event ที่ขัดกับของเดิม; inbox ถูก quarantine โดย ingress แล้ว
      if (error instanceof LineIdempotencyConflictError) return null;
      throw error;
    }
  }

  private async bind(
    correlation: DlLineTouchCorrelation,
    entry: DlLineWebhookInboxEntry,
    userId: string,
  ): Promise<LineCorrelationOutcome> {
    if (correlation.state !== 'PENDING') return 'ALREADY_RESOLVED';
    const { tenantId } = this.options;

    // quoted: หา delivery จาก sentMessages.id; postback: delivery มากับ token ที่ verify แล้ว
    let deliveryId = correlation.deliveryId;
    if (correlation.evidenceKind === 'USER_QUOTED_RESPONSE') {
      const lookup = await this.options.inbound.findQuotedDelivery(
        tenantId,
        correlation.quotedMessageId!,
      );
      if (lookup.status === 'AMBIGUOUS') {
        return this.quarantineCorrelation(correlation, 'USER_RESPONSE_AMBIGUOUS');
      }
      if (lookup.status === 'NONE') return this.pendingOrExpired(correlation);
      deliveryId = lookup.deliveryId;
    }
    if (!deliveryId) return this.pendingOrExpired(correlation);

    const binding = await this.options.inbound.deliveryBinding(tenantId, deliveryId);
    if (!binding?.barrierAt) return this.pendingOrExpired(correlation);

    // response ต้องอยู่หลัง barrier และไม่เกิน window ของ delivery นั้น (#361 §D)
    const occurredAt = correlation.providerTimestamp.getTime();
    if (
      occurredAt < binding.barrierAt.getTime() ||
      occurredAt > binding.barrierAt.getTime() + LINE_RESPONSE_WINDOW_MS
    ) {
      return this.quarantineCorrelation(correlation, 'USER_RESPONSE_UNBOUND');
    }
    if (lineRecipientFingerprint(entry.channelAccountId, userId) !== binding.recipientFingerprint) {
      return this.quarantineCorrelation(correlation, 'USER_RESPONSE_RECIPIENT_MISMATCH');
    }
    if (correlation.evidenceKind === 'SIGNED_POSTBACK') {
      const token = await this.postbackConfigMatches(entry, binding.configDigest);
      if (!token) return this.quarantineCorrelation(correlation, 'POSTBACK_TOKEN_INVALID');
    }

    let touch;
    try {
      touch = await this.options.governance.recordCorrelatedTouch({
        tenantId: toTenantId(tenantId),
        correlationId: `line-webhook:${entry.webhookEventId}`,
        reservationId: toReservationId(binding.reservationId),
        actionKey: toActionKey(binding.actionKey),
        deliveryId: toDeliveryId(binding.deliveryId),
        responseEvidenceRef: toOutcomeRef(correlation.responseEvidenceRef),
        evidenceKind: correlation.evidenceKind,
        occurredAt: correlation.providerTimestamp.toISOString(),
      });
    } catch (error) {
      if (!(error instanceof CorrelatedTouchError)) throw error;
      // acceptance ยังไม่ commit — คง PENDING แล้ว sweep ใหม่ภายใน window
      if (error.code === 'ATTEMPT_NOT_FOUND') return this.pendingOrExpired(correlation);
      return this.quarantineCorrelation(correlation, 'TOUCH_REJECTED_BY_GOVERNANCE');
    }

    const bound = await this.options.webhooks.bindCorrelation(
      tenantId,
      correlation.id,
      binding.deliveryId,
      touch.attemptId,
      this.now(),
    );
    // null = worker อื่น bind ไปแล้ว; Touch ฝั่ง Governance idempotent จึงไม่ซ้ำ
    if (!bound) return 'ALREADY_RESOLVED';
    await this.options.events?.publish({
      type: 'contact.touch.correlated.v1',
      eventId: `contact.touch.correlated.v1:${touch.touchId}`,
      tenantId: toTenantId(tenantId),
      occurredAt: touch.occurredAt,
      correlationId: `line-webhook:${entry.webhookEventId}`,
      attemptId: touch.attemptId,
      deliveryId: toDeliveryId(binding.deliveryId),
      responseEvidenceRef: toOutcomeRef(correlation.responseEvidenceRef),
      evidenceKind: correlation.evidenceKind,
    });
    return 'BOUND';
  }

  /** postback ต้องมาจาก token ของ delivery นี้และ config digest ของ run ที่อนุมัติ */
  private async postbackConfigMatches(
    entry: DlLineWebhookInboxEntry,
    configDigest: string,
  ): Promise<boolean> {
    const codec = this.options.postbackTokens;
    if (!codec) return false;
    const interpreted = await this.interpret(entry);
    if (interpreted.kind !== 'SIGNAL' || interpreted.postbackData === undefined) return false;
    const verified = codec.verify(interpreted.postbackData, entry.providerTimestamp);
    return verified.status === 'VALID' && verified.claims.configDigest === configDigest;
  }

  private async pendingOrExpired(
    correlation: DlLineTouchCorrelation,
  ): Promise<LineCorrelationOutcome> {
    if (this.now().getTime() <= correlation.windowExpiresAt.getTime()) return 'PENDING';
    return this.quarantineCorrelation(correlation, 'USER_RESPONSE_UNBOUND');
  }

  private async quarantineCorrelation(
    correlation: DlLineTouchCorrelation,
    code: LineCorrelationQuarantineCode,
  ): Promise<LineCorrelationOutcome> {
    const changed = await this.options.webhooks.quarantineCorrelation(
      this.options.tenantId,
      correlation.id,
      code,
      this.now(),
    );
    return changed ? `QUARANTINED:${code}` : 'ALREADY_RESOLVED';
  }

  private inboundEvent(entry: DlLineWebhookInboxEntry): LineInboundEventV1 {
    return {
      type: 'channel.line.inbound.v1',
      eventId: `channel.line.inbound.v1:${entry.channelAccountId}:${entry.webhookEventId}`,
      tenantId: toTenantId(this.options.tenantId),
      occurredAt: entry.providerTimestamp.toISOString(),
      correlationId: `line-webhook:${entry.webhookEventId}`,
      channelAccountId: entry.channelAccountId,
      webhookEventId: entry.webhookEventId,
      eventType: entry.eventType,
      providerTimestamp: entry.providerTimestamp.toISOString(),
      payloadHash: entry.payloadHash,
      protectedPayloadRef: entry.protectedPayloadRef,
    };
  }
}
