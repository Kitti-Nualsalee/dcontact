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
 * still leaves a target/callback stuck in `ORIGINATING`, so every entry into
 * that state stamps `originateLeaseExpiresAt`; `DialerOriginateReconciler`
 * sweeps the expired ones into `RECONCILING` without ever re-originating or
 * releasing the reservation itself.
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
  ReservationBindingError,
  ReservationNotUsableError,
  type AuthorizationOutcome,
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
  /** OWNER_CONFORMANCE: เงื่อนไขฝั่ง owner ผ่านครบแล้วหยุดก่อนจอง Governance reservation */
  | 'CONFORMANCE_OBSERVED'
  /** SCOPED_INTERNAL_ENABLED แต่ campaign/queue ไม่อยู่ใน allowlist — ไม่แตะ state */
  | 'OUT_OF_SCOPE'
  | 'SCOPE_DENIED'
  /** Governance ตอบไม่ได้ (throw) — fail closed โดยไม่เปลี่ยน state ให้ลองใหม่รอบหน้า */
  | 'GOVERNANCE_UNAVAILABLE'
  /** reservation ถูก invalidate ระหว่างจองกับ claim (restrictive mutation ชนะ) ก่อนมี provider I/O */
  | 'RESERVATION_INVALIDATED'
  | 'GOVERNANCE_BLOCKED'
  | 'GOVERNANCE_DEFERRED'
  | 'GOVERNANCE_REVIEW'
  | 'NOT_ELIGIBLE'
  | 'EXPIRED';

const SIMULATION_OUTCOME = {
  ACCEPTED: 'ORIGINATED',
  REJECTED: 'REJECTED',
  INVALIDATED: 'RESERVATION_INVALIDATED',
} as const satisfies Record<string, OriginateOutcome>;

/** lease เดียวกันทั้งฝั่ง Governance claim และ row ที่ค้างใน ORIGINATING */
export const DEFAULT_ORIGINATE_LEASE_MS = 30_000;

export interface DialerOriginateBarrierOptions {
  now?: () => Date;
  transport?: TelephonyTransport;
  /** callback ที่ยังไม่ถึง `requestedFor` ภายใน tolerance นี้ยังไม่ eligible ให้ originate */
  callbackEarlyToleranceMs?: number;
  /** เกินช่วงนี้แล้วยังค้าง ORIGINATING ถือว่า process ตายกลางคัน ให้ reconciler เก็บกวาด */
  originateLeaseMs?: number;
}

