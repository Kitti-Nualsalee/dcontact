import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type Cg4ExceptionStatus,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import {
  CG4_EVENT_TYPES,
  CG4_EVALUATOR_VERSION,
  CG4_POLICY_SCHEMA_VERSION,
  CG4_RULE_REGISTRY_VERSION,
  resolveCg4ExceptionQuorum,
  type Cg4AuthorizationSubject,
  type Cg4ExceptionEffectiveState,
  type Cg4QuorumEvaluation,
  type Cg4RecordedApproval,
  type Cg4TransitionKind,
} from '@d-contact/cxa-contracts';
import {
  Cg3IdempotencyConflictError,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
  stableDigest,
} from './cg3-persistence.js';
import {
  assertCg4QuorumMet,
  assertCg4RequestAuthorization,
  evaluateCg4Quorum,
  resolveCg4RequiredExceptionCapability,
  Cg4SelfApprovalError,
} from './cg4-authorization-engine.js';
import { resolveCg4EffectiveState } from './cg4-exception-evaluation.js';

/**
 * CG4.4 (#187): workflow transitions for an Approved exception series.
 *
 * `Cg4ExceptionHead.status` is the single authority for workflow state — `cg_exception`
 * rows are insert-only, so a transition moves the head rather than rewriting history.
 * EXPIRED is never persisted: it is derived from database time at evaluation, which is
 * what keeps the expiry scheduler out of the correctness path (#177 §2).
 */

export class Cg4InvalidLifecycleTransitionError extends Error {
  readonly code = 'INVALID_LIFECYCLE_TRANSITION';

  constructor(
    readonly from: Cg4ExceptionStatus,
    readonly to: Cg4ExceptionStatus,
  ) {
    super(`เปลี่ยนสถานะ exception จาก ${from} ไป ${to} ไม่ได้`);
    this.name = 'Cg4InvalidLifecycleTransitionError';
  }
}

export class Cg4ExceptionScopeConflictError extends Error {
  readonly code = 'EXCEPTION_SCOPE_CONFLICT';

  constructor(readonly conflictingExceptionId: string) {
    super(`scope และช่วงเวลาทับกับ exception ${conflictingExceptionId} ที่ยัง active/scheduled`);
    this.name = 'Cg4ExceptionScopeConflictError';
  }
}

export type Cg4ExceptionTransitionAction = 'APPROVE' | 'REJECT' | 'CANCEL' | 'REVOKE';

const TRANSITIONS: Readonly<
  Record<
    Cg4ExceptionTransitionAction,
    { from: Cg4ExceptionStatus; to: Cg4ExceptionStatus; kind: Cg4TransitionKind }
  >
> = Object.freeze({
  APPROVE: { from: 'PENDING', to: 'APPROVED', kind: 'EXCEPTION_APPROVED' },
  REJECT: { from: 'PENDING', to: 'REJECTED', kind: 'EXCEPTION_REJECTED' },
  CANCEL: { from: 'PENDING', to: 'CANCELLED', kind: 'EXCEPTION_CANCELLED' },
  REVOKE: { from: 'APPROVED', to: 'REVOKED', kind: 'EXCEPTION_REVOKED' },
});

/** REJECTED/CANCELLED/REVOKED are terminal — a series never reopens (#177 §2). */
export function resolveCg4TransitionTarget(
  action: Cg4ExceptionTransitionAction,
  from: Cg4ExceptionStatus,
): { to: Cg4ExceptionStatus; kind: Cg4TransitionKind } {
  const transition = TRANSITIONS[action];
  if (transition.from !== from) {
    throw new Cg4InvalidLifecycleTransitionError(from, transition.to);
  }
  return { to: transition.to, kind: transition.kind };
}

interface OverlapCandidate {
  exceptionId: string;
  identityId: string | null;
  channel: string;
  purpose: string;
  sourceType: string;
  sourceId: string;
  allowedRuleCodes: readonly string[];
  startsAt: Date;
  expiresAt: Date;
}

/**
 * Two exceptions conflict when they bind the same exact scope, share at least one rule
 * code, and their effective windows intersect. Half-open windows: touching endpoints do
 * not overlap, matching the exclusive `expiresAt` boundary used at evaluation.
 */
