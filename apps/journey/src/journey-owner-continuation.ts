/**
 * J5.0 (#338) — atomic continuation of restricted J2 owner-action steps.
 *
 * This module owns only Journey's cursor, step ledger and continuation evidence.
 * It never writes Case/Dialer state. Only ACKNOWLEDGED/REJECTED map to graph ports;
 * every other terminal result is retained as TERMINAL_IGNORED evidence.
 */
import {
  Prisma,
  withTenantDatabaseTransaction,
  type JrOwnerAction,
  type JrOwnerResultKind,
  type PrismaClient,
} from '@d-contact/db';
import type { JourneyActionIntentStep, JourneyGraph } from './journey-definition.js';
import type {
  ApplyOwnerResultInput,
  ApplyOwnerResultResult,
} from './journey-owner-action-repository.js';

export const JOURNEY_OWNER_RESULT_CONTINUATION_CAPABILITY = {
  id: 'OWNER_RESULT_CURSOR_CONTINUATION',
  version: 1,
} as const;

export type OwnerContinuationCheckpoint =
  'RESULT_PERSISTED' | 'CONTINUATION_PERSISTED' | 'STEP_RECORDED';

export interface ContinueOwnerResultInput {
  tenantId: string;
  commandId: string;
  resultKind: JrOwnerResultKind;
  resultHash: string;
  correlationId: string;
  action: JrOwnerAction;
  /** state หลังใช้ J2 terminal precedence แล้ว */
  effectiveState: JrOwnerAction['state'];
}

export interface ContinueOwnerResultOptions {
  id: () => string;
  now: () => Date;
  /** test-only crash injection; production callers omit this hook */
  checkpoint?: (phase: OwnerContinuationCheckpoint) => void | Promise<void>;
}

export class OwnerContinuationBindingError extends Error {
  readonly code = 'OWNER_CONTINUATION_BINDING_INVALID' as const;

  constructor(
    readonly actionKey: string,
    detail: string,
  ) {
    super(`owner action ${actionKey} bind กับ Journey cursor ไม่ได้: ${detail}`);
    this.name = 'OwnerContinuationBindingError';
  }
}

export interface OwnerResultContinuationRepository {
  applyResultInTransaction(
    transaction: Prisma.TransactionClient,
    input: ApplyOwnerResultInput,
  ): Promise<ApplyOwnerResultResult>;
}

/**
 * Public J5.0 orchestration boundary. Keeping transaction ownership here lets future
 * push/pull adapters share the exact same atomic result-and-cursor primitive.
 */
export class JourneyOwnerContinuationService {
  constructor(
    private readonly database: PrismaClient,
    private readonly actions: OwnerResultContinuationRepository,
  ) {}

  applyResultAndContinue(input: ApplyOwnerResultInput): Promise<ApplyOwnerResultResult> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      this.actions.applyResultInTransaction(transaction, input),
    );
  }
}

function restrictedStep(graph: JourneyGraph, stepId: string): JourneyActionIntentStep | undefined {
  const step = graph.steps.find((candidate) => candidate.id === stepId);
  return step &&
    (step.type === 'ENSURE_CASE' ||
      step.type === 'ADMIT_CAMPAIGN_TARGET' ||
      step.type === 'SCHEDULE_CALLBACK')
    ? step
    : undefined;
}

/**
 * Called inside the same tenant transaction that persists JrOwnerResultInbox.
 * Null means a legacy action has no provable step binding and is intentionally
 * left untouched; it must be quarantined/backfilled rather than guessed.
 */
