/**
 * J2.9 follow-up — crash recovery of the originate barrier.
 *
 * `DialerOriginateBarrier` runs two short transactions: claim (`-> ORIGINATING`)
 * then settle (`-> CONSUMED/DEFERRED/SCHEDULED`). If the process dies between these two steps,
 * the target/callback stays in `ORIGINATING` forever.
 *
 * This sweeper cleans up only rows whose `originateLeaseExpiresAt` has expired, following the same
 * contract as C1 `DeliveryTestAdapter.reconcileExpired`: **do not release the reservation,
 * do not refund and do not originate again**, because when the lease expires we cannot know whether the provider
 * (TEST_ADAPTER) has already taken the call; guessing and firing again could mean calling the contact twice,
 * which violates the governance boundary of #124 — so the row moves to `RECONCILING` for a CG3 primitive
 * or a person to decide instead.
 */
import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';

export type OriginateReconcileKind = 'campaign_target' | 'callback';

/** Evidence for J2-OB01: no contactId/PII — only the record identity and the time */
export interface OriginateReconcileEvidence {
  kind: OriginateReconcileKind;
  recordId: string;
  leaseExpiredAt: string;
  reconciledAt: string;
  correlationId: string;
}

export interface DialerOriginateReconcilerOptions {
  now?: () => Date;
  /** Prevents a single sweep round from sweeping a whole tenant and holding locks for a long time */
  batchSize?: number;
}

export class DialerOriginateReconciler {
  private readonly now: () => Date;
  private readonly batchSize: number;

  constructor(
    private readonly database: PrismaClient,
    options: DialerOriginateReconcilerOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.batchSize = options.batchSize ?? 100;
  }

  /**
   * Moves every row stuck in `ORIGINATING` until its lease expires to `RECONCILING`.
   *
   * Idempotent by construction: the update condition always forces `state: 'ORIGINATING'`, so the second round
   * finds nothing and returns an empty array rather than settling again.
   */
  async reconcileExpired(
    tenantId: string,
    correlationId: string,
  ): Promise<OriginateReconcileEvidence[]> {
    const deadline = this.now();
    const evidence: OriginateReconcileEvidence[] = [];

    const targets = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCampaignTarget.findMany({
        where: {
          tenantId,
          state: 'ORIGINATING',
          originateLeaseExpiresAt: { not: null, lte: deadline },
        },
        orderBy: { originateLeaseExpiresAt: 'asc' },
        take: this.batchSize,
      }),
    );
    for (const target of targets) {
      const moved = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.obCampaignTarget.updateMany({
          where: { tenantId, id: target.id, state: 'ORIGINATING', version: target.version },
          data: { state: 'RECONCILING', originateLeaseExpiresAt: null, version: { increment: 1 } },
        }),
      );
      if (moved.count === 0) continue; // lost the race to a settle that arrived first — let the settle win
      evidence.push({
        kind: 'campaign_target',
        recordId: target.id,
        leaseExpiredAt: target.originateLeaseExpiresAt!.toISOString(),
        reconciledAt: deadline.toISOString(),
        correlationId,
      });
    }

    const callbacks = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.obCallback.findMany({
        where: {
          tenantId,
          state: 'ORIGINATING',
          originateLeaseExpiresAt: { not: null, lte: deadline },
        },
        orderBy: { originateLeaseExpiresAt: 'asc' },
        take: this.batchSize,
      }),
    );
    for (const callback of callbacks) {
      const moved = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.obCallback.updateMany({
          where: { tenantId, id: callback.id, state: 'ORIGINATING', version: callback.version },
          data: { state: 'RECONCILING', originateLeaseExpiresAt: null, version: { increment: 1 } },
        }),
      );
      if (moved.count === 0) continue;
      evidence.push({
        kind: 'callback',
        recordId: callback.id,
        leaseExpiredAt: callback.originateLeaseExpiresAt!.toISOString(),
        reconciledAt: deadline.toISOString(),
        correlationId,
      });
    }

    return evidence;
  }
}
