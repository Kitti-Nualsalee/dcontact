/**
 * Owner: Delivery/Channels — สร้าง LINE delivery จาก reservation ที่ Governance อนุมัติ (S2.6b #403)
 *
 * Authority: #357 §2 (providerRequestKey), #362 §4 (UUID key persist ก่อนตอบ QUEUED), #57 (binding)
 *
 * - `providerRequestKey` เป็น hexadecimal UUID ที่สร้างครั้งเดียวแล้ว persist พร้อมแถว outbox;
 *   replay `actionKey` เดิมคืน delivery/key เดิมเสมอ ไม่ mint ใหม่ (#357)
 * - binding กับ reservation ผ่าน `claimReservationForDelivery` ของ Governance เท่านั้น — Delivery
 *   ไม่อ่าน/เขียน `cg_*` เอง
 * - content ต้องเป็น approved fixture ของ S2 (ชุดปิด) — free text ถูกปฏิเสธตั้งแต่ enqueue
 * - enqueue ไม่แตะ network และไม่ข้าม barrier; การส่งจริงอยู่ที่ `LineOutboundAdapter.submit`
 */
import { createHash, randomUUID } from 'node:crypto';
import type { PrismaClient } from '@d-contact/db';
import {
  ReservationBindingError,
  deliveryId as toDeliveryId,
  type ActionKey,
  type ContactGovernancePort,
  type ContactId,
  type IdentityId,
  type ReservationId,
  type TenantId,
} from '@d-contact/cxa-contracts';
import { isLineFixtureRef } from './line-push-request.js';
import { OutboxEntryAlreadyExistsError, OutboxRepository } from './outbox-repository.js';

export interface EnqueueLineDeliveryCommand {
  tenantId: TenantId;
  correlationId: string;
  causationId?: string;
  reservationId: ReservationId;
  actionKey: ActionKey;
  contactId: ContactId;
  identityId?: IdentityId;
  purpose: string;
  source: string;
  senderIdentityId: string;
  contentRef: string;
  leaseExpiresAt: string;
}

export type EnqueueLineDeliveryResult =
  | { status: 'QUEUED' | 'REPLAYED'; deliveryId: string; providerRequestKey: string }
  | {
      status: 'ERROR';
      code: 'CONTENT_NOT_APPROVED' | 'IDEMPOTENCY_CONFLICT' | ReservationBindingError['code'];
    };

export interface LineDeliveryEnqueueOptions {
  id?: () => string;
  /** inject ได้เพื่อให้เทสต์ deterministic; production ใช้ `randomUUID` (hex UUID ตัวพิมพ์เล็ก) */
  requestKey?: () => string;
}

/** business identity ของคำสั่ง — correlation/causation เป็น trace จึงไม่อยู่ใน hash */
function lineInputHash(command: EnqueueLineDeliveryCommand): string {
  const canonical = [
    command.tenantId,
    command.reservationId,
    command.actionKey,
    command.contactId,
    command.identityId ?? '',
    command.purpose,
    command.source,
    command.senderIdentityId,
    command.contentRef,
  ];
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function lineDeliveryId(tenantId: string, actionKey: string, inputHash: string): string {
  const digest = createHash('sha256')
    .update(`line-delivery|${tenantId}|${actionKey}|${inputHash}`)
    .digest('hex');
  return `dlv_line_${digest.slice(0, 32)}`;
}

export class LineDeliveryEnqueue {
  private readonly outbox: OutboxRepository;
  private readonly id: () => string;
  private readonly requestKey: () => string;

  constructor(
    database: PrismaClient,
    private readonly governance: Pick<ContactGovernancePort, 'claimReservationForDelivery'>,
    options: LineDeliveryEnqueueOptions = {},
  ) {
    this.outbox = new OutboxRepository(database, 'LINE_MESSAGING_API');
    this.id = options.id ?? randomUUID;
    this.requestKey = options.requestKey ?? randomUUID;
  }

  async enqueue(command: EnqueueLineDeliveryCommand): Promise<EnqueueLineDeliveryResult> {
    if (!isLineFixtureRef(command.contentRef)) {
      return { status: 'ERROR', code: 'CONTENT_NOT_APPROVED' };
    }
    const inputHash = lineInputHash(command);
    const existing = await this.outbox.findByActionKey(command.tenantId, command.actionKey);
    if (existing) return this.replay(existing, inputHash);

    const deliveryId = lineDeliveryId(command.tenantId, command.actionKey, inputHash);
    let leaseVersion: number;
    try {
      const claimed = await this.governance.claimReservationForDelivery({
        tenantId: command.tenantId,
        correlationId: command.correlationId,
        reservationId: command.reservationId,
        actionKey: command.actionKey,
        deliveryId: toDeliveryId(deliveryId),
        contactId: command.contactId,
        ...(command.identityId ? { identityId: command.identityId } : {}),
        channel: 'LINE',
        purpose: command.purpose,
        senderIdentityId: command.senderIdentityId,
        leaseExpiresAt: command.leaseExpiresAt,
      });
      leaseVersion = claimed.leaseVersion ?? 1;
    } catch (error) {
      if (error instanceof ReservationBindingError) return { status: 'ERROR', code: error.code };
      throw error;
    }

    const providerRequestKey = this.requestKey();
    try {
      await this.outbox.create({
        id: this.id(),
        tenantId: command.tenantId,
        actionKey: command.actionKey,
        reservationId: command.reservationId,
        deliveryId,
        providerRequestKey,
        channel: 'LINE',
        contactId: command.contactId,
        ...(command.identityId ? { identityId: command.identityId } : {}),
        purpose: command.purpose,
        source: command.source,
        senderIdentityId: command.senderIdentityId,
        contentRef: command.contentRef,
        inputHash,
        leaseVersion,
        leaseExpiresAt: new Date(command.leaseExpiresAt),
        correlationId: command.correlationId,
        ...(command.causationId ? { causationId: command.causationId } : {}),
      });
    } catch (error) {
      if (!(error instanceof OutboxEntryAlreadyExistsError)) throw error;
      // ผู้ชนะ race ของ actionKey เดียวกันเขียนไปก่อน — คืนแถวของผู้ชนะ ไม่ใช่ key ของเรา
      const winner = await this.outbox.findByActionKey(command.tenantId, command.actionKey);
      return winner
        ? this.replay(winner, inputHash)
        : { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    }
    return { status: 'QUEUED', deliveryId, providerRequestKey };
  }

  private replay(
    existing: {
      adapter: string;
      inputHash: string;
      deliveryId: string;
      providerRequestKey: string;
    },
    inputHash: string,
  ): EnqueueLineDeliveryResult {
    if (existing.adapter !== 'LINE_MESSAGING_API' || existing.inputHash !== inputHash) {
      return { status: 'ERROR', code: 'IDEMPOTENCY_CONFLICT' };
    }
    return {
      status: 'REPLAYED',
      deliveryId: existing.deliveryId,
      providerRequestKey: existing.providerRequestKey,
    };
  }
}
