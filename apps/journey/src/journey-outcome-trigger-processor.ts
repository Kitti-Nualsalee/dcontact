/**
 * J2.7 — the apply phase of the interaction outcome receipt: resolves trusted current
 * contact identity/team scope, matches the published `INTERACTION_OUTCOME` trigger, then
 * creates an enrollment + owner action intent atomically with the receipt transition (#120,#122)
 *
 * Separate from the Kafka consumer (`journey-outcome-consumer.ts`), which only ingests per the J2.3/
 * J2.8 design: claim one, resolve outside the transaction (read-only, no need to hold a DB lock
 * while waiting for Customer 360/IAM to answer), then open a single transaction only when something must be persisted
 * so the enrollment/action/receipt-transition is one atomic unit
 */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  actionKey as toActionKey,
  campaignId as toCampaignId,
  commandId as toCommandId,
  contactId as toContactId,
  enrollmentId as toEnrollmentId,
  interactionId as toInteractionId,
  journeyId as toJourneyId,
  outcomeId as toOutcomeId,
  teamId as toTeamId,
  tenantId as toTenantId,
  withOwnerRequestHash,
  type CustomerIdentityResolver,
  type InteractionOutcomeType,
  type J2OwnerCommandDraftV1,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import type { JourneyActionIntentStep, JourneyVersionSnapshot } from './journey-definition.js';
import {
  matchesOutcomeTrigger,
  type JourneyDefinitionRepository,
} from './journey-definition-repository.js';
import { createJourneyActionKey } from './action-key.js';
import { JourneyOwnerActionRepository } from './journey-owner-action-repository.js';
import { JourneyOutcomeReceiptRepository } from './journey-outcome-receipt-repository.js';

/** The minimum content `journey-outcome-consumer.ts` must persist at ingest — see #120 */
export interface InteractionOutcomeReceiptPayload {
  interactionId: string;
  contactId?: string;
  outcomeCode?: string;
  effectiveAt: string;
}

/**
 * The combined result of one receipt (may fan out to several journeys) — picks the result with the most side effects:
 * ENROLLED > CANCELLED > BLOCKED > UNCHANGED > NO_MATCH
 *
 * - `CANCELLED` — a correction made the existing enrollment no longer match the trigger of its pinned version
 * - `UNCHANGED` — a correction of an outcome already enrolled that still matches as before: no new effect
 */
export type TriggerProcessingOutcome =
  | 'ENROLLED'
  | 'CANCELLED'
  | 'BLOCKED'
  | 'UNCHANGED'
  | 'NO_MATCH'
  | 'REVIEW'
  | 'DEFERRED'
  | undefined;

export interface JourneyOutcomeTriggerProcessorPorts {
  identityResolver: CustomerIdentityResolver<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
}

export interface JourneyOutcomeTriggerProcessorOptions {
  now?: () => Date;
  id?: () => string;
  retryDelayMs?: number;
  leaseSeconds?: number;
}

const ACTION_INTENT_KIND_BY_STEP_TYPE = {
  ENSURE_CASE: 'ENSURE_CASE',
  ADMIT_CAMPAIGN_TARGET: 'ADMIT_CAMPAIGN_TARGET',
  SCHEDULE_CALLBACK: 'SCHEDULE_CALLBACK',
} as const;

const CANCELLABLE_OWNER_ACTION_STATES = new Set(['PENDING', 'DISPATCHED', 'ACK_UNKNOWN']);

const OUTCOME_PRIORITY: readonly Exclude<TriggerProcessingOutcome, undefined>[] = [
  'ENROLLED',
  'CANCELLED',
  'BLOCKED',
  'UNCHANGED',
  'NO_MATCH',
];

type ScopeDecision = 'ALLOW' | 'DENY';

interface StreamEnrollment {
  id: string;
  journeyId: string | null;
  journeyVersion: number;
  state: string;
  runState: string;
  terminalReason: string | null;
}