export async function continueOwnerResultInTransaction(
  transaction: Prisma.TransactionClient,
  input: ContinueOwnerResultInput,
  options: ContinueOwnerResultOptions,
) {
  const { action } = input;
  if (action.stepId === null || action.stepSequence === null) return null;

  const existing = await transaction.jrOwnerContinuation.findUnique({
    where: {
      tenantId_actionId: { tenantId: input.tenantId, actionId: action.id },
    },
  });
  if (existing) {
    if (existing.resultHash !== input.resultHash) {
      throw new OwnerContinuationBindingError(
        action.actionKey,
        'continuation เดิมมี resultHash ต่างกัน',
      );
    }
    return existing;
  }

  // applyResult owns the action lock. Always take the enrollment lock second so an
  // owner result and the normal Journey executor cannot decide the same cursor at once.
  await transaction.$queryRaw(
    Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`jr-enrollment:${input.tenantId}:${action.enrollmentId}`}))`,
  );

  const enrollment = await transaction.jrEnrollment.findFirst({
    where: { tenantId: input.tenantId, id: action.enrollmentId },
    select: {
      id: true,
      journeyId: true,
      journeyVersion: true,
      runState: true,
      currentStepId: true,
      stepSequence: true,
    },
  });
  if (!enrollment) {
    throw new OwnerContinuationBindingError(
      action.actionKey,
      'ไม่พบ enrollment ใน tenant เดียวกัน',
    );
  }

  const advances = input.effectiveState === 'ACKNOWLEDGED' || input.effectiveState === 'REJECTED';
  if (enrollment.runState === 'TERMINAL' || !advances) {
    const ignored = await transaction.jrOwnerContinuation.create({
      data: {
        id: options.id(),
        tenantId: input.tenantId,
        actionId: action.id,
        actionKey: action.actionKey,
        commandId: input.commandId,
        enrollmentId: enrollment.id,
        fromStepId: action.stepId,
        fromStepSequence: action.stepSequence,
        resultKind: input.resultKind,
        outcome: 'TERMINAL_IGNORED',
        resultHash: input.resultHash,
        correlationId: input.correlationId,
      },
    });
    await options.checkpoint?.('CONTINUATION_PERSISTED');
    return ignored;
  }

  if (!enrollment.journeyId) {
    throw new OwnerContinuationBindingError(action.actionKey, 'enrollment ไม่มี journeyId');
  }
  if (
    enrollment.currentStepId !== action.stepId ||
    enrollment.stepSequence !== action.stepSequence
  ) {
    throw new OwnerContinuationBindingError(
      action.actionKey,
      `cursor อยู่ที่ ${enrollment.currentStepId ?? 'null'}:${enrollment.stepSequence}`,
    );
  }

  const definition = await transaction.jrJourneyDefinition.findUnique({
    where: {
      tenantId_journeyId_version: {
        tenantId: input.tenantId,
        journeyId: enrollment.journeyId,
        version: enrollment.journeyVersion,
      },
    },
    select: { status: true, graph: true },
  });
  if (!definition || definition.status !== 'PUBLISHED') {
    throw new OwnerContinuationBindingError(
      action.actionKey,
      'ไม่พบ published definition ที่ enrollment pin ไว้',
    );
  }

  const step = restrictedStep(definition.graph as unknown as JourneyGraph, action.stepId);
  if (!step || step.type !== action.kind) {
    throw new OwnerContinuationBindingError(
      action.actionKey,
      'step type ไม่ตรงกับ owner action kind',
    );
  }
  const nextStepId = input.effectiveState === 'ACKNOWLEDGED' ? step.next : step.onReject;
  const nextSequence = action.stepSequence + 1;

  const continuation = await transaction.jrOwnerContinuation.create({
    data: {
      id: options.id(),
      tenantId: input.tenantId,
      actionId: action.id,
      actionKey: action.actionKey,
      commandId: input.commandId,
      enrollmentId: enrollment.id,
      fromStepId: action.stepId,
      fromStepSequence: action.stepSequence,
      resultKind: input.resultKind,
      nextStepId,
      outcome: 'ADVANCED',
      resultHash: input.resultHash,
      correlationId: input.correlationId,
    },
  });
  await options.checkpoint?.('CONTINUATION_PERSISTED');

  await transaction.jrStepRun.create({
    data: {
      id: options.id(),
      tenantId: input.tenantId,
      enrollmentId: enrollment.id,
      stepSequence: nextSequence,
      stepId: step.id,
      stepType: step.type,
      state: 'COMPLETED',
      nextStepId,
      correlationId: input.correlationId,
      causationId: input.commandId,
      startedAt: options.now(),
    },
  });
  await options.checkpoint?.('STEP_RECORDED');

  const moved = await transaction.jrEnrollment.updateMany({
    where: {
      tenantId: input.tenantId,
      id: enrollment.id,
      runState: { not: 'TERMINAL' },
      currentStepId: action.stepId,
      stepSequence: action.stepSequence,
    },
    data: {
      runState: 'RUNNING',
      currentStepId: nextStepId,
      stepSequence: nextSequence,
      waitUntil: null,
      claimedBy: null,
      claimExpiresAt: null,
    },
  });
  if (moved.count !== 1) {
    throw new OwnerContinuationBindingError(action.actionKey, 'cursor CAS ไม่สำเร็จ');
  }
  return continuation;
}
