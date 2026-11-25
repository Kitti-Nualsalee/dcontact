/**
 * J3.7 (#218) — re-evaluates membership after LEFT/CORRECTED/REFILTER_REQUIRED/IDENTITY_INVALIDATED
 *
 * the re-filter job is created when the receipt is applied (J3.6) and waits here to be decided — separate because at apply time
 * we do not yet know the real result, and deciding in a hurry then would be re-filtering with half the data
 *
 * Key principle: decide only from the current canonical fact, not from the event that brought us here — an event only says
 * "something changed", while "what is actually true now" must be asked of Customer 360 anew every time
 *
 * This slice covers the cursor lifecycle and the decision; cancelling work on the owner side (pre-barrier
 * cancel/release versus post-barrier CANCEL_REQUESTED → RECONCILING) is the next slice
 */
import { type Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  contactId as toContactId,
  membershipRevision as toMembershipRevision,
  segmentEntryId as toSegmentEntryId,
  segmentId as toSegmentId,
  teamId as toTeamId,
  tenantId as toTenantId,
  type CustomerSegmentMembershipReader,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import type { JourneyDefinitionRepository } from './journey-definition-repository.js';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneySegmentReceiptRepository } from './journey-segment-receipt-repository.js';

/**
 * states in which owner-side work can still be cancelled — matches `CANCELLABLE_ACTION_STATES` of J2
 * ACKNOWLEDGED is not here because the owner has already created the real entity
 */
const CANCELLABLE_OWNER_ACTION_STATES = new Set(['PENDING', 'DISPATCHED', 'ACK_UNKNOWN']);

export type RefilterOutcome =
  'NO_OP' | 'CANCELLED' | 'DEFERRED' | 'HELD' | 'RECONCILING' | undefined;

export interface JourneySegmentRefilterProcessorPorts {
  membershipReader: CustomerSegmentMembershipReader<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
}

export interface JourneySegmentRefilterProcessorOptions {
  now?: () => Date;
  id?: () => string;
  retryDelayMs?: number;
  leaseSeconds?: number;
}

