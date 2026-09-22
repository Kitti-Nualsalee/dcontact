import type { ExpressionContext, ExpressionEvaluator } from '@d-contact/cxa-contracts';
import type { JourneyGraphStep } from './journey-definition.js';

/**
 * J5.2 (#340): transition semantics ของ step หนึ่งตัวแบบ pure — ไม่มี I/O, ไม่มี clock จริง
 *
 * เป็นชุดเดียวที่ทั้ง runtime (`JourneyExecutionService`) และ simulator ของ authoring ใช้
 * เพื่อไม่ให้เกิด executor ชุดที่สอง (stop condition #340) — ถ้าพฤติกรรมของ node เปลี่ยน ต้องเปลี่ยน
 * ที่นี่ที่เดียว แล้วทั้งการรันจริงและการจำลองเปลี่ยนตามพร้อมกัน
 */
export type JourneyStepPlan =
  | { readonly kind: 'EXIT' }
  | { readonly kind: 'WAIT'; readonly nextStepId: string; readonly wakeAt: Date }
  | { readonly kind: 'BRANCH'; readonly nextStepId: string; readonly branchResult: boolean }
  /** SEND หยุดที่ cursor เดิมจนกว่า delivery hand-off จะเสร็จ แล้วค่อยเดินไป `next` */
  | { readonly kind: 'AWAIT_SEND'; readonly nextStepId: string }
  /** owner action รอผลจาก owner: accepted → `next`, rejected → `onReject` */
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
      // BRANCH ที่ประเมินไม่ได้ต้อง fail closed ไปทาง whenFalse ไม่ใช่ค้างอยู่กับที่
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

/** owner result ที่ถือว่าสำเร็จเดิน `next`; REJECTED เดิน `onReject` (J5.0 / Phase Contract §7) */
export function ownerResultNextStep(
  plan: Extract<JourneyStepPlan, { kind: 'AWAIT_OWNER' }>,
  outcome: 'ACCEPTED' | 'REJECTED',
): string {
  return outcome === 'ACCEPTED' ? plan.acceptedStepId : plan.rejectedStepId;
}
