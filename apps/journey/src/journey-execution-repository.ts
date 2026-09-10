import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type JrExecutionStatus,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { ExpressionEvaluator } from '@d-contact/cxa-contracts';
import type { JourneyVersionSnapshot } from './journey-definition.js';
import {
  JourneyDefinitionNotPublishedError,
  JourneyExecutionNotFoundError,
  JourneyExecutionNotSubmittingError,
  JourneySubmissionBarrierError,
  type AdvanceExecutionInput,
  type CancelExecutionInput,
  type EnrollExecutionInput,
  type JourneyActionPort,
  type JourneyExecutionSnapshot,
  type JourneyExecutionTerminalReason,
  type RecordExitEventInput,
  type RecordGoalReachedInput,
  type SubmitExecutionInput,
} from './journey-execution.js';
import { walkExecution, type TerminationSignals } from './journey-execution-walker.js';
import { createJourneyActionKey } from './action-key.js';

interface StoredExecution {
  id: string;
  tenantId: string;
  journeyId: string;
  journeyVersion: number;
  enrollmentKey: string;
  status: JrExecutionStatus;
  currentStepId: string;
  pendingActionKey: string | null;
  stepVersion: number;
  waitUntil: Date | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  goalReachedAt: Date | null;
  exitEventType: string | null;
  exitEventAt: Date | null;
  terminalReason: string | null;
  terminalAt: Date | null;
  correlationId: string;
  enrolledAt: Date;
  updatedAt: Date;
}

const TERMINAL_STATUSES: readonly JrExecutionStatus[] = [
  'COMPLETED',
  'EXITED',
  'CANCELLED',
  'FAILED',
];

