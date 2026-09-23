/**
 * Owner: Delivery/Channels — การอ่าน/เขียนของ webhook worker (S2.5 #369)
 *
 * แยกจาก `LineWebhookRepository` (primitive ของ S2.1) เพราะเป็นงานฝั่ง "ตีความ" ที่ต้องอ่านข้าม
 * ตารางของ Delivery เอง: protected payload, message projection, submission receipt, run authorization
 * และ outbox — ไม่แตะตารางของ Contact Governance (cg_*) เลย; Touch ไปทาง port ของ owner เท่านั้น
 */
import { randomUUID } from 'node:crypto';
import {
  type DlLineWebhookInboxEntry,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { SealedLinePayload } from './line-protected-payload.js';

export interface ProjectInboundMessageInput {
  tenantId: string;
  channelAccountId: string;
  providerMessageId: string;
  inboxEntryId: string;
  webhookEventId: string;
  messageType: string;
  providerTimestamp: Date;
}

/** delivery ที่ provider รับแล้วและข้อความใบนี้ถูก quote กลับมา — มีได้มากสุดหนึ่ง delivery */
export type QuotedDeliveryLookup =
  | { status: 'NONE' }
  | { status: 'AMBIGUOUS' }
  | { status: 'FOUND'; deliveryId: string; barrierAt: Date };

/** ทุกอย่างที่ต้องใช้ผูก response กับ delivery — ได้มาจากตารางของ Delivery เท่านั้น */
export interface LineDeliveryBinding {
  deliveryId: string;
  reservationId: string;
  actionKey: string;
  /** fingerprint ของผู้รับจาก allowlist ที่ run authorization ใบนั้นอนุมัติไว้ */
  recipientFingerprint: string;
  configDigest: string;
  /** เวลาที่ข้าม submission barrier ครั้งแรก = attempt แรกเริ่มยิง (#361 §D) */
  barrierAt: Date | null;
}

export class LineInboundRepository {
  constructor(private readonly database: PrismaClient) {}

  findEntry(tenantId: string, id: string): Promise<DlLineWebhookInboxEntry | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineWebhookInboxEntry.findFirst({ where: { tenantId, id } }),
    );
  }

  async readPayload(tenantId: string, payloadRef: string): Promise<SealedLinePayload | null> {
    const row = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineProtectedPayload.findFirst({ where: { tenantId, payloadRef } }),
    );
    if (!row) return null;
    return {
      payloadRef: row.payloadRef,
      keyVersion: row.keyVersion,
      nonce: Buffer.from(row.nonce),
      authTag: Buffer.from(row.authTag),
      ciphertext: Buffer.from(row.ciphertext),
    };
  }

  /**
   * dedupe ชั้นที่สอง (#359 §E, ADR-024): message object เดิมที่มากับ event คนละตัวถูก project
   * ครั้งเดียว — คืน true เมื่อ inbox entry นี้เป็นเจ้าของ projection ผู้เรียกใช้ค่านี้ตัดสินว่าจะ
   * สร้าง side effect ต่อหรือไม่ entry เดิมที่ถูกหยิบใหม่หลัง worker ตาย (projection commit แล้ว
   * แต่ยังไม่ทันเปิด correlation) ยังได้ true เพื่อให้ทำขั้นที่ค้างต่อจนจบ
   */
  projectInboundMessage(input: ProjectInboundMessageInput): Promise<boolean> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const inserted = await transaction.dlLineInboundMessage.createMany({
        data: [{ id: randomUUID(), ...input }],
        skipDuplicates: true,
      });
      if (inserted.count === 1) return true;
      const owner = await transaction.dlLineInboundMessage.findFirst({
        where: {
          tenantId: input.tenantId,
          channelAccountId: input.channelAccountId,
          providerMessageId: input.providerMessageId,
        },
        select: { inboxEntryId: true },
      });
      return owner?.inboxEntryId === input.inboxEntryId;
    });
  }

  async findQuotedDelivery(
    tenantId: string,
    quotedMessageId: string,
  ): Promise<QuotedDeliveryLookup> {
    const attempts = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlProviderSubmissionAttempt.findMany({
        where: { tenantId, outcomeClass: 'ACCEPTED', sentMessageIds: { has: quotedMessageId } },
        select: { deliveryId: true },
      }),
    );
    const deliveries = [...new Set(attempts.map((attempt) => attempt.deliveryId))];
    if (deliveries.length === 0) return { status: 'NONE' };
    if (deliveries.length > 1) return { status: 'AMBIGUOUS' };
    const binding = await this.deliveryBinding(tenantId, deliveries[0]!);
    if (!binding?.barrierAt) return { status: 'NONE' };
    return { status: 'FOUND', deliveryId: binding.deliveryId, barrierAt: binding.barrierAt };
  }

  /** null = delivery นี้ไม่ใช่ LINE delivery ที่ผ่าน run authorization ของ tenant นี้ */
  deliveryBinding(tenantId: string, deliveryId: string): Promise<LineDeliveryBinding | null> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const outbox = await transaction.dlOutboxEntry.findFirst({
        where: { tenantId, deliveryId, adapter: 'LINE_MESSAGING_API' },
        select: { deliveryId: true, reservationId: true, actionKey: true },
      });
      if (!outbox) return null;
      const run = await transaction.dlLineRunAuthorization.findFirst({
        where: { tenantId, consumedDeliveryId: deliveryId },
        select: { allowlistEntryId: true, configDigest: true },
      });
      if (!run) return null;
      const allowlist = await transaction.dlLineAllowlistEntry.findFirst({
        where: { tenantId, id: run.allowlistEntryId },
        select: { recipientFingerprint: true },
      });
      if (!allowlist) return null;
      const firstAttempt = await transaction.dlProviderSubmissionAttempt.findFirst({
        where: { tenantId, deliveryId },
        orderBy: { attemptNo: 'asc' },
        select: { startedAt: true },
      });
      return {
        deliveryId: outbox.deliveryId,
        reservationId: outbox.reservationId,
        actionKey: outbox.actionKey,
        recipientFingerprint: allowlist.recipientFingerprint,
        configDigest: run.configDigest,
        barrierAt: firstAttempt?.startedAt ?? null,
      };
    });
  }
}
