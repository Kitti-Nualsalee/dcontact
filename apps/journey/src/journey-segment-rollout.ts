/**
 * J3.10 (#221) — the rollout stage of J3 per tenant, and shadow evaluation
 *
 * Order: DISABLED → OWNER_BACKFILL → SHADOW_MEMBERSHIP → SHADOW_RECEIPT_REFILTER →
 * SCOPED_INTERNAL_ENABLED
 *
 * Two things that are clearly separate and often confused:
 *
 * - **the stage only moves forward** — going back would wake a writer that was already retired to write over
 *   new data, which the database rejects through `jr_segment_rollout_guard`
 * - **rollback is a freeze**, not going back a stage — it stops new effects without touching what already happened
 *   and can be reversed once the problem is fixed (the stop condition forbids a destructive down migration)
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export type SegmentRolloutStage =
  | 'DISABLED'
  | 'OWNER_BACKFILL'
  | 'SHADOW_MEMBERSHIP'
  | 'SHADOW_RECEIPT_REFILTER'
  | 'SCOPED_INTERNAL_ENABLED';

const STAGE_ORDER: readonly SegmentRolloutStage[] = [
  'DISABLED',
  'OWNER_BACKFILL',
  'SHADOW_MEMBERSHIP',
  'SHADOW_RECEIPT_REFILTER',
  'SCOPED_INTERNAL_ENABLED',
];

export class SegmentRolloutTransitionError extends Error {
  readonly code = 'INVALID_MEMBERSHIP_TRANSITION' as const;

  constructor(
    readonly from: SegmentRolloutStage,
    readonly to: SegmentRolloutStage,
  ) {
    super(`cannot change the rollout stage from ${from} to ${to}`);
    this.name = 'SegmentRolloutTransitionError';
  }
}

export class SegmentRolloutVersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT' as const;

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`rollout state has moved: ${expectedVersion} -> ${actualVersion}`);
    this.name = 'SegmentRolloutVersionConflictError';
  }
}

export interface SegmentRolloutView {
  stage: SegmentRolloutStage;
  mutationFrozen: boolean;
  version: number;
  shadowStartedAt: string | null;
  switchedAt: string | null;
}

export interface ShadowComparisonInput {
  tenantId: string;
  contactId: string;
  segmentId: string;
  membershipRevision: number;
  /** the digest Customer 360 announced with the event */
  expectedDigest: string;
  /** the digest J3 computed itself from the receipts it keeps */
  observedDigest: string;
}

export class JourneySegmentRollout {
  constructor(private readonly database: PrismaClient) {}

