/**
 * Owner: Delivery/Channels — production `LineTouchGovernancePort` (S2.6b #403)
 *
 * Authority: #361 §D/§F, #362 §2/§4/§8
 *
 * the worker asks "which accepted delivery does this provider message ID belong to, and who was it sent to"; the answer is assembled from:
 * - Delivery itself: an accepted attempt receipt with a matching `sentMessageIds` → deliveryId;
 *   the logical delivery cap ledger → recipient fingerprint + gate (must be the same channel as the webhook)
 * - Governance: `findAcceptedAttempt` → attemptId/reservation/actionKey (never reads `cg_*` itself)
 *
 * Any part not found = `null` so the worker keeps the correlation as PENDING/quarantine per the window
 * No userId/body passes through this port — the response sender is compared by fingerprint only
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
        // a message ID of another channel that happens to collide must not bind across channels
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
