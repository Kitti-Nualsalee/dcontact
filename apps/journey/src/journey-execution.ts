/**
 * Owner: Journey — durable execution of J1 (C1.5)
 *
 * C1.5 scope: enrollment lifecycle, Schedule/Event ingress dedupe, WAIT wake-up,
 * cancellation/goal/exit/max-age and restart safety only
 * **No** Governance, Delivery or provider traffic — a `SEND` node stops at
 * `AWAITING_SEND` to hand over to C1.6 to assemble, not for this code to call itself
 *
 * Rules this code must keep:
 *   1. `(enrollment_id, step_sequence)` is unique — of two workers that claim the same job
 *      only one's step run insert succeeds; the other learns from the unique violation, not from a read
 *   2. the first terminal always wins and is rechecked in the same transaction that runs the node
 *      — a cancel/goal/exit/max-age that came earlier therefore cuts in for sure
 *   3. emitted evidence has only opaque ids, step ids and enums — no payload or PII
 */
import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrRunState,
  type JrTerminalReason,
  type PrismaClient,
  withTenantDatabaseTransaction,
  lockTeamReferences,
} from '@d-contact/db';
import type { ExpressionContext, ExpressionEvaluator } from '@d-contact/cxa-contracts';
import { lifecycleAcceptsNewEnrollments } from './journey-authoring-model.js';
import { planJourneyStep } from './journey-transition-planner.js';
import type {
  JourneyGraph,
  JourneyGraphStep,
  JourneyVersionSnapshot,
} from './journey-definition.js';

export interface JourneyDefinitionSource {
  getVersion(
    tenantId: string,
    journeyId: string,
    version: number,
  ): Promise<JourneyVersionSnapshot | undefined>;
}

export interface JourneyExecutionOptions {
  now?: () => Date;
  id?: () => string;
  /** worker lease per claim; once expired another worker can pick it up */
  claimSeconds?: number;
}

export interface EnrollmentView {
  enrollmentId: string;
  journeyId: string;
  journeyVersion: number;
  runState: JrRunState;
  stepSequence: number;
  currentStepId?: string;
  waitUntil?: string;
  maxAgeAt?: string;
  terminalReason?: JrTerminalReason;
  terminalStepId?: string;
  terminalAt?: string;
}

export type JourneyStepOutcome =
  | { kind: 'ADVANCED'; stepId: string; nextStepId: string; enrollment: EnrollmentView }
  | { kind: 'WAITING'; stepId: string; wakeAt: string; enrollment: EnrollmentView }
  | { kind: 'AWAITING_SEND'; stepId: string; stepSequence: number; enrollment: EnrollmentView }
  | { kind: 'TERMINAL'; reason: JrTerminalReason; enrollment: EnrollmentView }
  | { kind: 'NOT_DUE'; enrollment: EnrollmentView };

export interface EnrollFromEventInput {
  receiptId: string;
  journeyId: string;
  journeyVersion: number;
  correlationId: string;
}

export interface EnrollFromScheduleInput {
  journeyId: string;
  journeyVersion: number;
  /** the point in time of the occurrence the scheduler intended to fire, not the time the worker woke up */
  occurrenceAt: string;
  correlationId: string;
}

export interface AdvanceInput {
  correlationId: string;
  causationId?: string;
  /** BRANCH context; the caller decides what comes in, no value is persisted here */
  context?: ExpressionContext;
}

export class JourneyEnrollmentNotFoundError extends Error {
  readonly code = 'ENROLLMENT_NOT_FOUND';

  constructor(readonly enrollmentId: string) {
    super(`enrollment not found: ${enrollmentId}`);
    this.name = 'JourneyEnrollmentNotFoundError';
  }
}

export class JourneyDefinitionNotPublishedError extends Error {
  readonly code = 'DEFINITION_NOT_PUBLISHED';

  constructor(
    readonly journeyId: string,
    readonly version: number,
  ) {
    super(`Journey version is not published yet: ${journeyId}:${version}`);
    this.name = 'JourneyDefinitionNotPublishedError';
  }
}

/**
 * J5.2 (#340): a PAUSED/DEPRECATED head only stops accepting new enrollments — existing enrollments still advance
 * and a replay of an already-created enrollment still returns the original one (Phase Contract §5)
 */
export class JourneyNotAcceptingEnrollmentsError extends Error {
  readonly code = 'JOURNEY_LIFECYCLE_CONFLICT';