export class DialerOriginateBarrier {
  private readonly now: () => Date;
  private readonly transport: TelephonyTransport;
  private readonly callbackEarlyToleranceMs: number;
  private readonly originateLeaseMs: number;

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
    this.originateLeaseMs = options.originateLeaseMs ?? DEFAULT_ORIGINATE_LEASE_MS;
  }

  private originateLeaseExpiry(): Date {
    return new Date(this.now().getTime() + this.originateLeaseMs);
  }

  async originateCampaignTarget(
    tenantId: string,
    campaignTargetId: string,
    correlationId: string,
  ): Promise<OriginateOutcome> {
    const gateState = await this.gate.currentState(tenantId);
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
    if (gateState === 'OWNER_CONFORMANCE') return 'CONFORMANCE_OBSERVED';
    if (!(await this.gate.isScopeAllowed(tenantId, 'CAMPAIGN', target.campaignId))) {
      return 'OUT_OF_SCOPE';
    }

    const actionKey = toActionKey(`originate:campaign-target:${target.id}`);
    const authOutcome = await this.authorize(tenantId, {
      channel: 'VOICE',
      purpose: 'CAMPAIGN_OUTREACH',
      source: 'DIALER_ORIGINATE',
      sourceId: target.id,
      actionKey,
      policyVersion: 1,
      contactId: target.contactId,
      correlationId,
    });
    if (authOutcome === 'UNAVAILABLE') return 'GOVERNANCE_UNAVAILABLE';
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
          data: {
            state: 'ORIGINATING',
            originateLeaseExpiresAt: this.originateLeaseExpiry(),
            version: { increment: 1 },
          },
        }),
    );
    if (originating.count === 0) return 'NOT_ELIGIBLE';

    const simulated = await this.runTelephonySimulation(
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
        data:
          simulated === 'ACCEPTED'
            ? { state: 'CONSUMED', originateLeaseExpiresAt: null, version: { increment: 1 } }
            : { state: 'DEFERRED', originateLeaseExpiresAt: null, version: { increment: 1 } },
      }),
    );
    return SIMULATION_OUTCOME[simulated];
  }

  async originateCallback(
    tenantId: string,
    callbackId: string,
    correlationId: string,
  ): Promise<OriginateOutcome> {
    const gateState = await this.gate.currentState(tenantId);
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
    if (gateState === 'OWNER_CONFORMANCE') return 'CONFORMANCE_OBSERVED';
    if (!(await this.gate.isScopeAllowed(tenantId, 'CALLBACK_QUEUE', callback.queueId))) {
      return 'OUT_OF_SCOPE';
    }

    const actionKey = toActionKey(`originate:callback:${callback.id}`);
    const authOutcome = await this.authorize(tenantId, {
      channel: 'VOICE',
      purpose: 'CALLBACK_OUTREACH',
      source: 'DIALER_ORIGINATE',
      sourceId: callback.id,
      actionKey,
      policyVersion: 1,
      contactId: callback.contactId,
      correlationId,
    });
    if (authOutcome === 'UNAVAILABLE') return 'GOVERNANCE_UNAVAILABLE';
    if (authOutcome.decision !== 'ALLOW' || !authOutcome.reservationId) {
      return this.mapNonAllowDecision(authOutcome.decision);
    }

    const originating = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      (transaction) =>
        transaction.obCallback.updateMany({
          where: { tenantId, id: callback.id, state: 'SCHEDULED' },
          data: {
            state: 'ORIGINATING',
            originateLeaseExpiresAt: this.originateLeaseExpiry(),
            version: { increment: 1 },
          },
        }),
    );
    if (originating.count === 0) return 'NOT_ELIGIBLE';

    const simulated = await this.runTelephonySimulation(
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
        data:
          simulated === 'ACCEPTED'
            ? { state: 'CONSUMED', originateLeaseExpiresAt: null, version: { increment: 1 } }
            : { state: 'SCHEDULED', originateLeaseExpiresAt: null, version: { increment: 1 } },
      }),
    );
    return SIMULATION_OUTCOME[simulated];
  }

  /** Governance ที่ throw คือตอบไม่ได้ — ไม่ถือเป็น ALLOW และไม่เปลี่ยน owner state (#124 fail closed) */
  private async authorize(
    tenantId: string,
    input: Parameters<ContactGovernancePort['authorizeAndReserve']>[1],
  ): Promise<AuthorizationOutcome | 'UNAVAILABLE'> {
    try {
      return await this.governance.authorizeAndReserve(toTenantId(tenantId), input);
    } catch {
      return 'UNAVAILABLE';
    }
  }

  private mapNonAllowDecision(decision: 'BLOCK' | 'DEFER' | 'REVIEW' | 'ALLOW'): OriginateOutcome {
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
  ): Promise<'ACCEPTED' | 'REJECTED' | 'INVALIDATED'> {
    const tenant = toTenantId(tenantId);
    const deliveryId = toDeliveryId(randomUUID());
    const providerRequestKey = toProviderRequestKey(randomUUID());
    const leaseExpiresAt = this.originateLeaseExpiry().toISOString();
    const command = {
      tenantId: tenant,
      correlationId,
      reservationId: toReservationId(reservationId),
      actionKey: toActionKey(actionKey),
      deliveryId,
    };

    try {
      await this.governance.claimReservationForDelivery({
        ...command,
        contactId: toContactId(contactId),
        channel: 'VOICE',
        purpose: targetKind === 'campaign_target' ? 'CAMPAIGN_OUTREACH' : 'CALLBACK_OUTREACH',
        senderIdentityId: 'dialer-originate-test-adapter',
        leaseExpiresAt,
      });
    } catch (error) {
      // restriction/kill switch ที่มาถึงหลังจองทำให้ reservation ไม่อยู่ใน RESERVED แล้ว — ยังไม่มี provider
      // I/O จึงถอยได้อย่างปลอดภัย error อื่น (DB/Governance ล่ม) ปล่อยให้ lease sweeper ตัดสินแทนการเดา
      if (
        (error instanceof ReservationBindingError || error instanceof ReservationNotUsableError) &&
        (error.code === 'RESERVATION_NOT_RESERVED' || error.code === 'RESERVATION_EXPIRED')
      ) {
        return 'INVALIDATED';
      }
      throw error;
    }
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
      return 'ACCEPTED';
    }

    await this.governance.settleDelivery({
      ...command,
      providerRequestKey,
      outcomeRef: toOutcomeRef(randomUUID()),
      outcome: 'PROVIDER_REJECTED',
      occurredAt: this.now().toISOString(),
    });
    return 'REJECTED';
  }
}
