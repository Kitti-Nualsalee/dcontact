import { randomUUID } from 'node:crypto';
import {
  canonicalSegmentMembershipHash,
  contactId as contractContactId,
  customerSnapshotVersion,
  membershipRevision as contractMembershipRevision,
  segmentDefinitionVersion,
  segmentEntryId,
  segmentEvidenceRef,
  segmentId as contractSegmentId,
  tenantId as contractTenantId,
  validateReadSegmentMembershipChangesInput,
  validateResolveSegmentEntryInput,
  validateSegmentMembershipChangePayload,
  type CustomerSegmentMembershipReader,
  type ReadSegmentMembershipChangesInput,
  type ResolveSegmentEntryInput,
  type SegmentEntryResolution,
  type SegmentMembershipChangePayloadV1,
  type SegmentMembershipChangesRead,
} from '@d-contact/cxa-contracts';
import {
  Prisma,
  type C360IdentityLineage,
  type C360MembershipCommandReceipt,
  type C360SegmentEvaluation as StoredEvaluation,
  type C360SegmentMembershipChange,
  type C360SegmentMembershipHead,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import { stableDigest, validateSegmentDefinitionContent } from './segment-definition.js';
import { C360SegmentEvaluator } from './segment-evaluator.js';

type Transaction = Prisma.TransactionClient;

export type C360MembershipCommitStatus =
  'TRANSITIONED' | 'NO_CHANGE' | 'DUPLICATE_NO_OP' | 'QUARANTINED';

export interface CommitC360MembershipEvaluationInput {
  tenantId: string;
  contactId: string;
  segmentId: string;
  segmentDefinitionVersion: number;
  snapshotVersion: number;
  expectedMembershipRevision: number;
  commandId: string;
  correlationId: string;
  causationId?: string;
}

export interface C360MembershipCommitResult {
  status: C360MembershipCommitStatus;
  contactId: string;
  segmentId: string;
  membershipRevision: number;
  entryId?: string;
  change?: SegmentMembershipChangePayloadV1;
  responseDigest: string;
}

export interface RecordC360IdentityTransitionInput {
  tenantId: string;
  commandId: string;
  operation: 'MERGE' | 'SPLIT' | 'UNMERGE';
  sourceContactId: string;
  targetContactId: string;
  expectedSourceLineageRevision: number;
  correlationId: string;
}

export interface C360IdentityTransitionResult {
  lineageId: string;
  operation: 'MERGE' | 'SPLIT' | 'UNMERGE';
  sourceContactId: string;
  targetContactId: string;
  lineageRevision: number;
  invalidatedChanges: readonly SegmentMembershipChangePayloadV1[];
  stateDigest: string;
}

export interface ResolveC360EvidenceInput {
  tenantId: string;
  evidenceRef: string;
  actorClass: string;
  actorRef: string;
  reasonCode: string;
  correlationId: string;
}

export interface C360EvidenceMetadata {
  evidenceRef: string;
  evidenceDigest: string;
  evaluationId: string;
  contactId: string;
  segmentId: string;
  segmentDefinitionVersion: number;
  snapshotVersion: number;
  outcome: 'MATCH' | 'NO_MATCH' | 'ERROR';
}

export class C360MembershipRepositoryError extends Error {
  constructor(
    readonly code:
      | 'RESOURCE_NOT_FOUND'
      | 'MEMBERSHIP_CONTEXT_STALE'
      | 'IDENTITY_AMBIGUOUS'
      | 'IDENTITY_LINEAGE_CONFLICT'
      | 'EVALUATION_FAILED'
      /**
       * The requested revision range has a gap that supersession cannot explain
       *
       * Deliberately distinct from SUPERSEDED: SUPERSEDED means "we know what swallowed those revisions;
       * reconcile from the head", a promise the caller trusts enough to skip the missing changes.
       * Answering that way without evidence would disguise data loss as a normal event
       */
      | 'MEMBERSHIP_CHANGE_GAP'
      /** The identity closure is held by a fence or changed while locking until retries ran out; can try again */
      | 'RESOURCE_BUSY',
    message: string,
  ) {
    super(message);
    this.name = 'C360MembershipRepositoryError';
  }
}

/** Internal signal: roll back the transaction and retry the whole canonical transition */
class IdentityClosureBusy extends Error {}

const IDENTITY_CLOSURE_ATTEMPTS = 5;

export interface C360MembershipRepositoryOptions {
  id?: () => string;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be a non-empty string`);
  return normalized;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new TypeError(`${field} must be an integer >= 1`);
  }
  return value;
}

function nonNegativeInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${field} must be a non-negative integer`);
  }
  return value;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function payloadFromChange(row: C360SegmentMembershipChange): SegmentMembershipChangePayloadV1 {
  return validateSegmentMembershipChangePayload({
    contractVersion: 1,
    changeKind: row.changeKind,
    contactId: row.contactId,
    segmentId: row.segmentId,
    ...(row.entryId ? { entryId: row.entryId } : {}),
    segmentDefinitionVersion: row.segmentDefinitionVersion,
    membershipRevision: row.membershipRevision,
    snapshotVersion: row.snapshotVersion,
    evaluatedAt: row.evaluatedAt.toISOString(),
    stateDigest: row.stateDigest,
    evidenceRef: row.evidenceRef,
    ...(row.supersedesRevision ? { supersedesRevision: row.supersedesRevision } : {}),
  });
}

function resultDigest(value: Omit<C360MembershipCommitResult, 'responseDigest'>): string {
  return stableDigest(value);
}

/**
 * Durable Customer 360 owner of the membership stream. Every canonical transition, change ledger
 * and outbox row is committed in a single tenant transaction; Journey reads only through the read port below.
 */
export type C360IdentityHeadInitialization =
  | { outcome: 'INITIALIZED' | 'ALREADY_PRESENT'; lineageRevision: number; state: string }
  | { outcome: 'LINEAGE_CONFLICT' };

/**
 * E1 D: initialize the missing identity head of a legacy contact through the owner under the canonical fence
 *
 * the caller must be inside a tenant transaction; this function try-locks the identity exclusively (the same key as
 * the canonical transition) and does not assume "no head" = self-verified: if a lineage already references this contact
 * but the head is missing, treat it as a conflict for human review and do not create an ACTIVE head over the merge history
 * failing to lock = throw C360MembershipRepositoryError('RESOURCE_BUSY')
 */