export function cg4ExceptionsOverlap(left: OverlapCandidate, right: OverlapCandidate): boolean {
  const sameScope =
    left.identityId === right.identityId &&
    left.channel === right.channel &&
    left.purpose === right.purpose &&
    left.sourceType === right.sourceType &&
    left.sourceId === right.sourceId;
  if (!sameScope) return false;
  const sharesRule = left.allowedRuleCodes.some((code) => right.allowedRuleCodes.includes(code));
  if (!sharesRule) return false;
  return (
    left.startsAt.getTime() < right.expiresAt.getTime() &&
    right.startsAt.getTime() < left.expiresAt.getTime()
  );
}

function capabilityFor(
  action: Cg4ExceptionTransitionAction,
  tier: 'STANDARD' | 'HIGH' | 'EMERGENCY',
) {
  switch (action) {
    case 'APPROVE':
    case 'REJECT':
      return resolveCg4RequiredExceptionCapability(tier);
    case 'CANCEL':
      return 'cg.exception.amend' as const;
    case 'REVOKE':
      return 'cg.exception.revoke' as const;
  }
}

export interface TransitionCg4ExceptionInput {
  tenantId: string;
  exceptionId: string;
  expectedRevision: number;
  expectedContentDigest: string;
  action: Cg4ExceptionTransitionAction;
  reasonCode: string;
  evidenceRef: string;
  /** Freshly resolved by the caller from the IAM port at this command boundary. */
  actor: Cg4AuthorizationSubject;
  scopeKey: string;
  occurredAt: string;
  expectedVersion: number;
  idempotencyKey: string;
}

export interface Cg4ExceptionTransitionResult {
  mutationId: string;
  eventId: string;
  aggregateVersion: number;
  exceptionId: string;
  revision: number;
  workflowState: Cg4ExceptionStatus;
  effectiveState: Cg4ExceptionEffectiveState;
  quorum?: Cg4QuorumEvaluation;
}

