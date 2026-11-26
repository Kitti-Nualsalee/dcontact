import type { ExpressionContext, ExpressionEvaluator } from '@d-contact/cxa-contracts';
import type { JourneyGraphStep } from './journey-definition.js';

/**
 * J5.2 (#340): the pure transition semantics of a single step — no I/O, no real clock
 *
 * the one set that both the runtime (`JourneyExecutionService`) and the authoring simulator use
 * so that a second executor never arises (stop condition #340) — if a node's behavior changes, it must change
 * here only, and both real runs and simulation change along with it at once
 */
export type JourneyStepPlan =
  | { readonly kind: 'EXIT' }
  | { readonly kind: 'WAIT'; readonly nextStepId: string; readonly wakeAt: Date }
  | { readonly kind: 'BRANCH'; readonly nextStepId: string; readonly branchResult: boolean }
  /** SEND stays at the existing cursor until the delivery hand-off completes, then moves to `next` */
  | { readonly kind: 'AWAIT_SEND'; readonly nextStepId: string }
  /** an owner action waits for the owner's result: accepted → `next`, rejected → `onReject` */
  | {
      readonly kind: 'AWAIT_OWNER';
      readonly acceptedStepId: string;
      readonly rejectedStepId: string;
    };

export interface PlanJourneyStepInput {
  readonly now: Date;
  readonly context: ExpressionContext;
  readonly evaluator: ExpressionEvaluator;
}

export function planJourneyStep(
  step: JourneyGraphStep,
  input: PlanJourneyStepInput,
): JourneyStepPlan {
  switch (step.type) {
    case 'EXIT':
      return { kind: 'EXIT' };
    case 'WAIT':
      return {
        kind: 'WAIT',
        nextStepId: step.next,
        wakeAt: new Date(input.now.getTime() + step.waitSeconds * 1_000),
      };
    case 'BRANCH': {
      const evaluation = input.evaluator.evaluate({
        document: step.expression,
        context: input.context,
        expectedType: 'boolean',
      });
      // a BRANCH that cannot be evaluated must fail closed to whenFalse, not stay stuck in place
      const branchResult = evaluation.status === 'OK' && evaluation.value === true;
      return {
        kind: 'BRANCH',
        nextStepId: branchResult ? step.whenTrue : step.whenFalse,
        branchResult,
      };
    }
    case 'SEND':
      return { kind: 'AWAIT_SEND', nextStepId: step.next };
    case 'ENSURE_CASE':
    case 'ADMIT_CAMPAIGN_TARGET':
    case 'SCHEDULE_CALLBACK':
      return { kind: 'AWAIT_OWNER', acceptedStepId: step.next, rejectedStepId: step.onReject };
  }
}

/** an owner result counted as success goes to `next`; REJECTED goes to `onReject` (J5.0 / Phase Contract §7) */
export function ownerResultNextStep(
  plan: Extract<JourneyStepPlan, { kind: 'AWAIT_OWNER' }>,
  outcome: 'ACCEPTED' | 'REJECTED',
): string {
  return outcome === 'ACCEPTED' ? plan.acceptedStepId : plan.rejectedStepId;
}