  constructor(
    readonly journeyId: string,
    readonly lifecycle: string,
  ) {
    super(`Journey ${journeyId} is in state ${lifecycle} so it does not accept new enrollments`);
    this.name = 'JourneyNotAcceptingEnrollmentsError';
  }
}

export class JourneyStepRaceError extends Error {
  readonly code = 'STEP_ALREADY_RUN';

  constructor(
    readonly enrollmentId: string,
    readonly stepSequence: number,
  ) {
    super(`step ${stepSequence} of ${enrollmentId} was already run by another worker`);
    this.name = 'JourneyStepRaceError';
  }
}

const enrollmentSelection = {
  id: true,
  journeyId: true,
  journeyVersion: true,
  runState: true,
  currentStepId: true,
  stepSequence: true,
  waitUntil: true,
  maxAgeAt: true,
  terminalReason: true,
  terminalStepId: true,
  terminalAt: true,
} as const;

type EnrollmentRow = {
  id: string;
  journeyId: string | null;
  journeyVersion: number;
  runState: JrRunState;
  currentStepId: string | null;
  stepSequence: number;
  waitUntil: Date | null;
  maxAgeAt: Date | null;
  terminalReason: JrTerminalReason | null;
  terminalStepId: string | null;
  terminalAt: Date | null;
};

function view(row: EnrollmentRow): EnrollmentView {
  return {
    enrollmentId: row.id,
    journeyId: row.journeyId ?? '',
    journeyVersion: row.journeyVersion,
    runState: row.runState,
    stepSequence: row.stepSequence,
    ...(row.currentStepId ? { currentStepId: row.currentStepId } : {}),
    ...(row.waitUntil ? { waitUntil: row.waitUntil.toISOString() } : {}),
    ...(row.maxAgeAt ? { maxAgeAt: row.maxAgeAt.toISOString() } : {}),
    ...(row.terminalReason ? { terminalReason: row.terminalReason } : {}),
    ...(row.terminalStepId ? { terminalStepId: row.terminalStepId } : {}),
    ...(row.terminalAt ? { terminalAt: row.terminalAt.toISOString() } : {}),
  };
}