export class JourneySegmentRefilterProcessor {
  private readonly now: () => Date;
  private readonly retryDelayMs: number;
  private readonly leaseSeconds: number;
  private readonly receipts: JourneySegmentReceiptRepository;
  private readonly actions: JourneyOwnerActionRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly definitions: JourneyDefinitionRepository,
    private readonly ports: JourneySegmentRefilterProcessorPorts,
    options: JourneySegmentRefilterProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.receipts = new JourneySegmentReceiptRepository(database, {
      ...(options.id ? { id: options.id } : {}),
      ...(options.now ? { now: options.now } : {}),
    });
    this.actions = new JourneyOwnerActionRepository(database, {
      ...(options.id ? { id: options.id } : {}),
    });
  }

  /** processes at most one re-filter job per call; the caller sets the polling loop itself */
  async executeNext(tenantId: string, workerId: string): Promise<RefilterOutcome> {
    const cursor = await this.receipts.claimNextRefilter(tenantId, workerId, this.leaseSeconds);
    if (!cursor) return undefined;

    const receipt = cursor.receipt;

    /**
     * IAM invalidation is a canonical authorization fact of the owner team directly, so there is no need to ask
     * Customer 360 again: a membership that is still ELIGIBLE does not bring the team's permission back, and waiting for that read
     * would open a window for the action to continue even though the revoke has committed. This cursor therefore cancels only the
     * intents of scopeTeamId and ends; normal membership refilter work still takes the existing path below.
     */
    if (cursor.scopeTeamId) {
      if (!receipt?.entryId) {
        await this.receipts.holdRefilter(
          tenantId,
          cursor.id,
          'RECONCILING',
          'IAM_SCOPE_RECEIPT_ENTRY_MISSING',
          this.retryDelayMs,
        );
        return 'RECONCILING';
      }
      await this.cancelWork(
        tenantId,
        cursor,
        receipt.entryId,
        'TEAM_SEGMENT_NOT_ALLOWED',
        cursor.scopeTeamId,
      );
      return 'CANCELLED';
    }

    /**
     * merge/split/unmerge make the old stream no longer the truth — must wait for a new canonical fact
     * from Customer 360, not guess where the enrollment should move to. Moving or cloning the enrollment of the
     * predecessor to the survivor is something the stop condition of #218 forbids outright
     */
    if (receipt?.changeKind === 'IDENTITY_INVALIDATED') {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'RECONCILING',
        'IDENTITY_LINEAGE_CONFLICT',
        this.retryDelayMs,
      );
      return 'RECONCILING';
    }

    /**
     * no entryId = we can say only "must re-evaluate" but not which entry to evaluate
     * (a REFILTER_REQUIRED from the identity lineage on the target side) must wait for a fact that points to the entry clearly
     */
    if (!receipt?.entryId) {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'RECONCILING',
        'RECONCILIATION_REQUIRED',
        this.retryDelayMs,
      );
      return 'RECONCILING';
    }

    const at = this.now().toISOString();
    const resolution = await this.ports.membershipReader.resolveEntry({
      tenantId: toTenantId(tenantId),
      contactId: toContactId(cursor.contactId),
      segmentId: toSegmentId(cursor.segmentId),
      entryId: toSegmentEntryId(receipt.entryId),
      membershipRevision: toMembershipRevision(cursor.membershipRevision),
      at,
    });

    if (resolution.status === 'STALE') {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'DEFERRED',
        'MEMBERSHIP_CONTEXT_STALE',
        this.retryDelayMs,
      );
      return 'DEFERRED';
    }
    if (resolution.status === 'AMBIGUOUS' || resolution.status === 'NOT_FOUND') {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'RECONCILING',
        resolution.reasonCode,
        this.retryDelayMs,
      );
      return 'RECONCILING';
    }

    /**
     * no longer eligible = the pending work of this entry must be cancelled
     *
     * the cursor cannot be closed as CANCELLED immediately here before the real owner-side cancellation layer exists — but deciding
     * that "it must be cancelled" belongs to this round, and is a stable fact because it was asked of the canonical
     */
    if (resolution.status !== 'ELIGIBLE') {
      await this.cancelWork(tenantId, cursor, receipt.entryId, 'SEGMENT_ENTRY_NOT_ELIGIBLE');
      return 'CANCELLED';
    }

    /**
     * still in the segment with the same entryId = a correction that does not change membership
     * must not create a new entry or a new enrollment from this cause — a new entry must come with ENTERED only
     */
    if (resolution.entryId !== receipt.entryId) {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'RECONCILING',
        'INVALID_MEMBERSHIP_TRANSITION',
        this.retryDelayMs,
      );
      return 'RECONCILING';
    }

    const matched = await this.definitions.findPublishedBySegmentTrigger(
      tenantId,
      cursor.segmentId,
    );
    if (matched.length === 0) {
      await this.receipts.settleRefilter(tenantId, cursor.id, 'NO_OP', 'NO_MATCHING_JOURNEY');
      return 'NO_OP';
    }

    const scopes = await Promise.all(
      matched.map((definition) =>
        this.ports.teamContactScopeAuthorizer.authorize({
          tenantId: toTenantId(tenantId),
          teamId: toTeamId(definition.ownerTeamId),
          contactId: toContactId(resolution.contactId),
          permission: 'WORK',
          at,
        }),
      ),
    );

    if (scopes.some((scope) => scope.decision === 'DEFER')) {
      await this.receipts.holdRefilter(
        tenantId,
        cursor.id,
        'DEFERRED',
        'SCOPE_CONTEXT_STALE',
        this.retryDelayMs,
      );
      return 'DEFERRED';
    }

    /**
     * scope revoked after enrollment = pending work must be cancelled, not left to continue
     * and must not be recorded as a Governance BLOCK because this is a matter of team permission, not customer contact policy
     */
    if (scopes.every((scope) => scope.decision === 'DENY')) {
      await this.cancelWork(tenantId, cursor, receipt.entryId, 'TEAM_SEGMENT_NOT_ALLOWED');
      return 'CANCELLED';
    }

    // everything stays the same — the correction did not change anything Journey has to do
    await this.receipts.settleRefilter(tenantId, cursor.id, 'NO_OP', 'MEMBERSHIP_UNCHANGED');
    return 'NO_OP';
  }

  /**
   * cancels the pending work of this entry, then closes the cursor
   *
   * split by the barrier that J2 already defined in `CANCELLABLE_ACTION_STATES`:
   *
   * - pre-barrier (PENDING/DISPATCHED/ACK_UNKNOWN) — the owner has not created the real entity, so it can be cancelled
   *   through `requestCancellation`, which queues a cancel command with the action's original binding
   * - post-barrier (ACKNOWLEDGED) — the owner has already created the Case/target, which is their fact
   *   that Journey cannot delete and should not try to (the stop condition of #218 forbids deleting an owner fact)
   *   so it is left alone and recorded as too late
   *
   * cancelRequestKey is computed from actionKey, not random — a restart or replay therefore upserts over the existing one
   * instead of ordering the owner to cancel a second time
   */
  private async cancelWork(
    tenantId: string,
    cursor: { id: string; contactId: string; segmentId: string; scopeTeamId?: string | null },
    entryId: string,
    reasonCode: string,
    scopeTeamId?: string,
  ): Promise<void> {
    const enrollments = await withTenantDatabaseTransaction(
      this.database,
      tenantId,
      async (transaction) => {
        const intents = await transaction.jrSegmentEnrollmentIntent.findMany({
          where: {
            tenantId,
            contactId: cursor.contactId,
            segmentId: cursor.segmentId,
            entryId,
          },
          select: { id: true, journeyId: true, journeyVersion: true },
        });
        if (intents.length === 0) return [];
        const scopedIntentIds = scopeTeamId
          ? (
              await transaction.jrJourneyDefinition.findMany({
                where: { tenantId, ownerTeamId: scopeTeamId },
                select: { journeyId: true, version: true },
              })
            ).reduce((ids, definition) => {
              for (const intent of intents) {
                if (
                  intent.journeyId === definition.journeyId &&
                  intent.journeyVersion === definition.version
                ) {
                  ids.push(intent.id);
                }
              }
              return ids;
            }, [] as string[])
          : intents.map((intent) => intent.id);
        if (scopedIntentIds.length === 0) return [];
        return transaction.jrEnrollment.findMany({
          where: { tenantId, segmentIntentId: { in: scopedIntentIds } },
          select: { id: true, runState: true, terminalReason: true },
        });
      },
    );

    for (const enrollment of enrollments) {
      const actions = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.jrOwnerAction.findMany({
          where: { tenantId, enrollmentId: enrollment.id },
          select: { actionKey: true, state: true, version: true },
        }),
      );

      for (const action of actions) {
        if (!CANCELLABLE_OWNER_ACTION_STATES.has(action.state)) continue;
        await this.actions.requestCancellation({
          tenantId,
          actionKey: action.actionKey,
          cancelRequestKey: `segment-refilter:${action.actionKey}`,
          reasonCode,
          correlationId: `refilter:${cursor.id}`,
          expectedVersion: action.version,
        });
      }

      /**
       * first-terminal-commit-wins: an enrollment that already ended for another reason (goal, exit rule, max age)
       * must not be overwritten as CANCELLED — the reason it ended must be recorded once as the schema requires
       */
      if (enrollment.runState === 'TERMINAL' || enrollment.terminalReason !== null) continue;
      await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
        transaction.jrEnrollment.updateMany({
          where: { tenantId, id: enrollment.id, terminalReason: null },
          data: { state: 'BLOCKED', runState: 'TERMINAL', terminalReason: 'CANCELLED' },
        }),
      );
    }

    await this.receipts.settleRefilter(tenantId, cursor.id, 'CANCELLED', reasonCode);
  }
}