export interface Cg4ExceptionLifecycleRepositoryOptions {
  id?: () => string;
  now?: () => Date;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
  return normalized;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class Cg4ExceptionLifecycleRepository {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    options: Cg4ExceptionLifecycleRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async transition(input: TransitionCg4ExceptionInput): Promise<Cg4ExceptionTransitionResult> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.exceptionId, 'exceptionId');
    nonEmpty(input.reasonCode, 'reasonCode');
    nonEmpty(input.evidenceRef, 'evidenceRef');
    nonEmpty(input.scopeKey, 'scopeKey');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    const occurredAt = new Date(input.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new TypeError('occurredAt ต้องเป็น ISO-8601 timestamp');
    }

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      exceptionId: input.exceptionId,
      expectedRevision: input.expectedRevision,
      expectedContentDigest: input.expectedContentDigest,
      action: input.action,
      reasonCode: input.reasonCode,
      evidenceRef: input.evidenceRef,
      actorSubjectId: input.actor.subjectId,
      authorizationEpoch: input.actor.authorizationEpoch,
      scopeVersion: input.actor.scopeVersion,
      scopeKey: input.scopeKey,
      expectedVersion: input.expectedVersion,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation: 'CG4_EXCEPTION_TRANSITION',
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          throw new Cg3IdempotencyConflictError(input.idempotencyKey);
        }
        return receipt.responseBody as unknown as Cg4ExceptionTransitionResult;
      }

      const head = await transaction.cg4ExceptionHead.findUnique({
        where: {
          tenantId_exceptionId: { tenantId: input.tenantId, exceptionId: input.exceptionId },
        },
      });
      if (!head) throw new Cg3ResourceNotFoundError();
      if (head.currentRevision !== input.expectedRevision) {
        throw new Cg3VersionConflictError(input.expectedRevision, head.currentRevision);
      }
      const revision = await transaction.cg4Exception.findFirst({
        where: { tenantId: input.tenantId, id: head.currentRevisionId },
      });
      if (!revision) throw new Cg3ResourceNotFoundError();
      if (revision.requestHash !== input.expectedContentDigest) {
        throw new Cg3VersionConflictError(input.expectedRevision, head.currentRevision);
      }

      // Serialize against concurrent transitions and against authorize-time reads of the
      // same contact's exceptions: the evaluator takes this same lock.
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg4-contact:${input.tenantId}:${revision.contactId}`}))`,
      );

      const { to, kind } = resolveCg4TransitionTarget(input.action, head.status);

      assertCg4RequestAuthorization({
        subject: input.actor,
        capability: capabilityFor(input.action, revision.tier),
        scopeKey: input.scopeKey,
        now: this.now(),
      });
      // Only the maker may cancel their own pending request (#173 §1).
      if (input.action === 'CANCEL' && revision.actorRef !== input.actor.subjectId) {
        throw new Cg3ResourceNotFoundError();
      }
      // A checker deciding a request must never be its maker, even when the quorum was
      // already recorded — this is the finalization boundary, so it is checked again.
      if (
        (input.action === 'APPROVE' || input.action === 'REJECT') &&
        revision.actorRef === input.actor.subjectId
      ) {
        throw new Cg4SelfApprovalError();
      }

      let quorum: Cg4QuorumEvaluation | undefined;
      if (input.action === 'APPROVE') {
        const approvalRows = await transaction.cg4ExceptionApproval.findMany({
          where: {
            tenantId: input.tenantId,
            exceptionId: input.exceptionId,
            exceptionRevision: input.expectedRevision,
          },
        });
        const approvals: Cg4RecordedApproval[] = approvalRows
          .filter((row) => row.decision === 'APPROVED')
          .map((row) => ({
            checkerSubjectId: row.approverRef as Cg4RecordedApproval['checkerSubjectId'],
            capability: row.capability as Cg4RecordedApproval['capability'],
            directComplianceAuthority: row.directCompliance,
            emergencyAuthority: row.emergencyAuthority,
            source: row.capabilitySource as Cg4RecordedApproval['source'],
            authorizationEpoch: row.authorizationEpoch,
            scopeVersion: row.scopeVersion,
            decidedAt: row.decidedAt.toISOString(),
          }));
        quorum = evaluateCg4Quorum(
          resolveCg4ExceptionQuorum(revision.tier),
          approvals,
          approvalRows.some((row) => row.decision === 'REJECTED'),
          this.now(),
        );
        assertCg4QuorumMet(quorum);

        // Overlap is checked at approval, under the contact lock, so two exceptions can
        // never both become active over the same scope+rule+window (#177 §5).
        const candidates = await transaction.cg4Exception.findMany({
          where: {
            tenantId: input.tenantId,
            contactId: revision.contactId,
            exceptionId: { not: input.exceptionId },
            expiresAt: { gt: revision.startsAt },
            startsAt: { lt: revision.expiresAt },
          },
        });
        const activeHeads = await transaction.cg4ExceptionHead.findMany({
          where: {
            tenantId: input.tenantId,
            exceptionId: { in: [...new Set(candidates.map((row) => row.exceptionId))] },
            status: 'APPROVED',
          },
        });
        const activeRevisionIds = new Set(activeHeads.map((entry) => entry.currentRevisionId));
        const conflict = candidates
          .filter((candidate) => activeRevisionIds.has(candidate.id))
          .find((candidate) => cg4ExceptionsOverlap(revision, candidate));
        if (conflict) throw new Cg4ExceptionScopeConflictError(conflict.exceptionId);
      }

      const contactHead = await transaction.cg4ContactExceptionHead.findUnique({
        where: { tenantId_contactId: { tenantId: input.tenantId, contactId: revision.contactId } },
      });
      const actualVersion = contactHead?.aggregateVersion ?? 0;
      if (actualVersion !== input.expectedVersion) {
        throw new Cg3VersionConflictError(input.expectedVersion, actualVersion);
      }

      const updatedHead = await transaction.cg4ExceptionHead.updateMany({
        where: {
          tenantId: input.tenantId,
          exceptionId: input.exceptionId,
          currentRevision: input.expectedRevision,
          status: head.status,
        },
        data: { status: to },
      });
      if (updatedHead.count !== 1) {
        throw new Cg3VersionConflictError(input.expectedRevision, head.currentRevision);
      }

      const mutationId = this.id();
      const aggregateVersion = actualVersion + 1;
      const afterDigest = stableDigest({
        previous: contactHead?.currentDigest ?? null,
        exceptionId: input.exceptionId,
        revision: input.expectedRevision,
        contentDigest: revision.requestHash,
        workflowState: to,
      });
      if (contactHead) {
        const updated = await transaction.cg4ContactExceptionHead.updateMany({
          where: {
            tenantId: input.tenantId,
            contactId: revision.contactId,
            aggregateVersion: input.expectedVersion,
          },
          data: { aggregateVersion, currentDigest: afterDigest, latestMutationId: mutationId },
        });
        if (updated.count !== 1) {
          throw new Cg3VersionConflictError(input.expectedVersion, actualVersion);
        }
      } else {
        await transaction.cg4ContactExceptionHead.create({
          data: {
            tenantId: input.tenantId,
            contactId: revision.contactId,
            aggregateVersion,
            currentDigest: afterDigest,
            latestMutationId: mutationId,
          },
        });
      }

      const effectiveState: Cg4ExceptionEffectiveState =
        to === 'APPROVED'
          ? resolveCg4EffectiveState({
              workflowState: 'APPROVED',
              startsAt: revision.startsAt,
              expiresAt: revision.expiresAt,
              now: this.now(),
            })
          : 'INACTIVE';

      const eventId = this.id();
      const payload = {
        contractVersion: 1,
        mutationId,
        transitionKind: kind,
        subjectId: input.exceptionId,
        subjectVersion: input.expectedRevision,
        state: to,
        effectiveAt: occurredAt.toISOString(),
        affectedScope: {
          scopeKey: input.scopeKey,
          channel: revision.channel,
          purpose: revision.purpose,
          sourceType: revision.sourceType,
        },
        scopeDigest: stableDigest({
          contactId: revision.contactId,
          identityId: revision.identityId,
          channel: revision.channel,
          purpose: revision.purpose,
          sourceType: revision.sourceType,
          sourceId: revision.sourceId,
        }),
        policyVersion: revision.policyVersion,
        policyContentDigest: revision.policyContentDigest,
        exceptionVersion: input.expectedRevision,
        ruleRegistryVersion: CG4_RULE_REGISTRY_VERSION,
        policySchemaVersion: CG4_POLICY_SCHEMA_VERSION,
        evaluatorVersion: CG4_EVALUATOR_VERSION,
        stateDigest: afterDigest,
        // Approving relaxes what the contact is protected by; every other transition
        // tightens it. Consumers use this to decide re-authorization vs. no-op.
        restrictiveness: to === 'APPROVED' ? 'RELAXATION' : 'TIGHTENING',
      };
      await transaction.cgEventOutbox.create({
        data: {
          id: eventId,
          mutationId,
          tenantId: input.tenantId,
          aggregateType: 'CONTACT',
          aggregateId: revision.contactId,
          aggregateVersion,
          eventType: CG4_EVENT_TYPES.EXCEPTION_CHANGED,
          orderingKey: `${input.tenantId}:${revision.contactId}`,
          payload: json(payload),
          payloadHash: stableDigest(payload),
        },
      });
      await transaction.cgAuditLog.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          mutationId,
          aggregateType: 'CONTACT',
          aggregateId: revision.contactId,
          aggregateVersion,
          action: `CG4_EXCEPTION_${input.action}`,
          actorClass: 'COMPLIANCE',
          actorRef: input.actor.subjectId,
          sourceKind: 'COMPLIANCE',
          evidenceRef: input.evidenceRef,
          beforeDigest: contactHead?.currentDigest,
          afterDigest,
          occurredAt,
        },
      });

      const result: Cg4ExceptionTransitionResult = {
        mutationId,
        eventId,
        aggregateVersion,
        exceptionId: input.exceptionId,
        revision: input.expectedRevision,
        workflowState: to,
        effectiveState,
        ...(quorum ? { quorum } : {}),
      };
      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: 'CG4_EXCEPTION_TRANSITION',
          idempotencyKey: input.idempotencyKey,
          requestHash,
          expectedVersion: input.expectedVersion,
          aggregateVersion,
          responseStatus: 200,
          responseBody: result as unknown as object,
        },
      });
      return result;
    });
  }
}
