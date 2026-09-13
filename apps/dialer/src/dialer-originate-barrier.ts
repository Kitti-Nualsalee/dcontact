/**
 * J2.9 — Dialer owner barrier: proves that `ADMIT_CAMPAIGN_TARGET`/
 * `SCHEDULE_CALLBACK` (J2.5/J2.6) never reserve outbound early, and that any
 * future originate re-checks CURRENT Campaign/Callback owner `CONTACT` scope
 * and calls Contact Governance fresh — never reusing the admission-time
 * decision — before any (simulated) provider I/O. Hard boundary:
 * `actualProviderTraffic=false`; `dialer-telephony-test-transport.ts` only
 * ever accepts `TEST_ADAPTER`.
 *
 * Deliberately synchronous per call (check-then-simulate, no enqueue-then-
 * later-pick-up gap): unlike C1 SEND's delivery worker, there is no async
 * window during which a queued outbound could go stale, so "restrictive
 * mutation ชนะ pending outbound" (#122/#124) holds by construction — every
 * scope/governance read is live at the moment of the call, never cached —
 * rather than needing a second CG3-canonical-event invalidation listener
 * like `dialer-governance.ts` (S1.7) built for the separate `ObAttempt`
 * aggregate. A crash between two of this barrier's own short transactions
 * can leave a target/callback stuck in `ORIGINATING`; recovering that via a
 * durable lease/outbox (like `DeliveryTestAdapter`'s) is out of scope for
 * this slice — see PR description.
 */
import { randomUUID } from 'node:crypto';
import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  contactId as toContactId,
  deliveryId as toDeliveryId,
  outcomeRef as toOutcomeRef,
  providerRequestKey as toProviderRequestKey,
  reservationId as toReservationId,
  teamId as toTeamId,
  tenantId as toTenantId,
  actionKey as toActionKey,
  type ContactGovernancePort,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import {
  TELEPHONY_TEST_ADAPTER,
  type TelephonyTransport,
} from './dialer-telephony-test-transport.js';
import { DialerOwnerBarrierGate } from './dialer-owner-barrier-gate.js';

export type OriginateOutcome =
  | 'ORIGINATED'
  | 'REJECTED'
  | 'GATE_CLOSED'
  | 'SHADOW_OBSERVED'
  | 'SCOPE_DENIED'
  | 'GOVERNANCE_BLOCKED'
  | 'GOVERNANCE_DEFERRED'
  | 'GOVERNANCE_REVIEW'
  | 'NOT_ELIGIBLE'
  | 'EXPIRED';

export interface DialerOriginateBarrierOptions {
  now?: () => Date;
  transport?: TelephonyTransport;
  /** callback ที่ยังไม่ถึง `requestedFor` ภายใน tolerance นี้ยังไม่ eligible ให้ originate */
  callbackEarlyToleranceMs?: number;
}

export class DialerOriginateBarrier {
  private readonly now: () => Date;
  private readonly transport: TelephonyTransport;
  private readonly callbackEarlyToleranceMs: number;

  constructor(
    private readonly database: PrismaClient,
    private readonly governance: ContactGovernancePort,
    private readonly scopeAuthorizer: TeamContactScopeAuthorizer,
    private readonly gate: DialerOwnerBarrierGate,
    options: DialerOriginateBarrierOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    if (!options.transport) {
      throw new Error(
        'DialerOriginateBarrier ต้องได้รับ transport ที่ตรวจ TEST_ADAPTER แล้วอย่างชัดเจน',
      );
    }
    this.transport = options.transport;
    this.callbackEarlyToleranceMs = options.callbackEarlyToleranceMs ?? 5 * 60 * 1_000;
  }

  async originateCampaignTarget(
    tenantId: string,
    campaignTargetId: string,
    correlationId: string,
  ): Promise<OriginateOutcome> {
    const gateState = this.gate.currentState(tenantId);
    if (gateState === 'DISABLED' || gateState === 'KILLED') return 'GATE_CLOSED';

    const target = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCampaignTarget.findFirst({ where: { id: campaignTargetId, tenantId } }),
    );
    if (!target || target.state !== 'ADMITTED') return 'NOT_ELIGIBLE';