  /** no row = never enabled, meaning DISABLED */
  async read(tenantId: string): Promise<SegmentRolloutView> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const row = await transaction.jrSegmentRolloutState.findUnique({
        where: { tenantId },
        select: {
          stage: true,
          mutationFrozen: true,
          version: true,
          shadowStartedAt: true,
          switchedAt: true,
        },
      });
      if (!row) {
        return {
          stage: 'DISABLED' as const,
          mutationFrozen: false,
          version: 0,
          shadowStartedAt: null,
          switchedAt: null,
        };
      }
      return {
        stage: row.stage as SegmentRolloutStage,
        mutationFrozen: row.mutationFrozen,
        version: row.version,
        shadowStartedAt: row.shadowStartedAt?.toISOString() ?? null,
        switchedAt: row.switchedAt?.toISOString() ?? null,
      };
    });
  }

  /**
   * moves the stage forward one step at a time only
   *
   * steps must not be skipped because each exists to observe the result before opening the next; jumping from OWNER_BACKFILL
   * straight to SCOPED_INTERNAL_ENABLED would mean there was never a shadow to see whether the system computes the same as Customer 360,
   * which would make the whole process meaningless
   */
  async advance(input: {
    tenantId: string;
    to: SegmentRolloutStage;
    expectedVersion: number;
    updatedByRef: string;
    evidenceRef?: string;
  }): Promise<SegmentRolloutView> {
    const current = await this.read(input.tenantId);
    const fromRank = STAGE_ORDER.indexOf(current.stage);
    const toRank = STAGE_ORDER.indexOf(input.to);
    if (toRank !== fromRank + 1) {
      throw new SegmentRolloutTransitionError(current.stage, input.to);
    }
    if (current.version !== input.expectedVersion) {
      throw new SegmentRolloutVersionConflictError(input.expectedVersion, current.version);
    }

    const now = new Date();
    const entersShadow = input.to === 'SHADOW_MEMBERSHIP';
    const switches = input.to === 'SCOPED_INTERNAL_ENABLED';

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      if (current.version === 0) {
        const created = await transaction.jrSegmentRolloutState.create({
          data: {
            tenantId: input.tenantId,
            stage: input.to,
            updatedByRef: input.updatedByRef,
            ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
            ...(entersShadow ? { shadowStartedAt: now } : {}),
          },
          select: {
            stage: true,
            mutationFrozen: true,
            version: true,
            shadowStartedAt: true,
            switchedAt: true,
          },
        });
        return this.toView(created);
      }
      const updated = await transaction.jrSegmentRolloutState.update({
        where: { tenantId: input.tenantId },
        data: {
          stage: input.to,
          updatedByRef: input.updatedByRef,
          version: { increment: 1 },
          ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
          ...(entersShadow ? { shadowStartedAt: now } : {}),
          ...(switches ? { switchedAt: now } : {}),
        },
        select: {
          stage: true,
          mutationFrozen: true,
          version: true,
          shadowStartedAt: true,
          switchedAt: true,
        },
      });
      return this.toView(updated);
    });
  }

  /**
   * stops or releases new effects without touching the stage
   *
   * this is the real rollback button: what already happened (receipt, enrollment, audit) stays intact
   * and can be turned back on once the problem is fixed, unlike going back a stage, which cannot and should not be done
   */
  async setFrozen(input: {
    tenantId: string;
    frozen: boolean;
    expectedVersion: number;
    updatedByRef: string;
  }): Promise<SegmentRolloutView> {
    const current = await this.read(input.tenantId);
    if (current.version !== input.expectedVersion) {
      throw new SegmentRolloutVersionConflictError(input.expectedVersion, current.version);
    }
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const updated = await transaction.jrSegmentRolloutState.update({
        where: { tenantId: input.tenantId },
        data: {
          mutationFrozen: input.frozen,
          updatedByRef: input.updatedByRef,
          version: { increment: 1 },
        },
        select: {
          stage: true,
          mutationFrozen: true,
          version: true,
          shadowStartedAt: true,
          switchedAt: true,
        },
      });
      return this.toView(updated);
    });
  }

  /**
   * an enrollment can happen only when fully enabled and not frozen
   *
   * both conditions are combined in one place because if asked separately a caller could forget one of them, and the result of forgetting
   * is an effect that should not happen escaping to a real customer
   */
  async canEmitEffects(tenantId: string): Promise<boolean> {
    const view = await this.read(tenantId);
    return view.stage === 'SCOPED_INTERNAL_ENABLED' && !view.mutationFrozen;
  }

  /**
   * records a mismatch during shadow — keeps only a digest, no attribute values
   *
   * can be repeated without limit because a unique key guards it: shadow goes round many times per the same revision, and
   * recording again every round would bloat the report until it is unreadable and hide new mismatches
   */
  async recordMismatch(
    input: ShadowComparisonInput,
  ): Promise<'RECORDED' | 'MATCHED' | 'DUPLICATE'> {
    if (input.expectedDigest === input.observedDigest) return 'MATCHED';
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const existing = await transaction.jrSegmentShadowMismatch.findUnique({
        where: {
          tenantId_contactId_segmentId_membershipRevision_mismatchKind: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            segmentId: input.segmentId,
            membershipRevision: input.membershipRevision,
            mismatchKind: 'STATE_DIGEST',
          },
        },
        select: { id: true },
      });
      if (existing) return 'DUPLICATE' as const;
      await transaction.jrSegmentShadowMismatch.create({
        data: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          segmentId: input.segmentId,
          membershipRevision: input.membershipRevision,
          mismatchKind: 'STATE_DIGEST',
          expectedDigest: input.expectedDigest,
          observedDigest: input.observedDigest,
        },
      });
      return 'RECORDED' as const;
    });
  }

  private toView(row: {
    stage: string;
    mutationFrozen: boolean;
    version: number;
    shadowStartedAt: Date | null;
    switchedAt: Date | null;
  }): SegmentRolloutView {
    return {
      stage: row.stage as SegmentRolloutStage,
      mutationFrozen: row.mutationFrozen,
      version: row.version,
      shadowStartedAt: row.shadowStartedAt?.toISOString() ?? null,
      switchedAt: row.switchedAt?.toISOString() ?? null,
    };
  }
}