function buildCommandDraft(
  matched: JourneyVersionSnapshot,
  entryStep: JourneyActionIntentStep,
  enrollmentId: string,
  outcomeType: string,
  outcomeIdValue: string,
  outcomeVersion: number,
  interactionIdValue: string,
  contactIdValue: string,
  now: Date,
): J2OwnerCommandDraftV1 {
  const common = {
    contractVersion: 1 as const,
    commandId: toCommandId(randomUUID()),
    actionKey: toActionKey(
      createJourneyActionKey({
        enrollmentId,
        journeyVersion: matched.version,
        stepId: entryStep.id,
      }),
    ),
    journeyId: toJourneyId(matched.journeyId),
    journeyVersion: matched.version,
    enrollmentId: toEnrollmentId(enrollmentId),
    stepId: entryStep.id,
    sourceOutcome: {
      outcomeType: outcomeType as InteractionOutcomeType,
      outcomeId: toOutcomeId(outcomeIdValue),
      outcomeVersion,
    },
    interactionId: toInteractionId(interactionIdValue),
    contactId: toContactId(contactIdValue),
    sourceOwnerTeamId: toTeamId(matched.ownerTeamId),
    targetOwnerTeamId: toTeamId(entryStep.targetOwnerTeamId),
  };
  if (entryStep.type === 'ENSURE_CASE') {
    return {
      ...common,
      commandType: 'ENSURE_CASE',
      intent: {
        caseTypePolicyRef: entryStep.caseTypeId,
        routingPolicyRef: entryStep.routingIntentRef,
      },
    };
  }
  if (entryStep.type === 'ADMIT_CAMPAIGN_TARGET') {
    return {
      ...common,
      commandType: 'ADMIT_CAMPAIGN_TARGET',
      intent: { campaignId: toCampaignId(entryStep.campaignId) },
    };
  }
  const requestedFor = new Date(now.getTime() + entryStep.requestedInSeconds * 1_000).toISOString();
  return {
    ...common,
    commandType: 'SCHEDULE_CALLBACK',
    intent: {
      requestedFor,
      queueId: entryStep.queueId,
      ...(entryStep.agentId ? { agentId: entryStep.agentId } : {}),
    },
  };
}