function toSnapshot(row: StoredExecution): JourneyExecutionSnapshot {
  return {
    tenantId: row.tenantId,
    id: row.id,
    journeyId: row.journeyId,
    journeyVersion: row.journeyVersion,
    enrollmentKey: row.enrollmentKey,
    status: row.status,
    currentStepId: row.currentStepId,
    ...(row.pendingActionKey ? { pendingActionKey: row.pendingActionKey } : {}),
    stepVersion: row.stepVersion,
    ...(row.waitUntil ? { waitUntil: row.waitUntil.toISOString() } : {}),
    ...(row.cancelledAt ? { cancelledAt: row.cancelledAt.toISOString() } : {}),
    ...(row.cancelReason ? { cancelReason: row.cancelReason } : {}),
    ...(row.goalReachedAt ? { goalReachedAt: row.goalReachedAt.toISOString() } : {}),
    ...(row.exitEventType ? { exitEventType: row.exitEventType } : {}),
    ...(row.exitEventAt ? { exitEventAt: row.exitEventAt.toISOString() } : {}),
    ...(row.terminalReason
      ? { terminalReason: row.terminalReason as JourneyExecutionTerminalReason }
      : {}),
    ...(row.terminalAt ? { terminalAt: row.terminalAt.toISOString() } : {}),
    correlationId: row.correlationId,
    enrolledAt: row.enrolledAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function signalsOf(row: StoredExecution): TerminationSignals {
  return {
    ...(row.cancelledAt ? { cancelledAt: row.cancelledAt } : {}),
    ...(row.goalReachedAt ? { goalReachedAt: row.goalReachedAt } : {}),
    ...(row.exitEventAt ? { exitEventAt: row.exitEventAt } : {}),
    ...(row.exitEventType ? { exitEventType: row.exitEventType } : {}),
  };
}

function terminalStatusFor(reason: JourneyExecutionTerminalReason): JrExecutionStatus {
  switch (reason) {
    case 'JOURNEY_EXIT':
      return 'COMPLETED';
    case 'CANCELLED':
      return 'CANCELLED';
    case 'EXECUTION_FAILED':
      return 'FAILED';
    default:
      return 'EXITED';
  }
}

export interface JourneyExecutionRepositoryOptions {
  id?: () => string;
  now?: () => Date;
}

/**
 * Owner: Journey. เดิน durable execution ของ published JrJourneyDefinition ผ่าน
 * `walkExecution` (pure) แล้ว commit ผลลัพธ์ด้วย advisory lock + optimistic
 * stepVersion — SEND เป็น submission barrier สองเฟส (SUBMITTING ก่อนเรียก port,
 * ยืนยันผลหลัง I/O) ตามวินัย ContactGovernancePort/DeliveryPort ที่มีอยู่แล้ว
 */
export class JourneyExecutionRepository {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    private readonly evaluator: ExpressionEvaluator,
    options: JourneyExecutionRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async enroll(input: EnrollExecutionInput): Promise<JourneyExecutionSnapshot> {
    const persist = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-execution-enroll:${input.tenantId}:${input.journeyId}:${input.journeyVersion}:${input.enrollmentKey}`}))`,
      );

      const existing = await transaction.jrExecution.findUnique({
        where: {
          tenantId_journeyId_journeyVersion_enrollmentKey: {
            tenantId: input.tenantId,
            journeyId: input.journeyId,
            journeyVersion: input.journeyVersion,
            enrollmentKey: input.enrollmentKey,
          },
        },
      });
      if (existing) return toSnapshot(existing);

      const definition = await transaction.jrJourneyDefinition.findUnique({
        where: {
          tenantId_journeyId_version: {
            tenantId: input.tenantId,
            journeyId: input.journeyId,
            version: input.journeyVersion,
          },
        },
        select: { status: true, graph: true },
      });
      if (!definition || definition.status !== 'PUBLISHED') {
        throw new JourneyDefinitionNotPublishedError(input.journeyId, input.journeyVersion);
      }
      const graph = definition.graph as unknown as JourneyVersionSnapshot['graph'];

      const created = await transaction.jrExecution.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          journeyId: input.journeyId,
          journeyVersion: input.journeyVersion,
          enrollmentKey: input.enrollmentKey,
          currentStepId: graph.entryStepId,
          correlationId: input.correlationId,
        },
      });
      return toSnapshot(created);
    };

    return withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }

  async getExecution(
    tenantId: string,
    executionId: string,
  ): Promise<JourneyExecutionSnapshot | undefined> {
    const read = async (transaction: Prisma.TransactionClient) => {
      const row = await transaction.jrExecution.findUnique({
        where: { tenantId_id: { tenantId, id: executionId } },
      });
      return row ? toSnapshot(row) : undefined;
    };
    return withTenantDatabaseTransaction(this.database, tenantId, read);
  }

  async findDueWaiting(
    tenantId: string,
    limit = 100,
  ): Promise<readonly JourneyExecutionSnapshot[]> {
    const read = async (transaction: Prisma.TransactionClient) => {
      const rows = await transaction.jrExecution.findMany({
        where: { tenantId, status: 'WAITING', waitUntil: { lte: this.now() } },
        orderBy: { waitUntil: 'asc' },
        take: limit,
      });
      return rows.map(toSnapshot);
    };
    return withTenantDatabaseTransaction(this.database, tenantId, read);
  }

  async advance(input: AdvanceExecutionInput): Promise<JourneyExecutionSnapshot> {
    const persist = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-execution:${input.tenantId}:${input.executionId}`}))`,
      );

      const execution = await transaction.jrExecution.findUnique({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
      });
      if (!execution) throw new JourneyExecutionNotFoundError(input.executionId);

      const now = this.now();
      const notResumable =
        TERMINAL_STATUSES.includes(execution.status) ||
        execution.status === 'SUBMITTING' ||
        (execution.status === 'WAITING' &&
          execution.waitUntil !== null &&
          execution.waitUntil > now);
      if (notResumable) return toSnapshot(execution);

      const definitionRow = await transaction.jrJourneyDefinition.findUniqueOrThrow({
        where: {
          tenantId_journeyId_version: {
            tenantId: input.tenantId,
            journeyId: execution.journeyId,
            version: execution.journeyVersion,
          },
        },
      });
      const definition: JourneyVersionSnapshot = {
        tenantId: definitionRow.tenantId,
        journeyId: definitionRow.journeyId,
        version: definitionRow.version,
        name: definitionRow.name,
        ownerTeamId: definitionRow.ownerTeamId,
        status: definitionRow.status,
        trigger: definitionRow.trigger as unknown as JourneyVersionSnapshot['trigger'],
        graph: definitionRow.graph as unknown as JourneyVersionSnapshot['graph'],
        goal: definitionRow.goal as unknown as JourneyVersionSnapshot['goal'],
        exitRules: definitionRow.exitRules as unknown as JourneyVersionSnapshot['exitRules'],
        maxDurationDays: definitionRow.maxDurationDays,
        contentHash: definitionRow.inputHash,
        createdAt: definitionRow.createdAt.toISOString(),
      };

      const outcome = walkExecution({
        definition,
        startStepId: execution.currentStepId,
        context: input.context,
        evaluator: this.evaluator,
        now,
        enrolledAt: execution.enrolledAt,
        signals: signalsOf(execution),
      });

      const fromStepVersion = execution.stepVersion;
      const logStep = (stepId: string, stepType: string, result: string) =>
        transaction.jrExecutionStep.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            executionId: input.executionId,
            fromStepVersion,
            stepId,
            stepType,
            result,
            correlationId: input.correlationId,
            ...(input.causationId ? { causationId: input.causationId } : {}),
          },
        });

      if (outcome.kind === 'WAIT') {
        const updated = await transaction.jrExecution.update({
          where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
          data: {
            currentStepId: outcome.resumeStepId,
            status: 'WAITING',
            waitUntil: new Date(now.getTime() + outcome.waitSeconds * 1000),
            stepVersion: { increment: 1 },
          },
        });
        await logStep(outcome.loggedStepId, 'WAIT', 'WAITING');
        return toSnapshot(updated);
      }

      if (outcome.kind === 'SUBMIT') {
        const actionKey = createJourneyActionKey({
          enrollmentId: execution.enrollmentKey,
          journeyVersion: execution.journeyVersion,
          stepId: outcome.stepId,
        });
        const updated = await transaction.jrExecution.update({
          where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
          data: {
            currentStepId: outcome.stepId,
            status: 'SUBMITTING',
            pendingActionKey: actionKey,
            stepVersion: { increment: 1 },
          },
        });
        await logStep(outcome.stepId, 'SEND', 'SUBMITTING');
        return toSnapshot(updated);
      }

      if (outcome.kind === 'FAILED') {
        const updated = await transaction.jrExecution.update({
          where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
          data: {
            status: 'FAILED',
            terminalReason: 'EXECUTION_FAILED',
            terminalAt: now,
            stepVersion: { increment: 1 },
          },
        });
        await logStep(execution.currentStepId, 'TERMINAL', `FAILED:${outcome.reasonCode}`);
        return toSnapshot(updated);
      }

      const status = terminalStatusFor(outcome.reason);
      const updated = await transaction.jrExecution.update({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
        data: {
          status,
          terminalReason: outcome.reason,
          terminalAt: now,
          stepVersion: { increment: 1 },
        },
      });
      await logStep(outcome.stepId ?? execution.currentStepId, 'TERMINAL', outcome.reason);
      return toSnapshot(updated);
    };

    return withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }

  async submit(
    input: SubmitExecutionInput,
    actionPort: JourneyActionPort,
  ): Promise<JourneyExecutionSnapshot> {
    const loadPending = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-execution:${input.tenantId}:${input.executionId}`}))`,
      );
      const execution = await transaction.jrExecution.findUnique({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
      });
      if (!execution) throw new JourneyExecutionNotFoundError(input.executionId);
      if (execution.status !== 'SUBMITTING') return { execution, graph: undefined };

      const definitionRow = await transaction.jrJourneyDefinition.findUniqueOrThrow({
        where: {
          tenantId_journeyId_version: {
            tenantId: input.tenantId,
            journeyId: execution.journeyId,
            version: execution.journeyVersion,
          },
        },
      });
      return {
        execution,
        graph: definitionRow.graph as unknown as JourneyVersionSnapshot['graph'],
      };
    };
    const { execution: pending, graph } = await withTenantDatabaseTransaction(
      this.database,
      input.tenantId,
      loadPending,
    );

    if (pending.status !== 'SUBMITTING') {
      if (
        TERMINAL_STATUSES.includes(pending.status) ||
        pending.status === 'ACTIVE' ||
        pending.status === 'WAITING'
      ) {
        return toSnapshot(pending);
      }
      throw new JourneyExecutionNotSubmittingError(input.executionId);
    }
    if (!pending.pendingActionKey || !graph)
      throw new JourneyExecutionNotSubmittingError(input.executionId);

    const step = graph.steps.find((candidate) => candidate.id === pending.currentStepId);
    if (!step || step.type !== 'SEND')
      throw new JourneyExecutionNotSubmittingError(input.executionId);

    const result = await actionPort.send({
      tenantId: input.tenantId,
      executionId: input.executionId,
      stepId: step.id,
      actionKey: pending.pendingActionKey,
      channel: step.channel,
      contentRef: step.contentRef,
      correlationId: input.correlationId,
      ...(input.causationId ? { causationId: input.causationId } : {}),
    });

    const commit = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-execution:${input.tenantId}:${input.executionId}`}))`,
      );
      const current = await transaction.jrExecution.findUnique({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
      });
      if (!current) throw new JourneyExecutionNotFoundError(input.executionId);
      if (current.status !== 'SUBMITTING' || current.stepVersion !== pending.stepVersion) {
        return toSnapshot(current);
      }

      const resultLabel =
        result.status === 'SUBMITTED' ? 'SUBMITTED' : `SKIPPED:${result.reasonCode}`;
      const updated = await transaction.jrExecution.update({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
        data: {
          currentStepId: step.next,
          status: 'ACTIVE',
          pendingActionKey: null,
          stepVersion: { increment: 1 },
        },
      });
      await transaction.jrExecutionStep.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          executionId: input.executionId,
          fromStepVersion: pending.stepVersion,
          stepId: step.id,
          stepType: 'SEND',
          result: resultLabel,
          correlationId: input.correlationId,
          ...(input.causationId ? { causationId: input.causationId } : {}),
        },
      });
      return toSnapshot(updated);
    };

    return withTenantDatabaseTransaction(this.database, input.tenantId, commit);
  }

  async cancel(input: CancelExecutionInput): Promise<JourneyExecutionSnapshot> {
    const persist = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-execution:${input.tenantId}:${input.executionId}`}))`,
      );
      const execution = await transaction.jrExecution.findUnique({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
      });
      if (!execution) throw new JourneyExecutionNotFoundError(input.executionId);
      if (execution.status === 'SUBMITTING')
        throw new JourneySubmissionBarrierError(input.executionId);
      if (TERMINAL_STATUSES.includes(execution.status) || execution.cancelledAt) {
        return toSnapshot(execution);
      }

      const updated = await transaction.jrExecution.update({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
        data: { cancelledAt: this.now(), cancelReason: input.reason },
      });
      return toSnapshot(updated);
    };
    return withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }

  async recordGoalReached(input: RecordGoalReachedInput): Promise<JourneyExecutionSnapshot> {
    const persist = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-execution:${input.tenantId}:${input.executionId}`}))`,
      );
      const execution = await transaction.jrExecution.findUnique({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
      });
      if (!execution) throw new JourneyExecutionNotFoundError(input.executionId);
      if (execution.goalReachedAt || TERMINAL_STATUSES.includes(execution.status)) {
        return toSnapshot(execution);
      }
      const updated = await transaction.jrExecution.update({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
        data: { goalReachedAt: this.now() },
      });
      return toSnapshot(updated);
    };
    return withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }

  async recordExitEvent(input: RecordExitEventInput): Promise<JourneyExecutionSnapshot> {
    const persist = async (transaction: Prisma.TransactionClient) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`jr-execution:${input.tenantId}:${input.executionId}`}))`,
      );
      const execution = await transaction.jrExecution.findUnique({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
      });
      if (!execution) throw new JourneyExecutionNotFoundError(input.executionId);
      if (execution.exitEventAt || TERMINAL_STATUSES.includes(execution.status)) {
        return toSnapshot(execution);
      }
      const updated = await transaction.jrExecution.update({
        where: { tenantId_id: { tenantId: input.tenantId, id: input.executionId } },
        data: { exitEventType: input.eventType, exitEventAt: this.now() },
      });
      return toSnapshot(updated);
    };
    return withTenantDatabaseTransaction(this.database, input.tenantId, persist);
  }
}
