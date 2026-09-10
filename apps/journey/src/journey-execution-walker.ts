import type { ExpressionContext, ExpressionEvaluator } from '@d-contact/cxa-contracts';
import type { JourneyGraphStep, JourneyVersionSnapshot } from './journey-definition.js';
import type { JourneyExecutionTerminalReason } from './journey-execution.js';

const MAX_HOPS = 256;

export interface TerminationSignals {
  cancelledAt?: Date;
  goalReachedAt?: Date;
  exitEventAt?: Date;
  exitEventType?: string;
}

export type WalkOutcome =
  | { kind: 'WAIT'; loggedStepId: string; resumeStepId: string; waitSeconds: number }
  | { kind: 'SUBMIT'; stepId: string; step: Extract<JourneyGraphStep, { type: 'SEND' }> }
  | { kind: 'TERMINAL'; reason: JourneyExecutionTerminalReason; stepId?: string }
  | { kind: 'FAILED'; reasonCode: string };

function matchesExitRule(definition: JourneyVersionSnapshot, signals: TerminationSignals): boolean {
  if (!signals.exitEventAt || !signals.exitEventType) return false;
  return definition.exitRules.some(
    (rule) => rule.kind === 'EVENT' && rule.eventType === signals.exitEventType,
  );
}

function deadline(definition: JourneyVersionSnapshot, enrolledAt: Date): Date {
  return new Date(enrolledAt.getTime() + definition.maxDurationDays * 24 * 60 * 60 * 1000);
}

/**
 * ลำดับความสำคัญของสัญญาณจบ journey ก่อนถึง SEND/submission ใดๆ —
 * cancellation ชนะทุกอย่าง, ตามด้วย goal, exit rule แล้วจึง max-age
 */
function checkTerminationSignals(
  definition: JourneyVersionSnapshot,
  signals: TerminationSignals,
  now: Date,
  enrolledAt: Date,
): JourneyExecutionTerminalReason | undefined {
  if (signals.cancelledAt) return 'CANCELLED';
  if (signals.goalReachedAt) return 'GOAL_REACHED';
  if (matchesExitRule(definition, signals)) return 'EXIT_RULE';
  if (now >= deadline(definition, enrolledAt)) return 'MAX_AGE_EXCEEDED';
  return undefined;
}

/**
 * เดิน graph แบบ deterministic/synchronous ล้วนตั้งแต่ startStepId จนถึงจุดพัก
 * (WAIT), จุด submission (SEND) หรือจุดจบ (EXIT/terminal signal) — ไม่มี I/O
 * และไม่ persist เอง; repository เป็นผู้ commit ผลลัพธ์
 */
export function walkExecution(params: {
  definition: JourneyVersionSnapshot;
  startStepId: string;
  context: ExpressionContext;
  evaluator: ExpressionEvaluator;
  now: Date;
  enrolledAt: Date;
  signals: TerminationSignals;
}): WalkOutcome {
  const { definition, context, evaluator, now, enrolledAt, signals } = params;
  const stepsById = new Map(definition.graph.steps.map((step) => [step.id, step]));

  let stepId = params.startStepId;
  for (let hop = 0; hop < MAX_HOPS; hop += 1) {
    const terminalReason = checkTerminationSignals(definition, signals, now, enrolledAt);
    if (terminalReason) return { kind: 'TERMINAL', reason: terminalReason, stepId };

    const step = stepsById.get(stepId);
    if (!step) return { kind: 'FAILED', reasonCode: 'STEP_NOT_FOUND' };

    switch (step.type) {
      case 'EXIT':
        return { kind: 'TERMINAL', reason: 'JOURNEY_EXIT', stepId: step.id };
      case 'WAIT':
        return {
          kind: 'WAIT',
          loggedStepId: step.id,
          resumeStepId: step.next,
          waitSeconds: step.waitSeconds,
        };
      case 'SEND':
        return { kind: 'SUBMIT', stepId: step.id, step };
      case 'BRANCH': {
        const result = evaluator.evaluate({
          document: step.expression,
          context,
          expectedType: 'boolean',
        });
        if (result.status === 'ERROR') return { kind: 'FAILED', reasonCode: result.code };
        stepId = result.value ? step.whenTrue : step.whenFalse;
        continue;
      }
    }
  }
  return { kind: 'FAILED', reasonCode: 'HOP_LIMIT_EXCEEDED' };
}
