/**
 * Owner: Delivery/Channels — production `LineTouchGovernancePort` (S2.6b #403)
 *
 * Authority: #361 §D/§F, #362 §2/§4/§8
 *
 * worker ถามว่า "provider message ID นี้เป็นของ accepted delivery ใบไหน และส่งถึงใคร" คำตอบประกอบจาก:
 * - Delivery เอง: attempt receipt ที่ accepted และมี `sentMessageIds` ตรง → deliveryId;
 *   cap ledger ของ logical delivery → recipient fingerprint + gate (ต้องเป็น channel เดียวกับ webhook)
 * - Governance: `findAcceptedAttempt` → attemptId/reservation/actionKey (ไม่อ่าน `cg_*` เอง)
 *
 * ไม่พบส่วนใดส่วนหนึ่ง = `null` ให้ worker คง correlation เป็น PENDING/quarantine ตาม window
 * ไม่มี userId/body ผ่าน port นี้ — ผู้ส่ง response เทียบกันด้วย fingerprint เท่านั้น
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  deliveryId as toDeliveryId,
  tenantId as toTenantId,
  type ContactTouchCorrelationPort,
  type RecordCorrelatedTouchInput,
} from '@d-contact/cxa-contracts';
import type { LineAcceptedAttempt, LineTouchGovernancePort } from './line-webhook-worker.js';

export class LineTouchGovernanceAdapter implements LineTouchGovernancePort {
  constructor(
    private readonly database: PrismaClient,
    private readonly governance: ContactTouchCorrelationPort,
  ) {}

  async findAcceptedAttemptByMessage(input: {
    tenantId: string;
    channelAccountId: string;
    providerMessageId: string;
  }): Promise<LineAcceptedAttempt | null> {
    const binding = await withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      async (transaction) => {
        const receipt = await transaction.dlProviderSubmissionAttempt.findFirst({
          where: {
            tenantId: input.tenantId,
            outcomeClass: 'ACCEPTED',
            sentMessageIds: { has: input.providerMessageId },
          },
          orderBy: { attemptNo: 'asc' },
          select: { deliveryId: true },
        });
        if (!receipt) return null;
        const ledger = await transaction.dlLineCapLedgerEntry.findFirst({
          where: {
            tenantId: input.tenantId,
            deliveryId: receipt.deliveryId,
            capKind: 'LOGICAL_DELIVERY',
          },
          select: { recipientFingerprint: true, gateId: true },
        });
        if (!ledger) return null;
        const gate = await transaction.dlLineScopeGate.findFirst({
          where: { tenantId: input.tenantId, id: ledger.gateId },
          select: { channelAccountId: true },
        });
        // message ID ของอีก channel ที่บังเอิญซ้ำกันต้องไม่ผูกข้าม channel
        if (gate?.channelAccountId !== input.channelAccountId) return null;
        return {
          deliveryId: receipt.deliveryId,
          recipientFingerprint: ledger.recipientFingerprint,
        };
      },
    );
    if (!binding) return null;

    const attempt = await this.governance.findAcceptedAttempt({
      tenantId: toTenantId(input.tenantId),
      deliveryId: toDeliveryId(binding.deliveryId),
    });
    if (!attempt) return null;
    return {
      deliveryId: binding.deliveryId,
      attemptId: attempt.attemptId,
      reservationId: attempt.reservationId,
      actionKey: attempt.actionKey,
      recipientFingerprint: binding.recipientFingerprint,
      acceptedAt: new Date(attempt.acceptedAt),
    };
  }

  async recordCorrelatedTouch(input: RecordCorrelatedTouchInput): Promise<void> {
    await this.governance.recordCorrelatedTouch(input);
  }
}