    const campaign = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCampaign.findFirst({ where: { id: target.campaignId, tenantId } }),
    );
    if (!campaign || campaign.status !== 'ACTIVE') {
      await this.deferCampaignTarget(tenantId, target.id, target.version);
      return 'NOT_ELIGIBLE';
    }

    const at = this.now().toISOString();
    const scope = await this.scopeAuthorizer.authorize({
      tenantId: toTenantId(tenantId),
      teamId: toTeamId(target.targetOwnerTeamId),
      contactId: toContactId(target.contactId),
      permission: 'CONTACT',
      at,
    });
    if (scope.decision !== 'ALLOW') {
      await this.deferCampaignTarget(tenantId, target.id, target.version);
      return 'SCOPE_DENIED';
    }
    if (gateState === 'SHADOW_RECEIPT') return 'SHADOW_OBSERVED';

    const actionKey = toActionKey(`originate:campaign-target:${target.id}`);
    const authOutcome = await this.governance.authorizeAndReserve(toTenantId(tenantId), {
      channel: 'VOICE',
      purpose: 'CAMPAIGN_OUTREACH',
      source: 'DIALER_ORIGINATE',
      sourceId: target.id,
      actionKey,
      policyVersion: 1,
      contactId: target.contactId,
      correlationId,
    });
    if (authOutcome.decision !== 'ALLOW' || !authOutcome.reservationId) {
      await this.deferCampaignTarget(tenantId, target.id, target.version);
      return this.mapNonAllowDecision(authOutcome.decision);
    }

    const originating = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      (transaction) =>
        transaction.obCampaignTarget.updateMany({
          where: { tenantId, id: target.id, state: 'ADMITTED' },
          data: { state: 'ORIGINATING', version: { increment: 1 } },
        }),
    );
    if (originating.count === 0) return 'NOT_ELIGIBLE';

    const accepted = await this.runTelephonySimulation(
      tenantId,
      correlationId,
      authOutcome.reservationId,
      actionKey,
      target.contactId,
      'campaign_target',
      target.id,
    );

    await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCampaignTarget.updateMany({
        where: { tenantId, id: target.id, state: 'ORIGINATING' },
        data: accepted
          ? { state: 'CONSUMED', version: { increment: 1 } }
          : { state: 'DEFERRED', version: { increment: 1 } },
      }),
    );
    return accepted ? 'ORIGINATED' : 'REJECTED';
  }

  async originateCallback(
    tenantId: string,
    callbackId: string,
    correlationId: string,
  ): Promise<OriginateOutcome> {
    const gateState = this.gate.currentState(tenantId);
    if (gateState === 'DISABLED' || gateState === 'KILLED') return 'GATE_CLOSED';

    const callback = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCallback.findFirst({ where: { id: callbackId, tenantId } }),
    );
    if (!callback || callback.state !== 'SCHEDULED') return 'NOT_ELIGIBLE';

    const now = this.now();
    if (now.getTime() > callback.expiresAt.getTime()) return 'EXPIRED';
    if (now.getTime() < callback.requestedFor.getTime() - this.callbackEarlyToleranceMs) {
      return 'NOT_ELIGIBLE';
    }

    const scope = await this.scopeAuthorizer.authorize({
      tenantId: toTenantId(tenantId),
      teamId: toTeamId(callback.targetOwnerTeamId),
      contactId: toContactId(callback.contactId),
      permission: 'CONTACT',
      at: now.toISOString(),
    });
    if (scope.decision !== 'ALLOW') return 'SCOPE_DENIED';
    if (gateState === 'SHADOW_RECEIPT') return 'SHADOW_OBSERVED';

    const actionKey = toActionKey(`originate:callback:${callback.id}`);
    const authOutcome = await this.governance.authorizeAndReserve(toTenantId(tenantId), {
      channel: 'VOICE',
      purpose: 'CALLBACK_OUTREACH',
      source: 'DIALER_ORIGINATE',
      sourceId: callback.id,
      actionKey,
      policyVersion: 1,
      contactId: callback.contactId,
      correlationId,
    });
    if (authOutcome.decision !== 'ALLOW' || !authOutcome.reservationId) {
      return this.mapNonAllowDecision(authOutcome.decision);
    }

    const originating = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      (transaction) =>
        transaction.obCallback.updateMany({
          where: { tenantId, id: callback.id, state: 'SCHEDULED' },
          data: { state: 'ORIGINATING', version: { increment: 1 } },
        }),
    );
    if (originating.count === 0) return 'NOT_ELIGIBLE';

    const accepted = await this.runTelephonySimulation(
      tenantId,
      correlationId,
      authOutcome.reservationId,
      actionKey,
      callback.contactId,
      'callback',
      callback.id,
    );

    await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCallback.updateMany({
        where: { tenantId, id: callback.id, state: 'ORIGINATING' },
        data: accepted
          ? { state: 'CONSUMED', version: { increment: 1 } }
          : { state: 'SCHEDULED', version: { increment: 1 } },
      }),
    );
    return accepted ? 'ORIGINATED' : 'REJECTED';
  }

  private mapNonAllowDecision(
    decision: 'BLOCK' | 'DEFER' | 'REVIEW' | 'ALLOW',
  ): OriginateOutcome {
    if (decision === 'BLOCK') return 'GOVERNANCE_BLOCKED';
    if (decision === 'DEFER') return 'GOVERNANCE_DEFERRED';
    return 'GOVERNANCE_REVIEW';
  }

  private async deferCampaignTarget(
    tenantId: string,
    id: string,
    expectedVersion: number,
  ): Promise<void> {
    await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCampaignTarget.updateMany({
        where: { tenantId, id, version: expectedVersion, state: 'ADMITTED' },
        data: { state: 'DEFERRED', version: { increment: 1 } },
      }),
    );
  }

  /**
   * claim -> begin -> transport -> confirm/settle ทั้งชุดในเรียกเดียว (ดู header comment
   * เรื่อง synchronous-by-design); คืน true เมื่อ TEST_ADAPTER ตอบ ACCEPTED
   */
  private async runTelephonySimulation(
    tenantId: string,
    correlationId: string,
    reservationId: string,
    actionKey: string,
    contactId: string,
    targetKind: 'campaign_target' | 'callback',
    targetId: string,
  ): Promise<boolean> {
    const tenant = toTenantId(tenantId);
    const deliveryId = toDeliveryId(randomUUID());
    const providerRequestKey = toProviderRequestKey(randomUUID());
    const leaseExpiresAt = new Date(this.now().getTime() + 30_000).toISOString();
    const command = {
      tenantId: tenant,
      correlationId,
      reservationId: toReservationId(reservationId),
      actionKey: toActionKey(actionKey),
      deliveryId,
    };

    await this.governance.claimReservationForDelivery({
      ...command,
      contactId: toContactId(contactId),
      channel: 'VOICE',
      purpose: targetKind === 'campaign_target' ? 'CAMPAIGN_OUTREACH' : 'CALLBACK_OUTREACH',
      senderIdentityId: 'dialer-originate-test-adapter',
      leaseExpiresAt,
    });
    await this.governance.beginProviderSubmission({
      ...command,
      expectedLeaseVersion: 1,
      providerRequestKey,
    });

    const response = await this.transport.originate({
      adapter: TELEPHONY_TEST_ADAPTER,
      targetKind,
      targetId,
      providerRequestKey,
    });

    if (response.status === 'ACCEPTED') {
      await this.governance.confirmProviderAcceptance({ ...command, providerRequestKey });
      await this.governance.settleDelivery({
        ...command,
        providerRequestKey,
        outcomeRef: toOutcomeRef(randomUUID()),
        outcome: 'DELIVERED',
        occurredAt: this.now().toISOString(),
      });
      return true;
    }

    await this.governance.settleDelivery({
      ...command,
      providerRequestKey,
      outcomeRef: toOutcomeRef(randomUUID()),
      outcome: 'PROVIDER_REJECTED',
      occurredAt: this.now().toISOString(),
    });
    return false;
  }
}
