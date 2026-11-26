/**
 * J2.8 — reconcile a Journey-owned action against the real owner's canonical
 * result via `queryAction` (pull model, per J2.1's `J2OwnerPort`), then apply
 * it through `JourneyOwnerActionRepository.applyResult` (J2.3) — idempotent,
 * terminal-precedence-respecting. This never writes owner state directly;
 * the owner remains the sole author of its own canonical result.
 */
import { createHash } from 'node:crypto';
import type { PrismaClient } from '@d-contact/db';
import {
  actionKey as toActionKey,
  tenantId as toTenantId,
  type J2CaseOwnerPort,
  type J2DialerOwnerPort,
  type J2OwnerResultPayloadV1,
  type J2OwnerResultStatus,
} from '@d-contact/cxa-contracts';
import {
  JourneyOwnerActionRepository,
  OwnerActionNotFoundError,
  type ApplyOwnerResultOutcome,
} from './journey-owner-action-repository.js';

export type ReconcileOutcome = ApplyOwnerResultOutcome | 'NO_RESULT_YET';

/** the real J2OwnerResultStatus has more kinds than JrOwnerResultKind can tell apart — every success kind
 * (CREATED/LINKED/REOPENED/ADMITTED/ALREADY_ADMITTED/SCHEDULED/ALREADY_SCHEDULED)
 * collapses into the single ACKNOWLEDGED because Journey cares only that "the owner accepted", not the owner's
 * internal details */
export const STATUS_TO_RESULT_KIND: Record<
  J2OwnerResultStatus,
  'ACKNOWLEDGED' | 'REJECTED' | 'CANCELLED' | 'SUPERSEDED' | 'TOO_LATE'
> = {
  CREATED: 'ACKNOWLEDGED',
  LINKED: 'ACKNOWLEDGED',
  REOPENED: 'ACKNOWLEDGED',
  ADMITTED: 'ACKNOWLEDGED',
  ALREADY_ADMITTED: 'ACKNOWLEDGED',
  SCHEDULED: 'ACKNOWLEDGED',
  ALREADY_SCHEDULED: 'ACKNOWLEDGED',
  CANCELLED: 'CANCELLED',
  SUPERSEDED: 'SUPERSEDED',
  TOO_LATE: 'TOO_LATE',
  REJECTED: 'REJECTED',
};

/** hash of the result content itself (not the requestHash of the original command) to detect a conflict for
 * a result repeated under the same commandId but with different content */
/**
 * exported so the result consumer (push path) uses the same one as the reconciler (pull path)
 * — the same result arriving by two routes must get the same resultHash, otherwise applyResult would see
 * a CONFLICT even though it is the same result
 */
export function hashResult(result: J2OwnerResultPayloadV1): string {
  const canonical = JSON.stringify({
    status: result.status,
    code: result.code,
    category: result.category,
    reasonCode: result.reasonCode,
    ownerAggregate: result.ownerAggregate ?? null,
  });
  return createHash('sha256').update(canonical).digest('hex');
}

export class JourneyOwnerResultReconciler {
  private readonly actions: JourneyOwnerActionRepository;

  constructor(
    database: PrismaClient,
    private readonly casePort: J2CaseOwnerPort,
    private readonly dialerPort: J2DialerOwnerPort,
  ) {
    this.actions = new JourneyOwnerActionRepository(database);
  }

  /**
   * queries the owner with the original actionKey/requestHash and applies the result if there is one — always safe
   * to call again (idempotent); no result coming back is not an error, just still waiting (ACK_UNKNOWN
   * escalation is the caller's own decision, not made here)
   */
  async reconcile(
    tenantId: string,
    actionKey: string,
    /**
     * the requestHash of the command to ask about — the default is the original command of the action, while cancel/
     * supersede use the same actionKey but their own hash, so the owner separates the two receipts by this value
     */
    requestHash?: string,
  ): Promise<ReconcileOutcome> {
    const action = await this.actions.getAction(tenantId, actionKey);
    if (!action) throw new OwnerActionNotFoundError(actionKey);

    const port = action.kind === 'ENSURE_CASE' ? this.casePort : this.dialerPort;
    const result = await port.queryAction(toTenantId(tenantId), {
      contractVersion: 1,
      actionKey: toActionKey(actionKey),
      requestHash: requestHash ?? action.requestHash,
    });
    if (!result) return 'NO_RESULT_YET';

    const applied = await this.actions.applyResult({
      tenantId,
      commandId: result.commandId,
      actionKey,
      resultKind: STATUS_TO_RESULT_KIND[result.status],
      resultHash: hashResult(result),
      correlationId: result.commandId,
      ...(result.ownerAggregate ? { ownerAggregateRef: result.ownerAggregate.id } : {}),
      ...(result.ownerAggregate ? { ownerAggregateVersion: result.ownerAggregate.version } : {}),
    });
    return applied.outcome;
  }
}
