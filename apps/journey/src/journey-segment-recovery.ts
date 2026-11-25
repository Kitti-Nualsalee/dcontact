/**
 * J3.8 (#219) — audited recovery of the segment membership stream
 *
 * Three rules enforced on every operation in this file:
 *
 * 1. **No replacement payload is accepted** — the operator can send only `targetRef` + `reasonCode` + `evidenceRef`
 *    and everything else uses what was already committed. Allowing edits to content during recovery would open a way to
 *    forge a membership fact through the forensic channel
 * 2. **`expectedVersion` must match** — prevents a blind retry that overwrites state which moved on while the
 *    operator was looking at the screen
 * 3. **audit first, always** — records actor/reason/target in `jr_recovery_audit` in the same transaction
 *    as the state change, not written later on a best-effort basis
 */
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

export class SegmentRecoveryNotFoundError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND' as const;

  constructor(readonly targetRef: string) {
    super(`recovery target not found: ${targetRef}`);
    this.name = 'SegmentRecoveryNotFoundError';
  }
}

export class SegmentRecoveryVersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT' as const;

  constructor(
    readonly targetRef: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`version of ${targetRef} has moved: ${expectedVersion} -> ${actualVersion}`);
    this.name = 'SegmentRecoveryVersionConflictError';
  }
}

export class SegmentRecoveryNotAllowedError extends Error {
  readonly code = 'RECOVERY_NOT_ALLOWED' as const;

  constructor(
    readonly targetRef: string,
    readonly state: string,
  ) {
    super(`state ${state} of ${targetRef} does not allow this kind of recovery`);
    this.name = 'SegmentRecoveryNotAllowedError';
  }
}

export interface SegmentRecoveryInput {
  tenantId: string;
  /** the existing opaque reference — the receipt eventId or the cursor id, not a newly created value */
  targetRef: string;
  expectedVersion: number;
  reasonCode: string;
  actorId: string;
  evidenceRef?: string;
}

export interface SegmentRecoveryResult {
  targetRef: string;
  state: string;
  version: number;
}

/**
 * REPLAY returns a receipt to the queue only from states stuck because a person decided, not from a finished state
 *
 * APPLIED means the effect already happened, so a replay would create the effect again, while IGNORED_SUPERSEDED
 * means something newer swallowed it, and waking it up would be walking the head back, which is strictly forbidden
 */
const REPLAYABLE_RECEIPT_STATES = new Set(['REVIEW', 'QUARANTINED']);

/** only things that are really quarantined may be skipped — skipping something never attempted is silently dropping work */
const SKIPPABLE_RECEIPT_STATES = new Set(['QUARANTINED', 'REVIEW']);

/** a finished cursor (NO_OP/CANCELLED) cannot be revived — the stop condition forbids reviving cancelled work */
const REVALIDATABLE_CURSOR_STATES = new Set([
  'PENDING',
  'REVALIDATING',
  'DEFERRED',
  'HELD',
  'RECONCILING',
]);

export class JourneySegmentRecovery {
  constructor(private readonly database: PrismaClient) {}

  /**
   * returns a stuck receipt to the queue with everything in its identity unchanged
   *
   * does not touch eventId, membershipRevision, entryId or payloadHash at all — only the state
   * and the time it is ready to run change, so the owner can dedupe as before and no new fact can arise
   */
  async replayReceipt(input: SegmentRecoveryInput): Promise<SegmentRecoveryResult> {
    return this.mutateReceipt(input, 'REPLAY', REPLAYABLE_RECEIPT_STATES, {
      state: 'READY',
      availableAt: new Date(),
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /** closes a permanently broken receipt, accepting that it will not be processed — a reason must always be attached */
  async skipQuarantine(input: SegmentRecoveryInput): Promise<SegmentRecoveryResult> {
    return this.mutateReceipt(input, 'SKIP_QUARANTINE', SKIPPABLE_RECEIPT_STATES, {
      state: 'IGNORED_SUPERSEDED',
      leaseOwner: null,
      leaseExpiresAt: null,
    });
  }

  /** orders a re-filter job to re-evaluate immediately instead of waiting for backoff */
  async revalidateRefilter(input: SegmentRecoveryInput): Promise<SegmentRecoveryResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const cursor = await transaction.jrSegmentRefilterCursor.findFirst({
        where: { tenantId: input.tenantId, id: input.targetRef },
        select: { id: true, state: true, version: true },
      });
      if (!cursor) throw new SegmentRecoveryNotFoundError(input.targetRef);
      if (cursor.version !== input.expectedVersion) {
        throw new SegmentRecoveryVersionConflictError(
          input.targetRef,
          input.expectedVersion,
          cursor.version,
        );
      }
      if (!REVALIDATABLE_CURSOR_STATES.has(cursor.state)) {
        throw new SegmentRecoveryNotAllowedError(input.targetRef, cursor.state);
      }

      const updated = await transaction.jrSegmentRefilterCursor.update({
        where: { id: cursor.id },
        data: {
          state: 'PENDING',
          availableAt: new Date(),
          leaseOwner: null,
          leaseExpiresAt: null,
          version: { increment: 1 },
        },
        select: { state: true, version: true },
      });
      await this.audit(transaction, input, 'REVALIDATE', 'SEGMENT_REFILTER');
      return { targetRef: input.targetRef, state: updated.state, version: updated.version };
    });
  }

  private async mutateReceipt(
    input: SegmentRecoveryInput,
    operation: 'REPLAY' | 'SKIP_QUARANTINE',
    allowedStates: ReadonlySet<string>,
    data: Record<string, unknown>,
  ): Promise<SegmentRecoveryResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      /**
       * look up by eventId, not the row id — the operator sees the eventId from the forensic view and from logs
       * while the row id is an internal detail that should not need to be known to order a recovery
       */
      const receipt = await transaction.jrSegmentReceipt.findFirst({
        where: { tenantId: input.tenantId, eventId: input.targetRef },
        select: { id: true, state: true, version: true },
      });
      if (!receipt) throw new SegmentRecoveryNotFoundError(input.targetRef);
      if (receipt.version !== input.expectedVersion) {
        throw new SegmentRecoveryVersionConflictError(
          input.targetRef,
          input.expectedVersion,
          receipt.version,
        );
      }
      if (!allowedStates.has(receipt.state)) {
        throw new SegmentRecoveryNotAllowedError(input.targetRef, receipt.state);
      }

      const updated = await transaction.jrSegmentReceipt.update({
        where: { id: receipt.id },
        data: { ...data, version: { increment: 1 } },
        select: { state: true, version: true },
      });
      await this.audit(transaction, input, operation, 'SEGMENT_RECEIPT');
      return { targetRef: input.targetRef, state: updated.state, version: updated.version };
    });
  }

  private async audit(
    transaction: Parameters<Parameters<typeof withTenantDatabaseTransaction>[2]>[0],
    input: SegmentRecoveryInput,
    operation: 'REPLAY' | 'SKIP_QUARANTINE' | 'REVALIDATE',
    targetKind: 'SEGMENT_RECEIPT' | 'SEGMENT_REFILTER',
  ): Promise<void> {
    await transaction.jrRecoveryAudit.create({
      data: {
        tenantId: input.tenantId,
        operation,
        targetKind,
        targetRef: input.targetRef,
        reasonCode: input.reasonCode,
        actorId: input.actorId,
        ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
      },
    });
  }
}