export async function initializeC360IdentityHead(
  transaction: Transaction,
  tenantId: string,
  contactId: string,
  options: { dryRun?: boolean } = {},
): Promise<C360IdentityHeadInitialization> {
  const [row] = await transaction.$queryRaw<Array<{ locked: boolean }>>(
    Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext(${`c360-membership:${tenantId}:identity:${contactId}`})) AS locked`,
  );
  if (!row?.locked) {
    throw new C360MembershipRepositoryError('RESOURCE_BUSY', 'identity fence is held');
  }
  const existing = await transaction.c360IdentityHead.findUnique({
    where: { tenantId_contactId: { tenantId, contactId } },
  });
  if (existing) {
    return {
      outcome: 'ALREADY_PRESENT',
      lineageRevision: existing.lineageRevision,
      state: existing.state,
    };
  }
  const lineage = await transaction.c360IdentityLineage.count({
    where: { tenantId, OR: [{ sourceContactId: contactId }, { targetContactId: contactId }] },
  });
  if (lineage > 0) return { outcome: 'LINEAGE_CONFLICT' };
  if (!options.dryRun) {
    await transaction.c360IdentityHead.create({
      data: {
        tenantId,
        contactId,
        state: 'ACTIVE',
        canonicalContactId: contactId,
        lineageRevision: 0,
        stateDigest: stableDigest({ tenantId, contactId, state: 'ACTIVE', lineageRevision: 0 }),
      },
    });
  }
  return { outcome: 'INITIALIZED', lineageRevision: 0, state: 'ACTIVE' };
}

export class C360SegmentMembershipRepository implements CustomerSegmentMembershipReader {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    private readonly evaluator: C360SegmentEvaluator,
    options: C360MembershipRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  private async lock(transaction: Transaction, tenantId: string, scope: string): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`c360-membership:${tenantId}:${scope}`}))`,
    );
  }

  private async databaseTime(transaction: Transaction): Promise<Date> {
    const [row] = await transaction.$queryRaw<Array<{ at: Date }>>(
      Prisma.sql`SELECT transaction_timestamp() AS at`,
    );
    if (!row) throw new Error('database transaction timestamp is unavailable');
    return row.at;
  }

  private async ensureIdentityHead(transaction: Transaction, tenantId: string, contactId: string) {
    const existing = await transaction.c360IdentityHead.findUnique({
      where: { tenantId_contactId: { tenantId, contactId } },
    });
    if (existing) return existing;
    const contact = await transaction.contact.findFirst({
      where: { tenantId, id: contactId },
      select: { id: true },
    });
    if (!contact) {
      throw new C360MembershipRepositoryError(
        'RESOURCE_NOT_FOUND',
        'contact not found in the given tenant',
      );
    }
    return transaction.c360IdentityHead.create({
      data: {
        tenantId,
        contactId,
        state: 'ACTIVE',
        canonicalContactId: contactId,
        lineageRevision: 0,
        stateDigest: stableDigest({ tenantId, contactId, state: 'ACTIVE', lineageRevision: 0 }),
      },
    });
  }

  private async evaluate(
    transaction: Transaction,
    binding: {
      tenantId: string;
      contactId: string;
      segmentId: string;
      segmentDefinitionVersion: number;
      snapshotVersion: number;
    },
  ): Promise<StoredEvaluation> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`c360-segment:${binding.tenantId}:evaluation:${binding.contactId}:${binding.segmentId}:${binding.segmentDefinitionVersion}:${binding.snapshotVersion}`}))`,
    );
    const existing = await transaction.c360SegmentEvaluation.findUnique({
      where: {
        tenantId_contactId_segmentId_segmentDefinitionVersion_snapshotVersion: binding,
      },
    });
    if (existing) return existing;

    const [definition, snapshot] = await Promise.all([
      transaction.c360SegmentDefinition.findUnique({
        where: {
          tenantId_segmentId_version: {
            tenantId: binding.tenantId,
            segmentId: binding.segmentId,
            version: binding.segmentDefinitionVersion,
          },
        },
      }),
      transaction.c360FactSnapshot.findUnique({
        where: {
          tenantId_contactId_snapshotVersion: {
            tenantId: binding.tenantId,
            contactId: binding.contactId,
            snapshotVersion: binding.snapshotVersion,
          },
        },
      }),
    ]);
    if (!definition || definition.status === 'DRAFT' || !snapshot) {
      throw new C360MembershipRepositoryError(
        'RESOURCE_NOT_FOUND',
        'published definition or owner snapshot of this binding not found',
      );
    }
    const result = this.evaluator.evaluate({
      ...binding,
      definition: validateSegmentDefinitionContent(definition.definition),
      snapshot: {
        attributes: snapshot.attributes as Record<string, string | number | boolean | null>,
        computed: snapshot.computed as Record<string, string | number | boolean | null>,
        sourceCutoffAt: snapshot.sourceCutoffAt.toISOString(),
      },
    });
    return transaction.c360SegmentEvaluation.create({
      data: {
        id: this.id(),
        ...binding,
        outcome: result.outcome,
        matched: result.outcome === 'ERROR' ? null : result.matched,
        errorCode: result.errorCode,
        inputDigest: result.inputDigest,
        evaluationDigest: result.evaluationDigest,
        evaluatorVersion: result.evaluatorVersion,
      },
    });
  }

  private async ensureEvidence(transaction: Transaction, evaluation: StoredEvaluation) {
    const existing = await transaction.c360SegmentEvidence.findUnique({
      where: {
        tenantId_evaluationId: {
          tenantId: evaluation.tenantId,
          evaluationId: evaluation.id,
        },
      },
    });
    if (existing) return existing;
    const evidenceRef = `evidence:${this.id()}`;
    return transaction.c360SegmentEvidence.create({
      data: {
        id: this.id(),
        tenantId: evaluation.tenantId,
        evidenceRef,
        evaluationId: evaluation.id,
        contactId: evaluation.contactId,
        evidenceDigest: stableDigest({
          tenantId: evaluation.tenantId,
          evaluationId: evaluation.id,
          inputDigest: evaluation.inputDigest,
          evaluationDigest: evaluation.evaluationDigest,
        }),
      },
    });
  }

  private async receiptResult(
    transaction: Transaction,
    receipt: C360MembershipCommandReceipt,
  ): Promise<C360MembershipCommitResult> {
    const change = receipt.changeId
      ? await transaction.c360SegmentMembershipChange.findFirst({
          where: { tenantId: receipt.tenantId, id: receipt.changeId },
        })
      : undefined;
    return {
      status: receipt.status,
      contactId: receipt.contactId,
      segmentId: receipt.segmentId,
      membershipRevision: receipt.membershipRevision,
      ...(receipt.entryId ? { entryId: receipt.entryId } : {}),
      ...(change ? { change: payloadFromChange(change) } : {}),
      responseDigest: receipt.responseDigest,
    };
  }

  private async storeReceipt(
    transaction: Transaction,
    tenantId: string,
    commandId: string,
    requestHash: string,
    result: Omit<C360MembershipCommitResult, 'responseDigest'>,
    changeId?: string,
  ): Promise<C360MembershipCommitResult> {
    const responseDigest = resultDigest(result);
    await transaction.c360MembershipCommandReceipt.create({
      data: {
        id: this.id(),
        tenantId,
        commandId,
        requestHash,
        status: result.status,
        contactId: result.contactId,
        segmentId: result.segmentId,
        membershipRevision: result.membershipRevision,
        changeId,
        entryId: result.entryId,
        responseDigest,
      },
    });
    return { ...result, responseDigest };
  }

  private async quarantine(
    transaction: Transaction,
    input: {
      tenantId: string;
      commandId: string;
      contactId: string;
      segmentId: string;
      attemptedRevision: number;
      attemptedHash: string;
      canonicalHash?: string;
      errorCode: string;
      correlationId: string;
    },
    storeReceipt: boolean,
  ): Promise<C360MembershipCommitResult> {
    const existing = await transaction.c360MembershipQuarantine.findUnique({
      where: {
        tenantId_commandId_attemptedHash: {
          tenantId: input.tenantId,
          commandId: input.commandId,
          attemptedHash: input.attemptedHash,
        },
      },
    });
    if (!existing) {
      await transaction.c360MembershipQuarantine.create({
        data: { id: this.id(), ...input },
      });
    }
    const result = {
      status: 'QUARANTINED' as const,
      contactId: input.contactId,
      segmentId: input.segmentId,
      membershipRevision: input.attemptedRevision,
    };
    if (!storeReceipt) return { ...result, responseDigest: resultDigest(result) };
    return this.storeReceipt(
      transaction,
      input.tenantId,
      input.commandId,
      input.attemptedHash,
      result,
    );
  }

  private async persistTransition(
    transaction: Transaction,
    input: {
      tenantId: string;
      contactId: string;
      segmentId: string;
      correlationId: string;
      causationId?: string;
      commandId: string;
      requestHash: string;
    },
    evaluation: StoredEvaluation,
    evidenceRef: string,
    identityRevision: number,
    current: C360SegmentMembershipHead | null,
    changeKind: 'ENTERED' | 'LEFT' | 'CORRECTED' | 'REFILTER_REQUIRED',
    nextState: 'IN' | 'OUT',
    entryIdValue?: string,
  ): Promise<C360MembershipCommitResult> {
    const revision = (current?.membershipRevision ?? 0) + 1;
    const stateDigest = stableDigest({
      tenantId: input.tenantId,
      contactId: input.contactId,
      segmentId: input.segmentId,
      state: nextState,
      entryId: entryIdValue ?? null,
      segmentDefinitionVersion: evaluation.segmentDefinitionVersion,
      snapshotVersion: evaluation.snapshotVersion,
      evaluationDigest: evaluation.evaluationDigest,
      evaluatedAt: evaluation.evaluatedAt.toISOString(),
      lineageRevision: identityRevision,
      membershipRevision: revision,
    });
    const payload = validateSegmentMembershipChangePayload({
      contractVersion: 1,
      changeKind,
      contactId: input.contactId,
      segmentId: input.segmentId,
      ...(entryIdValue ? { entryId: entryIdValue } : {}),
      segmentDefinitionVersion: evaluation.segmentDefinitionVersion,
      membershipRevision: revision,
      snapshotVersion: evaluation.snapshotVersion,
      evaluatedAt: evaluation.evaluatedAt.toISOString(),
      stateDigest,
      evidenceRef,
      ...(changeKind === 'CORRECTED' || (changeKind === 'LEFT' && revision > 1)
        ? { supersedesRevision: revision - 1 }
        : {}),
    });
    const changeId = this.id();
    const eventId = `event:${this.id()}`;
    const change = await transaction.c360SegmentMembershipChange.create({
      data: {
        id: changeId,
        tenantId: input.tenantId,
        contactId: input.contactId,
        segmentId: input.segmentId,
        membershipRevision: revision,
        changeKind,
        entryId: entryIdValue,
        segmentDefinitionVersion: evaluation.segmentDefinitionVersion,
        snapshotVersion: evaluation.snapshotVersion,
        evaluationId: evaluation.id,
        evaluatedAt: evaluation.evaluatedAt,
        stateDigest,
        evidenceRef,
        supersedesRevision:
          'supersedesRevision' in payload ? payload.supersedesRevision : undefined,
        lineageRevision: identityRevision,
        correlationId: input.correlationId,
        causationId: input.causationId,
      },
    });
    const headData = {
      state: nextState,
      membershipRevision: revision,
      // LEFT references the original entry in the immutable change, but the mutable OUT head must not keep an active entry.
      entryId: nextState === 'IN' ? entryIdValue : null,
      segmentDefinitionVersion: evaluation.segmentDefinitionVersion,
      snapshotVersion: evaluation.snapshotVersion,
      evaluationId: evaluation.id,
      evaluatedAt: evaluation.evaluatedAt,
      stateDigest,
      evidenceRef,
      lineageRevision: identityRevision,
    } as const;
    if (current) {
      await transaction.c360SegmentMembershipHead.update({
        where: {
          tenantId_contactId_segmentId: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            segmentId: input.segmentId,
          },
        },
        data: headData,
      });
    } else {
      await transaction.c360SegmentMembershipHead.create({
        data: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          segmentId: input.segmentId,
          ...headData,
        },
      });
    }
    await transaction.c360SegmentMembershipOutbox.create({
      data: {
        id: this.id(),
        tenantId: input.tenantId,
        changeId,
        eventId,
        contactId: input.contactId,
        segmentId: input.segmentId,
        membershipRevision: revision,
        payload: json(payload),
        payloadHash: canonicalSegmentMembershipHash(contractTenantId(input.tenantId), payload),
        correlationId: input.correlationId,
        causationId: input.causationId,
      },
    });
    const result = {
      status: 'TRANSITIONED' as const,
      contactId: input.contactId,
      segmentId: input.segmentId,
      membershipRevision: revision,
      ...(entryIdValue ? { entryId: entryIdValue } : {}),
      change: payload,
    };
    return this.storeReceipt(
      transaction,
      input.tenantId,
      input.commandId,
      input.requestHash,
      result,
      change.id,
    );
  }

  async commitEvaluation(
    inputValue: CommitC360MembershipEvaluationInput,
  ): Promise<C360MembershipCommitResult> {
    const input = {
      tenantId: nonEmpty(inputValue.tenantId, 'tenantId'),
      contactId: nonEmpty(inputValue.contactId, 'contactId'),
      segmentId: nonEmpty(inputValue.segmentId, 'segmentId'),
      segmentDefinitionVersion: positiveInteger(
        inputValue.segmentDefinitionVersion,
        'segmentDefinitionVersion',
      ),
      snapshotVersion: positiveInteger(inputValue.snapshotVersion, 'snapshotVersion'),
      expectedMembershipRevision: nonNegativeInteger(
        inputValue.expectedMembershipRevision,
        'expectedMembershipRevision',
      ),
      commandId: nonEmpty(inputValue.commandId, 'commandId'),
      correlationId: nonEmpty(inputValue.correlationId, 'correlationId'),
      ...(inputValue.causationId
        ? { causationId: nonEmpty(inputValue.causationId, 'causationId') }
        : {}),
    };
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      contactId: input.contactId,
      segmentId: input.segmentId,
      segmentDefinitionVersion: input.segmentDefinitionVersion,
      snapshotVersion: input.snapshotVersion,
      expectedMembershipRevision: input.expectedMembershipRevision,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      // E1 G: identity fence before stream; the canonical transition holds exclusive, so no commit that reads
      // identity ACTIVE then writes a head over it after the merge has already invalidated it
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock_shared(hashtext(${`c360-membership:${input.tenantId}:identity:${input.contactId}`}))`,
      );
      await this.lock(transaction, input.tenantId, `stream:${input.contactId}:${input.segmentId}`);
      const receipt = await transaction.c360MembershipCommandReceipt.findUnique({
        where: {
          tenantId_commandId: { tenantId: input.tenantId, commandId: input.commandId },
        },
      });
      if (receipt) {
        if (receipt.requestHash === requestHash) return this.receiptResult(transaction, receipt);
        return this.quarantine(
          transaction,
          {
            tenantId: input.tenantId,
            commandId: input.commandId,
            contactId: input.contactId,
            segmentId: input.segmentId,
            attemptedRevision: input.expectedMembershipRevision,
            attemptedHash: requestHash,
            canonicalHash: receipt.requestHash,
            errorCode: 'IDEMPOTENCY_CONFLICT',
            correlationId: input.correlationId,
          },
          false,
        );
      }

      const identity = await this.ensureIdentityHead(transaction, input.tenantId, input.contactId);
      if (identity.state !== 'ACTIVE' || identity.canonicalContactId !== input.contactId) {
        return this.quarantine(
          transaction,
          {
            tenantId: input.tenantId,
            commandId: input.commandId,
            contactId: input.contactId,
            segmentId: input.segmentId,
            attemptedRevision: input.expectedMembershipRevision,
            attemptedHash: requestHash,
            errorCode:
              identity.state === 'AMBIGUOUS' ? 'IDENTITY_AMBIGUOUS' : 'IDENTITY_LINEAGE_CONFLICT',
            correlationId: input.correlationId,
          },
          true,
        );
      }

      const binding = {
        tenantId: input.tenantId,
        contactId: input.contactId,
        segmentId: input.segmentId,
        segmentDefinitionVersion: input.segmentDefinitionVersion,
        snapshotVersion: input.snapshotVersion,
      };
      const evaluation = await this.evaluate(transaction, binding);
      const evidence = await this.ensureEvidence(transaction, evaluation);
      const current = await transaction.c360SegmentMembershipHead.findUnique({
        where: {
          tenantId_contactId_segmentId: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            segmentId: input.segmentId,
          },
        },
      });

      const exactResult =
        current?.evaluationId === evaluation.id &&
        ((evaluation.outcome === 'MATCH' && current.state === 'IN') ||
          (evaluation.outcome === 'NO_MATCH' && current.state === 'OUT'));
      if (exactResult) {
        const change = current.membershipRevision
          ? await transaction.c360SegmentMembershipChange.findUnique({
              where: {
                tenantId_contactId_segmentId_membershipRevision: {
                  tenantId: input.tenantId,
                  contactId: input.contactId,
                  segmentId: input.segmentId,
                  membershipRevision: current.membershipRevision,
                },
              },
            })
          : undefined;
        return this.storeReceipt(
          transaction,
          input.tenantId,
          input.commandId,
          requestHash,
          {
            status: 'DUPLICATE_NO_OP',
            contactId: input.contactId,
            segmentId: input.segmentId,
            membershipRevision: current.membershipRevision,
            ...(current.entryId ? { entryId: current.entryId } : {}),
            ...(change ? { change: payloadFromChange(change) } : {}),
          },
          change?.id,
        );
      }

      const currentRevision = current?.membershipRevision ?? 0;
      if (currentRevision !== input.expectedMembershipRevision) {
        return this.quarantine(
          transaction,
          {
            tenantId: input.tenantId,
            commandId: input.commandId,
            contactId: input.contactId,
            segmentId: input.segmentId,
            attemptedRevision: input.expectedMembershipRevision,
            attemptedHash: requestHash,
            canonicalHash: current?.stateDigest,
            errorCode: 'MEMBERSHIP_REVISION_CONFLICT',
            correlationId: input.correlationId,
          },
          true,
        );
      }
      if (evaluation.outcome === 'ERROR') {
        return this.quarantine(
          transaction,
          {
            tenantId: input.tenantId,
            commandId: input.commandId,
            contactId: input.contactId,
            segmentId: input.segmentId,
            attemptedRevision: input.expectedMembershipRevision,
            attemptedHash: requestHash,
            canonicalHash: current?.stateDigest,
            errorCode: evaluation.errorCode ?? 'MEMBERSHIP_CONTEXT_STALE',
            correlationId: input.correlationId,
          },
          true,
        );
      }

      if (evaluation.outcome === 'NO_MATCH' && (!current || current.state === 'OUT')) {
        const stateDigest = stableDigest({
          ...binding,
          state: 'OUT',
          evaluationDigest: evaluation.evaluationDigest,
          evaluatedAt: evaluation.evaluatedAt.toISOString(),
          lineageRevision: identity.lineageRevision,
          membershipRevision: currentRevision,
        });
        const headData = {
          state: 'OUT' as const,
          membershipRevision: currentRevision,
          entryId: null,
          segmentDefinitionVersion: evaluation.segmentDefinitionVersion,
          snapshotVersion: evaluation.snapshotVersion,
          evaluationId: evaluation.id,
          evaluatedAt: evaluation.evaluatedAt,
          stateDigest,
          evidenceRef: evidence.evidenceRef,
          lineageRevision: identity.lineageRevision,
        };
        if (current) {
          await transaction.c360SegmentMembershipHead.update({
            where: {
              tenantId_contactId_segmentId: {
                tenantId: input.tenantId,
                contactId: input.contactId,
                segmentId: input.segmentId,
              },
            },
            data: headData,
          });
        } else {
          await transaction.c360SegmentMembershipHead.create({
            data: {
              tenantId: input.tenantId,
              contactId: input.contactId,
              segmentId: input.segmentId,
              ...headData,
            },
          });
        }
        return this.storeReceipt(transaction, input.tenantId, input.commandId, requestHash, {
          status: 'NO_CHANGE',
          contactId: input.contactId,
          segmentId: input.segmentId,
          membershipRevision: currentRevision,
        });
      }

      if (evaluation.outcome === 'MATCH') {
        const entering = !current || current.state !== 'IN';
        const entryIdValue = entering ? `entry:${this.id()}` : (current.entryId ?? undefined);
        return this.persistTransition(
          transaction,
          { ...input, requestHash },
          evaluation,
          evidence.evidenceRef,
          identity.lineageRevision,
          current,
          entering ? 'ENTERED' : 'CORRECTED',
          'IN',
          entryIdValue,
        );
      }

      if (current?.state === 'IN') {
        return this.persistTransition(
          transaction,
          { ...input, requestHash },
          evaluation,
          evidence.evidenceRef,
          identity.lineageRevision,
          current,
          'LEFT',
          'OUT',
          current.entryId ?? undefined,
        );
      }
      return this.persistTransition(
        transaction,
        { ...input, requestHash },
        evaluation,
        evidence.evidenceRef,
        identity.lineageRevision,
        current,
        'REFILTER_REQUIRED',
        'OUT',
      );
    });
  }

  private async persistIdentityInvalidation(
    transaction: Transaction,
    head: C360SegmentMembershipHead,
    kind: 'REFILTER_REQUIRED' | 'IDENTITY_INVALIDATED',
    lineageRevision: number,
    correlationId: string,
    causationId: string,
  ): Promise<SegmentMembershipChangePayloadV1> {
    const revision = head.membershipRevision + 1;
    const nextState = kind === 'IDENTITY_INVALIDATED' ? 'INVALIDATED' : head.state;
    const stateDigest = stableDigest({
      tenantId: head.tenantId,
      contactId: head.contactId,
      segmentId: head.segmentId,
      state: nextState,
      entryId: head.entryId,
      segmentDefinitionVersion: head.segmentDefinitionVersion,
      snapshotVersion: head.snapshotVersion,
      evaluationId: head.evaluationId,
      membershipRevision: revision,
      lineageRevision,
      changeKind: kind,
    });
    const payload = validateSegmentMembershipChangePayload({
      contractVersion: 1,
      changeKind: kind,
      contactId: head.contactId,
      segmentId: head.segmentId,
      ...(head.entryId ? { entryId: head.entryId } : {}),
      segmentDefinitionVersion: head.segmentDefinitionVersion,
      membershipRevision: revision,
      snapshotVersion: head.snapshotVersion,
      evaluatedAt: head.evaluatedAt.toISOString(),
      stateDigest,
      evidenceRef: head.evidenceRef,
      ...(head.membershipRevision > 0 ? { supersedesRevision: head.membershipRevision } : {}),
    });
    const changeId = this.id();
    await transaction.c360SegmentMembershipChange.create({
      data: {
        id: changeId,
        tenantId: head.tenantId,
        contactId: head.contactId,
        segmentId: head.segmentId,
        membershipRevision: revision,
        changeKind: kind,
        entryId: head.entryId,
        segmentDefinitionVersion: head.segmentDefinitionVersion,
        snapshotVersion: head.snapshotVersion,
        evaluationId: head.evaluationId,
        evaluatedAt: head.evaluatedAt,
        stateDigest,
        evidenceRef: head.evidenceRef,
        supersedesRevision: head.membershipRevision > 0 ? head.membershipRevision : undefined,
        lineageRevision,
        correlationId,
        causationId,
      },
    });
    await transaction.c360SegmentMembershipHead.update({
      where: {
        tenantId_contactId_segmentId: {
          tenantId: head.tenantId,
          contactId: head.contactId,
          segmentId: head.segmentId,
        },
      },
      data: {
        state: nextState,
        membershipRevision: revision,
        stateDigest,
        lineageRevision,
      },
    });
    await transaction.c360SegmentMembershipOutbox.create({
      data: {
        id: this.id(),
        tenantId: head.tenantId,
        changeId,
        eventId: `event:${this.id()}`,
        contactId: head.contactId,
        segmentId: head.segmentId,
        membershipRevision: revision,
        payload: json(payload),
        payloadHash: canonicalSegmentMembershipHash(contractTenantId(head.tenantId), payload),
        correlationId,
        causationId,
      },
    });
    return payload;
  }

  async recordIdentityTransition(
    inputValue: RecordC360IdentityTransitionInput,
  ): Promise<C360IdentityTransitionResult> {
    const input = {
      tenantId: nonEmpty(inputValue.tenantId, 'tenantId'),
      commandId: nonEmpty(inputValue.commandId, 'commandId'),
      operation: inputValue.operation,
      sourceContactId: nonEmpty(inputValue.sourceContactId, 'sourceContactId'),
      targetContactId: nonEmpty(inputValue.targetContactId, 'targetContactId'),
      expectedSourceLineageRevision: nonNegativeInteger(
        inputValue.expectedSourceLineageRevision,
        'expectedSourceLineageRevision',
      ),
      correlationId: nonEmpty(inputValue.correlationId, 'correlationId'),
    };
    if (!['MERGE', 'SPLIT', 'UNMERGE'].includes(input.operation)) {
      throw new TypeError('operation is not supported');
    }
    if (input.sourceContactId === input.targetContactId) {
      throw new TypeError('sourceContactId and targetContactId must differ');
    }
    const requestHash = stableDigest(input);

    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.applyIdentityTransition(input, requestHash);
      } catch (error) {
        if (!(error instanceof IdentityClosureBusy)) throw error;
        if (attempt >= IDENTITY_CLOSURE_ATTEMPTS - 1) {
          throw new C360MembershipRepositoryError(
            'RESOURCE_BUSY',
            'the identity closure was locked or changed during the transition; try again',
          );
        }
        await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60));
      }
    }
  }

  /**
   * E1 G: read the closure → try identity locks on every affected contact in ID order → read the closure again
   * if the closure changed or someone holds a fence, roll back and retry; then lock the streams in order before writing
   *
   * closure = source, target and the contacts MERGED under the anchor (descendants that can really be repointed)
   * uses try so it does not wait on Cus360/membership holding a shared fence and does not create a wait in reverse order
   */
  private async identityClosure(
    transaction: Transaction,
    input: {
      tenantId: string;
      operation: string;
      sourceContactId: string;
      targetContactId: string;
    },
  ): Promise<string[]> {
    const anchor = input.operation === 'MERGE' ? input.sourceContactId : input.targetContactId;
    const descendants = await transaction.c360IdentityHead.findMany({
      where: { tenantId: input.tenantId, canonicalContactId: anchor, state: 'MERGED' },
      select: { contactId: true },
    });
    return [
      ...new Set([
        input.sourceContactId,
        input.targetContactId,
        ...descendants.map((head) => head.contactId),
      ]),
    ].sort();
  }

  private async applyIdentityTransition(
    input: {
      tenantId: string;
      commandId: string;
      operation: 'MERGE' | 'SPLIT' | 'UNMERGE';
      sourceContactId: string;
      targetContactId: string;
      expectedSourceLineageRevision: number;
      correlationId: string;
    },
    requestHash: string,
  ): Promise<C360IdentityTransitionResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const closure = await this.identityClosure(transaction, input);
      for (const contact of closure) {
        const [row] = await transaction.$queryRaw<Array<{ locked: boolean }>>(
          Prisma.sql`SELECT pg_try_advisory_xact_lock(hashtext(${`c360-membership:${input.tenantId}:identity:${contact}`})) AS locked`,
        );
        if (!row?.locked) throw new IdentityClosureBusy();
      }
      const locked = new Set(closure);
      if ((await this.identityClosure(transaction, input)).some((id) => !locked.has(id))) {
        throw new IdentityClosureBusy();
      }
      const streams = await transaction.c360SegmentMembershipHead.findMany({
        where: { tenantId: input.tenantId, contactId: { in: closure } },
        select: { contactId: true, segmentId: true },
        orderBy: [{ contactId: 'asc' }, { segmentId: 'asc' }],
      });
      for (const stream of streams) {
        await this.lock(
          transaction,
          input.tenantId,
          `stream:${stream.contactId}:${stream.segmentId}`,
        );
      }
      const existing = await transaction.c360IdentityLineage.findUnique({
        where: { tenantId_commandId: { tenantId: input.tenantId, commandId: input.commandId } },
      });
      if (existing) {
        if (existing.requestHash !== requestHash) {
          throw new C360MembershipRepositoryError(
            'IDENTITY_LINEAGE_CONFLICT',
            'the same commandId has a different identity transition hash',
          );
        }
        return this.identityTransitionResult(transaction, existing);
      }
      const [source, target] = await Promise.all([
        this.ensureIdentityHead(transaction, input.tenantId, input.sourceContactId),
        this.ensureIdentityHead(transaction, input.tenantId, input.targetContactId),
      ]);
      if (source.lineageRevision !== input.expectedSourceLineageRevision) {
        throw new C360MembershipRepositoryError(
          'IDENTITY_LINEAGE_CONFLICT',
          `expected lineage ${input.expectedSourceLineageRevision} but current is ${source.lineageRevision}`,
        );
      }
      if (input.operation === 'MERGE' && (source.state !== 'ACTIVE' || target.state !== 'ACTIVE')) {
        throw new C360MembershipRepositoryError(
          'IDENTITY_LINEAGE_CONFLICT',
          'MERGE accepts only a source/target that is an ACTIVE canonical contact',
        );
      }

      /**
       * SPLIT/UNMERGE "reverses" a merge that happened, so a real merge edge must exist to reverse
       *
       * previously nothing was checked, which allowed creating a lineage between two contacts that were never merged
       * with the result that the ledger recorded history that never happened and the membership of unrelated
       * contacts was re-evaluated for no reason
       *
       * Two-layer proof: the head must say the source is currently merged into the target, and there must be
       * a lineage row for the MERGE of this pair in the ledger
       */
      if (input.operation === 'SPLIT' || input.operation === 'UNMERGE') {
        if (source.state !== 'MERGED' || source.canonicalContactId !== input.targetContactId) {
          throw new C360MembershipRepositoryError(
            'IDENTITY_LINEAGE_CONFLICT',
            `${input.operation} must reverse a merge that is still in effect, but ${input.sourceContactId} was not merged into ${input.targetContactId}`,
          );
        }
        const mergeEdge = await transaction.c360IdentityLineage.findFirst({
          where: {
            tenantId: input.tenantId,
            operation: 'MERGE',
            sourceContactId: input.sourceContactId,
            targetContactId: input.targetContactId,
          },
          orderBy: { lineageRevision: 'desc' },
        });
        if (!mergeEdge) {
          throw new C360MembershipRepositoryError(
            'IDENTITY_LINEAGE_CONFLICT',
            `merge edge not found for ${input.sourceContactId} -> ${input.targetContactId} that ${input.operation} would reverse`,
          );
        }
      }
      const occurredAt = await this.databaseTime(transaction);
      const sourceRevision = source.lineageRevision + 1;
      const nextSourceState = input.operation === 'MERGE' ? 'MERGED' : 'ACTIVE';
      const canonicalContactId =
        input.operation === 'MERGE' ? input.targetContactId : input.sourceContactId;
      const stateDigest = stableDigest({
        tenantId: input.tenantId,
        operation: input.operation,
        sourceContactId: input.sourceContactId,
        targetContactId: input.targetContactId,
        lineageRevision: sourceRevision,
        occurredAt: occurredAt.toISOString(),
      });
      const lineage = await transaction.c360IdentityLineage.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          commandId: input.commandId,
          operation: input.operation,
          sourceContactId: input.sourceContactId,
          targetContactId: input.targetContactId,
          lineageRevision: sourceRevision,
          requestHash,
          stateDigest,
          correlationId: input.correlationId,
          occurredAt,
        },
      });
      await transaction.c360IdentityHead.update({
        where: {
          tenantId_contactId: { tenantId: input.tenantId, contactId: input.sourceContactId },
        },
        data: {
          state: nextSourceState,
          canonicalContactId,
          lineageRevision: sourceRevision,
          stateDigest,
        },
      });
      let targetRevision = target.lineageRevision;
      if (input.operation !== 'MERGE') {
        targetRevision += 1;
        await transaction.c360IdentityHead.update({
          where: {
            tenantId_contactId: { tenantId: input.tenantId, contactId: input.targetContactId },
          },
          data: {
            state: 'ACTIVE',
            canonicalContactId: input.targetContactId,
            lineageRevision: targetRevision,
            stateDigest: stableDigest({
              tenantId: input.tenantId,
              contactId: input.targetContactId,
              state: 'ACTIVE',
              lineageRevision: targetRevision,
              cause: input.commandId,
            }),
          },
        });
      }

      const repointed = await this.repointMergeChain(transaction, input);

      const affected: Array<{
        contactId: string;
        kind: 'REFILTER_REQUIRED' | 'IDENTITY_INVALIDATED';
        revision: number;
      }> = [
        {
          contactId: input.sourceContactId,
          kind: 'IDENTITY_INVALIDATED',
          revision: sourceRevision,
        },
        {
          contactId: input.targetContactId,
          kind: input.operation === 'MERGE' ? 'REFILTER_REQUIRED' : 'IDENTITY_INVALIDATED',
          revision: targetRevision,
        },
        ...repointed.map((entry) => ({
          contactId: entry.contactId,
          kind: 'IDENTITY_INVALIDATED' as const,
          revision: entry.revision,
        })),
      ];
      const invalidatedChanges: SegmentMembershipChangePayloadV1[] = [];
      for (const affectedContact of affected.sort((left, right) =>
        left.contactId < right.contactId ? -1 : left.contactId > right.contactId ? 1 : 0,
      )) {
        const heads = await transaction.c360SegmentMembershipHead.findMany({
          where: { tenantId: input.tenantId, contactId: affectedContact.contactId },
          orderBy: { segmentId: 'asc' },
        });
        const revision = affectedContact.revision;
        for (const head of heads) {
          invalidatedChanges.push(
            await this.persistIdentityInvalidation(
              transaction,
              head,
              affectedContact.kind,
              revision,
              input.correlationId,
              input.commandId,
            ),
          );
        }
      }
      return {
        lineageId: lineage.id,
        operation: lineage.operation,
        sourceContactId: lineage.sourceContactId,
        targetContactId: lineage.targetContactId,
        lineageRevision: lineage.lineageRevision,
        invalidatedChanges,
        stateDigest: lineage.stateDigest,
      };
    });
  }

  /**
   * Moves the canonical of contacts merged under the contact whose state is changing
   *
   * canonicalContactId is a single-level pointer; no resolver in this system walks a chain.
   * If A is merged into B and then B is merged into C without moving A along, A's pointer is left pointing
   * at B, which is no longer canonical. The owner guard of commitEvaluation reads this pointer directly
   * (identity.canonicalContactId !== input.contactId), so it decides the owner from a dead contact, and
   * A's membership is never told that the owner changed hands
   *
   * The reverse leg must be symmetric: when SPLIT/UNMERGE pulls the source out of the target, the ones that must follow back are those that
   * "followed the source in" only, not everyone under the target — tell these two groups apart by the latest merge edge
   * of each contact in the ledger, because the head keeps only the current destination and not how it got there
   */
  private async repointMergeChain(
    transaction: Transaction,
    input: {
      tenantId: string;
      commandId: string;
      operation: 'MERGE' | 'SPLIT' | 'UNMERGE';
      sourceContactId: string;
      targetContactId: string;
    },
  ): Promise<Array<{ contactId: string; revision: number }>> {
    const isMerge = input.operation === 'MERGE';
    const anchor = isMerge ? input.sourceContactId : input.targetContactId;
    const nextCanonical = isMerge ? input.targetContactId : input.sourceContactId;
    const candidates = await transaction.c360IdentityHead.findMany({
      where: {
        tenantId: input.tenantId,
        canonicalContactId: anchor,
        contactId: { notIn: [input.sourceContactId, input.targetContactId] },
        state: 'MERGED',
      },
      orderBy: { contactId: 'asc' },
    });
    let moving = candidates;
    if (!isMerge && candidates.length > 0) {
      const edges = await transaction.c360IdentityLineage.findMany({
        where: {
          tenantId: input.tenantId,
          operation: 'MERGE',
          sourceContactId: { in: candidates.map((head) => head.contactId) },
        },
        orderBy: { lineageRevision: 'desc' },
        select: { sourceContactId: true, targetContactId: true },
      });
      const latestEdge = new Map<string, string>();
      for (const edge of edges) {
        if (!latestEdge.has(edge.sourceContactId)) {
          latestEdge.set(edge.sourceContactId, edge.targetContactId);
        }
      }
      moving = candidates.filter(
        (head) => latestEdge.get(head.contactId) === input.sourceContactId,
      );
    }

    const repointed: Array<{ contactId: string; revision: number }> = [];
    for (const head of moving) {
      const revision = head.lineageRevision + 1;
      await transaction.c360IdentityHead.update({
        where: {
          tenantId_contactId: { tenantId: input.tenantId, contactId: head.contactId },
        },
        data: {
          canonicalContactId: nextCanonical,
          lineageRevision: revision,
          stateDigest: stableDigest({
            tenantId: input.tenantId,
            contactId: head.contactId,
            state: 'MERGED',
            canonicalContactId: nextCanonical,
            lineageRevision: revision,
            cause: input.commandId,
          }),
        },
      });
      repointed.push({ contactId: head.contactId, revision });
    }
    return repointed;
  }

  private async identityTransitionResult(
    transaction: Transaction,
    lineage: C360IdentityLineage,
  ): Promise<C360IdentityTransitionResult> {
    const changes = await transaction.c360SegmentMembershipChange.findMany({
      where: { tenantId: lineage.tenantId, causationId: lineage.commandId },
      orderBy: [{ contactId: 'asc' }, { segmentId: 'asc' }, { membershipRevision: 'asc' }],
    });
    return {
      lineageId: lineage.id,
      operation: lineage.operation,
      sourceContactId: lineage.sourceContactId,
      targetContactId: lineage.targetContactId,
      lineageRevision: lineage.lineageRevision,
      invalidatedChanges: changes.map(payloadFromChange),
      stateDigest: lineage.stateDigest,
    };
  }

  async resolveEntry(inputValue: ResolveSegmentEntryInput): Promise<SegmentEntryResolution> {
    const input = validateResolveSegmentEntryInput(inputValue);
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const identity = await transaction.c360IdentityHead.findUnique({
        where: { tenantId_contactId: { tenantId: input.tenantId, contactId: input.contactId } },
      });
      if (identity?.state === 'AMBIGUOUS') {
        return { status: 'AMBIGUOUS', reasonCode: 'IDENTITY_AMBIGUOUS' };
      }
      if (identity?.state === 'MERGED') {
        return { status: 'NOT_ELIGIBLE', reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE' };
      }
      const [head, change] = await Promise.all([
        transaction.c360SegmentMembershipHead.findUnique({
          where: {
            tenantId_contactId_segmentId: {
              tenantId: input.tenantId,
              contactId: input.contactId,
              segmentId: input.segmentId,
            },
          },
        }),
        transaction.c360SegmentMembershipChange.findUnique({
          where: {
            tenantId_contactId_segmentId_membershipRevision: {
              tenantId: input.tenantId,
              contactId: input.contactId,
              segmentId: input.segmentId,
              membershipRevision: input.membershipRevision,
            },
          },
        }),
      ]);
      if (!head || !change || change.entryId !== input.entryId) {
        return { status: 'NOT_FOUND', reasonCode: 'RESOURCE_NOT_FOUND' };
      }
      if (new Date(input.at).getTime() < change.evaluatedAt.getTime()) {
        return { status: 'STALE', reasonCode: 'MEMBERSHIP_CONTEXT_STALE' };
      }
      if (
        head.state !== 'IN' ||
        head.entryId !== input.entryId ||
        head.membershipRevision !== input.membershipRevision
      ) {
        return head.membershipRevision > input.membershipRevision
          ? { status: 'STALE', reasonCode: 'MEMBERSHIP_CONTEXT_STALE' }
          : { status: 'NOT_ELIGIBLE', reasonCode: 'SEGMENT_ENTRY_NOT_ELIGIBLE' };
      }
      return {
        status: 'ELIGIBLE',
        contactId: contractContactId(head.contactId),
        segmentId: contractSegmentId(head.segmentId),
        entryId: segmentEntryId(head.entryId),
        segmentDefinitionVersion: segmentDefinitionVersion(head.segmentDefinitionVersion),
        membershipRevision: contractMembershipRevision(head.membershipRevision),
        snapshotVersion: customerSnapshotVersion(head.snapshotVersion),
        evaluatedAt: head.evaluatedAt.toISOString(),
        stateDigest: head.stateDigest,
        evidenceRef: segmentEvidenceRef(head.evidenceRef),
      };
    });
  }

  async readChanges(
    inputValue: ReadSegmentMembershipChangesInput,
  ): Promise<SegmentMembershipChangesRead> {
    const input = validateReadSegmentMembershipChangesInput(inputValue);
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const identity = await transaction.c360IdentityHead.findUnique({
        where: { tenantId_contactId: { tenantId: input.tenantId, contactId: input.contactId } },
      });
      if (identity?.state === 'AMBIGUOUS') {
        return { status: 'AMBIGUOUS', reasonCode: 'IDENTITY_AMBIGUOUS' };
      }
      const head = await transaction.c360SegmentMembershipHead.findUnique({
        where: {
          tenantId_contactId_segmentId: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            segmentId: input.segmentId,
          },
        },
      });
      if (!head) return { status: 'NOT_FOUND', reasonCode: 'RESOURCE_NOT_FOUND' };
      if (input.throughRevision > head.membershipRevision) {
        return { status: 'STALE', reasonCode: 'MEMBERSHIP_CONTEXT_STALE' };
      }
      const rows = await transaction.c360SegmentMembershipChange.findMany({
        where: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          segmentId: input.segmentId,
          membershipRevision: { gt: input.afterRevision, lte: input.throughRevision },
        },
        orderBy: { membershipRevision: 'asc' },
      });
      const expectedCount = input.throughRevision - input.afterRevision;
      const contiguous =
        rows.length === expectedCount &&
        rows.every((row, index) => row.membershipRevision === input.afterRevision + index + 1);
      if (contiguous) {
        return { status: 'CHANGES', changes: rows.map(payloadFromChange) };
      }

      // not contiguous does not yet mean SUPERSEDED — first prove that a later change exists that
      // really declares it swallowed the missing revision (supersedesRevision); otherwise that gap is data
      // loss of unknown cause, and answering SUPERSEDED would let the caller skip it comfortably
      const missing: number[] = [];
      const present = new Set(rows.map((row) => row.membershipRevision));
      for (
        let revision = input.afterRevision + 1;
        revision <= input.throughRevision;
        revision += 1
      ) {
        if (!present.has(revision)) missing.push(revision);
      }

      const supersedingRows = await transaction.c360SegmentMembershipChange.findMany({
        where: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          segmentId: input.segmentId,
          supersedesRevision: { not: null },
          membershipRevision: { gt: input.afterRevision },
        },
        select: { membershipRevision: true, supersedesRevision: true },
      });

      // a change swallows its own range [supersedesRevision, membershipRevision]
      const explained = (revision: number) =>
        supersedingRows.some(
          (row) =>
            row.supersedesRevision !== null &&
            revision >= row.supersedesRevision &&
            revision <= row.membershipRevision,
        );

      const unexplained = missing.filter((revision) => !explained(revision));
      if (unexplained.length > 0) {
        throw new C360MembershipRepositoryError(
          'MEMBERSHIP_CHANGE_GAP',
          `membership change revision ${unexplained.join(', ')} is missing without any supersession explaining it`,
        );
      }

      return {
        status: 'SUPERSEDED',
        currentRevision: contractMembershipRevision(head.membershipRevision),
        stateDigest: head.stateDigest,
        evidenceRef: segmentEvidenceRef(head.evidenceRef),
        reasonCode: 'RECONCILIATION_REQUIRED',
      };
    });
  }

  async resolveEvidence(inputValue: ResolveC360EvidenceInput): Promise<C360EvidenceMetadata> {
    const input = {
      tenantId: nonEmpty(inputValue.tenantId, 'tenantId'),
      evidenceRef: nonEmpty(inputValue.evidenceRef, 'evidenceRef'),
      actorClass: nonEmpty(inputValue.actorClass, 'actorClass'),
      actorRef: nonEmpty(inputValue.actorRef, 'actorRef'),
      reasonCode: nonEmpty(inputValue.reasonCode, 'reasonCode'),
      correlationId: nonEmpty(inputValue.correlationId, 'correlationId'),
    };
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const evidence = await transaction.c360SegmentEvidence.findUnique({
        where: {
          tenantId_evidenceRef: {
            tenantId: input.tenantId,
            evidenceRef: input.evidenceRef,
          },
        },
        include: { evaluation: true },
      });
      if (!evidence) {
        throw new C360MembershipRepositoryError(
          'RESOURCE_NOT_FOUND',
          'evidence not found in tenant',
        );
      }
      await transaction.c360EvidenceAccessAudit.create({
        data: { id: this.id(), ...input },
      });
      return {
        evidenceRef: evidence.evidenceRef,
        evidenceDigest: evidence.evidenceDigest,
        evaluationId: evidence.evaluationId,
        contactId: evidence.contactId,
        segmentId: evidence.evaluation.segmentId,
        segmentDefinitionVersion: evidence.evaluation.segmentDefinitionVersion,
        snapshotVersion: evidence.evaluation.snapshotVersion,
        outcome: evidence.evaluation.outcome,
      };
    });
  }
}