function stepOf(graph: JourneyGraph, stepId: string): JourneyGraphStep {
  const step = graph.steps.find((candidate) => candidate.id === stepId);
  if (!step) throw new TypeError(`graph has no step ${stepId}`);
  return step;
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

export class JourneyExecutionService {
  private readonly now: () => Date;
  private readonly id: () => string;
  private readonly claimSeconds: number;

  constructor(
    private readonly database: PrismaClient,
    private readonly definitions: JourneyDefinitionSource,
    private readonly evaluator: ExpressionEvaluator,
    options: JourneyExecutionOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.id = options.id ?? randomUUID;
    this.claimSeconds = options.claimSeconds ?? 60;
  }

  private async publishedGraph(
    tenantId: string,
    journeyId: string,
    version: number,
  ): Promise<JourneyVersionSnapshot> {
    const snapshot = await this.definitions.getVersion(tenantId, journeyId, version);
    if (!snapshot || snapshot.status !== 'PUBLISHED') {
      throw new JourneyDefinitionNotPublishedError(journeyId, version);
    }
    return snapshot;
  }

  /**
   * Event ingress: `(tenant_id, event_inbox_id)` is already unique, so calling again with
   * the same receipt returns the existing enrollment instead of opening a new one, even from a different worker
   */
  async enrollFromEvent(tenantId: string, input: EnrollFromEventInput): Promise<EnrollmentView> {
    const definition = await this.publishedGraph(tenantId, input.journeyId, input.journeyVersion);
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await lockTeamReferences(transaction, tenantId, [definition.ownerTeamId]);
      await this.lock(transaction, `jr-enroll-event:${tenantId}:${input.receiptId}`);
      const existing = await transaction.jrEnrollment.findFirst({
        where: { tenantId, eventInboxId: input.receiptId },
        select: enrollmentSelection,
      });
      if (existing) return view(existing);
      await this.assertAcceptsNewEnrollments(transaction, tenantId, input.journeyId);

      const created = await transaction.jrEnrollment.create({
        data: {
          id: input.receiptId,
          tenantId,
          eventInboxId: input.receiptId,
          journeyId: input.journeyId,
          journeyVersion: input.journeyVersion,
          runState: 'RUNNING',
          currentStepId: definition.graph.entryStepId,
          maxAgeAt: this.maxAgeFrom(definition.maxDurationDays),
          correlationId: input.correlationId,
        },
        select: enrollmentSelection,
      });
      return view(created);
    });
  }

  /**
   * Schedule ingress: unique `(tenant, journey, version, occurrence_at)` guards against a cron
   * that fires twice, whether from the scheduler itself, several workers or a restart — the loser reads the
   * existing occurrence and returns the same enrollment
   */
  async enrollFromSchedule(
    tenantId: string,
    input: EnrollFromScheduleInput,
  ): Promise<EnrollmentView> {
    const definition = await this.publishedGraph(tenantId, input.journeyId, input.journeyVersion);
    const occurrenceAt = new Date(input.occurrenceAt);
    if (Number.isNaN(occurrenceAt.getTime())) {
      throw new TypeError('occurrenceAt must be an ISO-8601 timestamp');
    }

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await lockTeamReferences(transaction, tenantId, [definition.ownerTeamId]);
      await this.lock(
        transaction,
        `jr-occurrence:${tenantId}:${input.journeyId}:${input.journeyVersion}:${occurrenceAt.toISOString()}`,
      );
      const existing = await transaction.jrScheduleOccurrence.findFirst({
        where: {
          tenantId,
          journeyId: input.journeyId,
          journeyVersion: input.journeyVersion,
          occurrenceAt,
        },
        select: { id: true },
      });
      if (existing) {
        const enrollment = await transaction.jrEnrollment.findFirst({
          where: { tenantId, occurrenceId: existing.id },
          select: enrollmentSelection,
        });
        if (enrollment) return view(enrollment);
      }
      await this.assertAcceptsNewEnrollments(transaction, tenantId, input.journeyId);

      const occurrenceId = existing?.id ?? this.id();
      if (!existing) {
        await transaction.jrScheduleOccurrence.create({
          data: {
            id: occurrenceId,
            tenantId,
            journeyId: input.journeyId,
            journeyVersion: input.journeyVersion,
            occurrenceAt,
            state: 'CLAIMED',
            correlationId: input.correlationId,
          },
        });
      }

      const created = await transaction.jrEnrollment.create({
        data: {
          id: this.id(),
          tenantId,
          occurrenceId,
          journeyId: input.journeyId,
          journeyVersion: input.journeyVersion,
          runState: 'RUNNING',
          currentStepId: definition.graph.entryStepId,
          maxAgeAt: this.maxAgeFrom(definition.maxDurationDays),
          correlationId: input.correlationId,
        },
        select: enrollmentSelection,
      });
      await transaction.jrScheduleOccurrence.update({
        where: { id: occurrenceId },
        data: { state: 'ENROLLED' },
      });
      return view(created);
    });
  }

  /**
   * Advances one node per call, not the whole graph — the caller controls the pace
   * and a crash midway loses only the one node that has not committed
   */
  async advance(
    tenantId: string,
    enrollmentId: string,
    input: AdvanceInput,
  ): Promise<JourneyStepOutcome> {
    const head = await this.read(tenantId, enrollmentId);
    const definition = await this.publishedGraph(
      tenantId,
      head.journeyId ?? '',
      head.journeyVersion,
    );

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await lockTeamReferences(transaction, tenantId, [definition.ownerTeamId]);
      await this.lock(transaction, `jr-enrollment:${tenantId}:${enrollmentId}`);
      const row = await transaction.jrEnrollment.findFirst({
        where: { id: enrollmentId, tenantId },
        select: enrollmentSelection,
      });
      if (!row) throw new JourneyEnrollmentNotFoundError(enrollmentId);

      // an earlier terminal (cancel/goal/exit) always wins, and is checked in the same transaction that runs the node
      if (row.runState === 'TERMINAL') {
        return {
          kind: 'TERMINAL' as const,
          reason: row.terminalReason ?? 'CANCELLED',
          enrollment: view(row),
        };
      }

      const now = this.now();
      if (row.maxAgeAt && row.maxAgeAt <= now) {
        const aged = await this.writeTerminal(transaction, tenantId, row, 'MAX_AGE', now);
        return { kind: 'TERMINAL' as const, reason: 'MAX_AGE', enrollment: view(aged) };
      }
      if (row.runState === 'WAITING' && row.waitUntil && row.waitUntil > now) {
        return { kind: 'NOT_DUE' as const, enrollment: view(row) };
      }
      if (!row.currentStepId) {
        const done = await this.writeTerminal(transaction, tenantId, row, 'GRAPH_EXIT', now);
        return { kind: 'TERMINAL' as const, reason: 'GRAPH_EXIT', enrollment: view(done) };
      }

      // a SEND handed over to C1.6 stays at the same cursor, so calling advance again must
      // be a replay of the original hand-off, not another run of the same node
      const parked = await this.pendingSend(transaction, tenantId, row);
      if (parked) {
        return {
          kind: 'AWAITING_SEND' as const,
          stepId: parked.stepId,
          stepSequence: parked.stepSequence,
          enrollment: view(row),
        };
      }

      const step = stepOf(definition.graph, row.currentStepId);
      const sequence = row.stepSequence + 1;
      // node semantics come from the same central planner as the J5 simulator (#340)
      const plan = planJourneyStep(step, {
        now,
        context: input.context ?? {},
        evaluator: this.evaluator,
      });

      if (plan.kind === 'EXIT') {
        await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
          state: 'COMPLETED',
        });
        const exited = await this.writeTerminal(transaction, tenantId, row, 'GRAPH_EXIT', now, {
          stepSequence: sequence,
          stepId: step.id,
        });
        return { kind: 'TERMINAL' as const, reason: 'GRAPH_EXIT', enrollment: view(exited) };
      }

      if (plan.kind === 'WAIT') {
        const wakeAt = plan.wakeAt;
        await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
          state: 'COMPLETED',
          nextStepId: plan.nextStepId,
        });
        const waiting = await this.moveCursor(transaction, tenantId, row, sequence, {
          runState: 'WAITING',
          currentStepId: plan.nextStepId,
          waitUntil: wakeAt,
          claimedBy: null,
          claimExpiresAt: null,
        });
        return {
          kind: 'WAITING' as const,
          stepId: step.id,
          wakeAt: wakeAt.toISOString(),
          enrollment: view(waiting),
        };
      }

      if (plan.kind === 'BRANCH') {
        const { branchResult, nextStepId } = plan;
        await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
          state: 'COMPLETED',
          nextStepId,
          branchResult,
        });
        const advanced = await this.moveCursor(transaction, tenantId, row, sequence, {
          runState: 'RUNNING',
          currentStepId: nextStepId,
          waitUntil: null,
        });
        return {
          kind: 'ADVANCED' as const,
          stepId: step.id,
          nextStepId,
          enrollment: view(advanced),
        };
      }

      // SEND: C1.5 stops here and does not touch Governance/Delivery — C1.6 continues from here
      await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
        state: 'AWAITING_SEND',
        nextStepId: plan.kind === 'AWAIT_SEND' ? plan.nextStepId : plan.acceptedStepId,
      });
      const pending = await this.moveCursor(transaction, tenantId, row, sequence, {
        runState: 'RUNNING',
        currentStepId: step.id,
        waitUntil: null,
      });
      return {
        kind: 'AWAITING_SEND' as const,
        stepId: step.id,
        stepSequence: sequence,
        enrollment: view(pending),
      };
    });
  }

  private async assertAcceptsNewEnrollments(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    journeyId: string,
  ) {
    const head = await transaction.jrJourneyHead.findUnique({
      where: { tenantId_journeyId: { tenantId, journeyId } },
      select: { lifecycle: true },
    });
    // an existing journey without an authoring head is not affected
    if (head && !lifecycleAcceptsNewEnrollments(head.lifecycle)) {
      throw new JourneyNotAcceptingEnrollmentsError(journeyId, head.lifecycle);
    }
  }

  /**
   * Picks up due work with `FOR UPDATE SKIP LOCKED` + lease: several workers can therefore split
   * the work without talking to each other, and the work of a dead worker returns to the queue when the lease expires
   */
  async claimDueWork(
    tenantId: string,
    options: { workerId: string; limit?: number } = { workerId: 'worker' },
  ): Promise<string[]> {
    const limit = options.limit ?? 10;
    const now = this.now();
    const claimExpiresAt = new Date(now.getTime() + this.claimSeconds * 1_000);

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const due = await transaction.$queryRaw<Array<{ id: string }>>(Prisma.sql`
        SELECT id
        FROM jr_enrollments
        WHERE tenant_id = ${tenantId}::uuid
          AND run_state <> 'TERMINAL'
          AND (run_state = 'RUNNING' OR wait_until <= ${now})
          AND (claim_expires_at IS NULL OR claim_expires_at <= ${now})
        ORDER BY wait_until NULLS FIRST, created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `);
      if (due.length === 0) return [];

      const ids = due.map((row) => row.id);
      await transaction.jrEnrollment.updateMany({
        where: { tenantId, id: { in: ids } },
        data: { claimedBy: options.workerId, claimExpiresAt },
      });
      return ids;
    });
  }

  /**
   * the durable state contract C1.6 calls when a SEND is handed over successfully — this code does not know and
   * does not care what Governance/Delivery did, only that the cursor can move on now
   */
  async completeSend(
    tenantId: string,
    enrollmentId: string,
    input: AdvanceInput,
  ): Promise<JourneyStepOutcome> {
    const head = await this.read(tenantId, enrollmentId);
    const definition = await this.publishedGraph(
      tenantId,
      head.journeyId ?? '',
      head.journeyVersion,
    );

    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await lockTeamReferences(transaction, tenantId, [definition.ownerTeamId]);
      await this.lock(transaction, `jr-enrollment:${tenantId}:${enrollmentId}`);
      const row = await transaction.jrEnrollment.findFirst({
        where: { id: enrollmentId, tenantId },
        select: enrollmentSelection,
      });
      if (!row) throw new JourneyEnrollmentNotFoundError(enrollmentId);
      if (row.runState === 'TERMINAL') {
        return {
          kind: 'TERMINAL' as const,
          reason: row.terminalReason ?? 'CANCELLED',
          enrollment: view(row),
        };
      }

      const parked = await this.pendingSend(transaction, tenantId, row);
      if (!parked) throw new JourneyStepRaceError(enrollmentId, row.stepSequence);

      const step = stepOf(definition.graph, parked.stepId);
      if (step.type !== 'SEND') throw new TypeError(`step ${step.id} is not a SEND`);

      const sequence = row.stepSequence + 1;
      await this.recordStepRun(transaction, tenantId, row, sequence, step, input, {
        state: 'COMPLETED',
        nextStepId: step.next,
      });
      const advanced = await this.moveCursor(transaction, tenantId, row, sequence, {
        runState: 'RUNNING',
        currentStepId: step.next,
        waitUntil: null,
      });
      return {
        kind: 'ADVANCED' as const,
        stepId: step.id,
        nextStepId: step.next,
        enrollment: view(advanced),
      };
    });
  }

  private async pendingSend(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    row: EnrollmentRow,
  ): Promise<{ stepId: string; stepSequence: number } | undefined> {
    if (row.stepSequence === 0) return undefined;
    const last = await transaction.jrStepRun.findFirst({
      where: { tenantId, enrollmentId: row.id, stepSequence: row.stepSequence },
      select: { state: true, stepId: true, stepSequence: true },
    });
    if (!last || last.state !== 'AWAITING_SEND' || last.stepId !== row.currentStepId) {
      return undefined;
    }
    return { stepId: last.stepId, stepSequence: last.stepSequence };
  }

  /** cancel from outside — always beats work not yet submitted, and keeps the reason only once */
  cancel(tenantId: string, enrollmentId: string): Promise<EnrollmentView> {
    return this.terminate(tenantId, enrollmentId, 'CANCELLED');
  }

  /** goal reached — remaining enrollments need not continue */
  reachGoal(tenantId: string, enrollmentId: string): Promise<EnrollmentView> {
    return this.terminate(tenantId, enrollmentId, 'GOAL_REACHED');
  }

  /** an exit rule fired from outside (event or higher-priority journey) */
  applyExitRule(tenantId: string, enrollmentId: string): Promise<EnrollmentView> {
    return this.terminate(tenantId, enrollmentId, 'EXIT_RULE');
  }

  /** closes enrollments past max age in bulk — idempotent for enrollments that already ended */
  async sweepMaxAge(tenantId: string, limit = 50): Promise<EnrollmentView[]> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const expired = await transaction.jrEnrollment.findMany({
        where: {
          tenantId,
          runState: { not: 'TERMINAL' },
          maxAgeAt: { lte: now },
        },
        select: enrollmentSelection,
        orderBy: { maxAgeAt: 'asc' },
        take: limit,
      });
      const closed: EnrollmentView[] = [];
      for (const row of expired) {
        closed.push(view(await this.writeTerminal(transaction, tenantId, row, 'MAX_AGE', now)));
      }
      return closed;
    });
  }

  private async read(tenantId: string, enrollmentId: string): Promise<EnrollmentRow> {
    const row = await withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrEnrollment.findFirst({
        where: { id: enrollmentId, tenantId },
        select: enrollmentSelection,
      }),
    );
    if (!row) throw new JourneyEnrollmentNotFoundError(enrollmentId);
    return row;
  }

  /** read the current state as safe evidence — no payload or context leaks out */
  async describe(tenantId: string, enrollmentId: string): Promise<EnrollmentView> {
    return view(await this.read(tenantId, enrollmentId));
  }

  private async terminate(
    tenantId: string,
    enrollmentId: string,
    reason: JrTerminalReason,
  ): Promise<EnrollmentView> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await lockTeamReferences(transaction, tenantId, []);
      await this.lock(transaction, `jr-enrollment:${tenantId}:${enrollmentId}`);
      const row = await transaction.jrEnrollment.findFirst({
        where: { id: enrollmentId, tenantId },
        select: enrollmentSelection,
      });
      if (!row) throw new JourneyEnrollmentNotFoundError(enrollmentId);
      return view(await this.writeTerminal(transaction, tenantId, row, reason, this.now()));
    });
  }

  /** the first terminal wins: an already-ended row returns the existing value without overwriting the reason or time */
  private async writeTerminal(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    row: EnrollmentRow,
    reason: JrTerminalReason,
    now: Date,
    at: { stepSequence?: number; stepId?: string } = {},
  ): Promise<EnrollmentRow> {
    if (row.runState === 'TERMINAL') return row;
    const updated = await transaction.jrEnrollment.updateMany({
      where: { tenantId, id: row.id, runState: { not: 'TERMINAL' } },
      data: {
        runState: 'TERMINAL',
        terminalReason: reason,
        terminalAt: now,
        terminalStepId: at.stepId ?? row.currentStepId,
        waitUntil: null,
        claimedBy: null,
        claimExpiresAt: null,
        ...(at.stepSequence ? { stepSequence: at.stepSequence } : {}),
      },
    });
    if (updated.count === 0) {
      // another worker closed it first — its reason is the real one
      return transaction.jrEnrollment.findFirstOrThrow({
        where: { id: row.id, tenantId },
        select: enrollmentSelection,
      });
    }
    return transaction.jrEnrollment.findFirstOrThrow({
      where: { id: row.id, tenantId },
      select: enrollmentSelection,
    });
  }

  /**
   * the ledger is what guards against double runs, not read-before-write: the losing worker hits the unique
   * `(enrollment_id, step_sequence)` and learns that someone already ran this node
   */
  private async recordStepRun(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    row: EnrollmentRow,
    stepSequence: number,
    step: JourneyGraphStep,
    input: AdvanceInput,
    outcome: {
      state: 'COMPLETED' | 'AWAITING_SEND';
      nextStepId?: string;
      branchResult?: boolean;
    },
  ): Promise<void> {
    try {
      await transaction.jrStepRun.create({
        data: {
          id: this.id(),
          tenantId,
          enrollmentId: row.id,
          stepSequence,
          stepId: step.id,
          stepType: step.type,
          state: outcome.state,
          ...(outcome.nextStepId ? { nextStepId: outcome.nextStepId } : {}),
          ...(outcome.branchResult === undefined ? {} : { branchResult: outcome.branchResult }),
          correlationId: input.correlationId,
          ...(input.causationId ? { causationId: input.causationId } : {}),
          startedAt: this.now(),
        },
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw new JourneyStepRaceError(row.id, stepSequence);
      throw error;
    }
  }

  /** CAS on step_sequence: the cursor can advance only if it is still at the position we read */
  private async moveCursor(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    row: EnrollmentRow,
    stepSequence: number,
    data: {
      runState: JrRunState;
      currentStepId: string;
      waitUntil: Date | null;
      claimedBy?: null;
      claimExpiresAt?: null;
    },
  ): Promise<EnrollmentRow> {
    const updated = await transaction.jrEnrollment.updateMany({
      where: {
        tenantId,
        id: row.id,
        stepSequence: row.stepSequence,
        runState: { not: 'TERMINAL' },
      },
      data: { ...data, stepSequence },
    });
    if (updated.count === 0) throw new JourneyStepRaceError(row.id, stepSequence);
    return transaction.jrEnrollment.findFirstOrThrow({
      where: { id: row.id, tenantId },
      select: enrollmentSelection,
    });
  }

  private maxAgeFrom(maxDurationDays: number): Date {
    return new Date(this.now().getTime() + maxDurationDays * 24 * 60 * 60 * 1_000);
  }

  private async lock(transaction: Prisma.TransactionClient, key: string): Promise<void> {
    await transaction.$queryRaw(
      Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${key}))`,
    );
  }
}