export class JourneyOutcomeTriggerProcessor {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly retryDelayMs: number;
  private readonly leaseSeconds: number;
  private readonly receipts: JourneyOutcomeReceiptRepository;
  private readonly actions: JourneyOwnerActionRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly definitions: JourneyDefinitionRepository,
    private readonly ports: JourneyOutcomeTriggerProcessorPorts,
    options: JourneyOutcomeTriggerProcessorOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.retryDelayMs = options.retryDelayMs ?? 30_000;
    this.leaseSeconds = options.leaseSeconds ?? 30;
    this.receipts = new JourneyOutcomeReceiptRepository(database, { id: this.id });
    this.actions = new JourneyOwnerActionRepository(database, { id: this.id });
  }

  /**
   * Processes at most one READY receipt per call; the caller sets the polling loop itself
   *
   * Reads everything outside the transaction first (identity, definitions, the existing enrollment of the logical
   * outcome, scope), then persists all of it in the same transaction as `markApplied` — a crash
   * anywhere leaves no half-done enrollment/action, and retrying the same receipt gives the same result
   */
  async executeNext(tenantId: string, workerId: string): Promise<TriggerProcessingOutcome> {
    const claimed = await this.receipts.claimNextReady(tenantId, workerId, this.leaseSeconds);
    if (!claimed) return undefined;

    const payload = claimed.payload as unknown as InteractionOutcomeReceiptPayload;
    if (!payload.contactId) {
      await this.receipts.markReview(tenantId, claimed.id, 'IDENTITY_UNRESOLVED');
      return 'REVIEW';
    }

    const now = this.now();
    const at = now.toISOString();
    const identity = await this.ports.identityResolver.resolveByContactId({
      tenantId: toTenantId(tenantId),
      contactId: toContactId(payload.contactId),
      at,
    });
    if (identity.status !== 'RESOLVED') {
      await this.receipts.markReview(tenantId, claimed.id, 'IDENTITY_UNRESOLVED');
      return 'REVIEW';
    }

    const [matches, existing] = await Promise.all([
      this.definitions.findPublishedByOutcomeTrigger(
        tenantId,
        claimed.outcomeType,
        payload.outcomeCode,
      ),
      this.streamEnrollments(tenantId, claimed.outcomeType, claimed.outcomeId),
    ]);

    /**
     * a correction is a revision of the existing logical outcome (#123): a journey that already has an enrollment
     * is re-evaluated against the trigger of the version the enrollment pinned — not the latest version —
     * and no new enrollment is created. A PENDING enrollment is one a previous worker
     * (before this atomic path existed) left behind and never decided, so it is decided with the pinned version
     */
    const existingByJourney = new Map(
      existing.flatMap((enrollment) =>
        enrollment.journeyId ? [[enrollment.journeyId, enrollment] as const] : [],
      ),
    );
    const decisions: Array<{ snapshot: JourneyVersionSnapshot; enrollmentId?: string }> = [];
    const withdrawn: StreamEnrollment[] = [];
    let unchanged = 0;
    for (const enrollment of existing) {
      const pinned = enrollment.journeyId
        ? await this.definitions.getVersion(
            tenantId,
            enrollment.journeyId,
            enrollment.journeyVersion,
          )
        : undefined;
      const stillMatches =
        pinned !== undefined &&
        matchesOutcomeTrigger(pinned, claimed.outcomeType, payload.outcomeCode);
      if (!stillMatches) withdrawn.push(enrollment);
      else if (enrollment.state === 'PENDING') {
        decisions.push({ snapshot: pinned, enrollmentId: enrollment.id });
      } else unchanged += 1;
    }
    for (const matched of matches) {
      if (!existingByJourney.has(matched.journeyId)) decisions.push({ snapshot: matched });
    }

    const scopes = await Promise.all(
      decisions.map(({ snapshot }) =>
        this.authorizeWork(tenantId, snapshot, identity.contactId, at),
      ),
    );
    if (scopes.includes('DEFER')) {
      await this.receipts.markRetryableFailure(
        tenantId,
        claimed.id,
        this.retryDelayMs,
        'SCOPE_CONTEXT_STALE',
      );
      return 'DEFERRED';
    }

    const outcomes = new Set<Exclude<TriggerProcessingOutcome, undefined>>();
    if (unchanged > 0) outcomes.add('UNCHANGED');
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`journey-enrollment:${tenantId}:outcome-stream:${claimed.outcomeType}:${claimed.outcomeId}`}))`,
      );
      for (const [index, decision] of decisions.entries()) {
        outcomes.add(
          await this.applyDecision(transaction, {
            tenantId,
            receipt: claimed,
            interactionId: payload.interactionId,
            contactId: identity.contactId,
            snapshot: decision.snapshot,
            ...(decision.enrollmentId ? { enrollmentId: decision.enrollmentId } : {}),
            scope: scopes[index] as ScopeDecision,
            now,
          }),
        );
      }
      for (const enrollment of withdrawn) {
        const changed = await this.withdrawEnrollment(
          transaction,
          tenantId,
          enrollment,
          claimed.correlationId,
        );
        outcomes.add(changed ? 'CANCELLED' : 'UNCHANGED');
      }
      await this.receipts.markApplied(tenantId, claimed.id, transaction);
    });
    return OUTCOME_PRIORITY.find((outcome) => outcomes.has(outcome)) ?? 'NO_MATCH';
  }

  /** every enrollment of the logical outcome `(outcomeType, outcomeId)` regardless of which revision created it */
  private streamEnrollments(
    tenantId: string,
    outcomeType: string,
    outcomeId: string,
  ): Promise<StreamEnrollment[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrEnrollment.findMany({
        where: { tenantId, outcomeReceipt: { tenantId, outcomeType, outcomeId } },
        select: {
          id: true,
          journeyId: true,
          journeyVersion: true,
          state: true,
          runState: true,
          terminalReason: true,
        },
        orderBy: { journeyId: 'asc' },
      }),
    );
  }

  /** the source (the pinned Journey owner) and the target team must both have a current WORK scope (#122) */
  private async authorizeWork(
    tenantId: string,
    snapshot: JourneyVersionSnapshot,
    resolvedContactId: string,
    at: string,
  ): Promise<ScopeDecision | 'DEFER'> {
    const entryStep = this.entryStep(snapshot);
    const decisions = await Promise.all(
      [snapshot.ownerTeamId, entryStep.targetOwnerTeamId].map((teamId) =>
        this.ports.teamContactScopeAuthorizer.authorize({
          tenantId: toTenantId(tenantId),
          teamId: toTeamId(teamId),
          contactId: toContactId(resolvedContactId),
          permission: 'WORK',
          at,
        }),
      ),
    );
    if (decisions.some(({ decision }) => decision === 'DEFER')) return 'DEFER';
    return decisions.some(({ decision }) => decision === 'DENY') ? 'DENY' : 'ALLOW';
  }

  private entryStep(snapshot: JourneyVersionSnapshot): JourneyActionIntentStep {
    return snapshot.graph.steps.find(
      (step) => step.id === snapshot.graph.entryStepId,
    ) as JourneyActionIntentStep;
  }

  /**
   * Creates (or decides a stuck PENDING) enrollment of one journey — a scope denial is a
   * BLOCKED enrollment of Journey itself, not a Governance BLOCK, and has no owner action
   */
  private async applyDecision(
    transaction: Prisma.TransactionClient,
    input: {
      tenantId: string;
      receipt: {
        id: string;
        outcomeType: string;
        outcomeId: string;
        outcomeVersion: number;
        correlationId: string;
      };
      interactionId: string;
      contactId: string;
      snapshot: JourneyVersionSnapshot;
      enrollmentId?: string;
      scope: ScopeDecision;
      now: Date;
    },
  ): Promise<'ENROLLED' | 'BLOCKED' | 'UNCHANGED'> {
    const { tenantId, receipt, snapshot } = input;
    const entryStep = this.entryStep(snapshot);
    const decided =
      input.scope === 'ALLOW'
        ? { state: 'AUTHORIZED' as const, runState: 'WAITING' as const }
        : {
            state: 'BLOCKED' as const,
            runState: 'TERMINAL' as const,
            terminalReason: 'EXIT_RULE' as const,
          };

    let enrollmentId = input.enrollmentId;
    if (enrollmentId) {
      const updated = await transaction.jrEnrollment.updateMany({
        where: { tenantId, id: enrollmentId, state: 'PENDING' },
        data: decided,
      });
      // another worker already decided while we read outside the transaction
      if (updated.count === 0) return 'UNCHANGED';
    } else {
      const raced = await transaction.jrEnrollment.findFirst({
        where: {
          tenantId,
          journeyId: snapshot.journeyId,
          outcomeReceipt: {
            tenantId,
            outcomeType: receipt.outcomeType,
            outcomeId: receipt.outcomeId,
          },
        },
        select: { id: true },
      });
      if (raced) return 'UNCHANGED';
      enrollmentId = this.id();
      await transaction.jrEnrollment.create({
        data: {
          id: enrollmentId,
          tenantId,
          outcomeReceiptId: receipt.id,
          journeyId: snapshot.journeyId,
          journeyVersion: snapshot.version,
          contactId: input.contactId,
          currentStepId: entryStep.id,
          correlationId: receipt.correlationId,
          ...decided,
        },
      });
    }
    if (input.scope === 'DENY') return 'BLOCKED';

    const cursor = await transaction.jrEnrollment.findFirstOrThrow({
      where: { tenantId, id: enrollmentId },
      select: { currentStepId: true, stepSequence: true },
    });
    if (cursor.currentStepId !== entryStep.id) {
      throw new TypeError(
        `owner action entry step ${entryStep.id} does not match the enrollment cursor ${cursor.currentStepId ?? 'null'}`,
      );
    }

    const command = withOwnerRequestHash(
      toTenantId(tenantId),
      buildCommandDraft(
        snapshot,
        entryStep,
        enrollmentId,
        receipt.outcomeType,
        receipt.outcomeId,
        receipt.outcomeVersion,
        input.interactionId,
        input.contactId,
        input.now,
      ),
    );
    await this.actions.ensureAction(
      {
        tenantId,
        actionKey: command.actionKey,
        enrollmentId,
        stepId: entryStep.id,
        stepSequence: cursor.stepSequence,
        outcomeReceiptId: receipt.id,
        kind: ACTION_INTENT_KIND_BY_STEP_TYPE[entryStep.type],
        requestHash: command.requestHash,
        correlationId: receipt.correlationId,
        commandId: command.commandId,
        commandPayload: command,
      },
      transaction,
    );
    return 'ENROLLED';
  }

  /**
   * a correction made the existing enrollment no longer match: request cancelling the still-reversible action
   * (pre-barrier) with the same actionKey and stop the enrollment — an action the owner already accepted
   * (e.g. a committed Case) stays as an owner fact; Journey does not delete or compensate on its own (#123)
   *
   * cancelRequestKey is computed from actionKey so it can replay without telling the owner to cancel twice; an enrollment that is
   * already terminal for another reason is not overwritten (first terminal commit wins)
   */
  private async withdrawEnrollment(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    enrollment: StreamEnrollment,
    correlationId: string,
  ): Promise<boolean> {
    let changed = false;
    const actions = await transaction.jrOwnerAction.findMany({
      where: { tenantId, enrollmentId: enrollment.id },
      select: { actionKey: true, state: true, version: true },
      orderBy: { actionKey: 'asc' },
    });
    for (const action of actions) {
      if (!CANCELLABLE_OWNER_ACTION_STATES.has(action.state)) continue;
      await this.actions.requestCancellation(
        {
          tenantId,
          actionKey: action.actionKey,
          cancelRequestKey: `outcome-correction:${action.actionKey}`,
          reasonCode: 'OUTCOME_CORRECTED',
          correlationId,
          expectedVersion: action.version,
        },
        transaction,
      );
      changed = true;
    }
    const stopped = await transaction.jrEnrollment.updateMany({
      where: { tenantId, id: enrollment.id, terminalReason: null },
      data: { state: 'BLOCKED', runState: 'TERMINAL', terminalReason: 'CANCELLED' },
    });
    return changed || stopped.count > 0;
  }
}
