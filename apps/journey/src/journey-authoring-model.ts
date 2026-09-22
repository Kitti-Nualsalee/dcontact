import {
  JOURNEY_AUTHORING_HTTP_STATUS,
  JOURNEY_LIFECYCLE_TRANSITIONS,
  type JourneyAuthoringAuthentication,
  type JourneyAuthoringErrorCode,
  type JourneyDiagnosticV1,
  type JourneyLifecycle,
  type JourneySafeParams,
} from '@d-contact/cxa-contracts';

/**
 * J5.2 (#340): error, state guard และ port ของ authoring ที่ไม่มี I/O
 */

export class JourneyAuthoringError extends Error {
  constructor(
    readonly code: JourneyAuthoringErrorCode,
    readonly safeParams?: JourneySafeParams,
    readonly diagnostics?: readonly JourneyDiagnosticV1[],
  ) {
    super(`journey authoring: ${code}`);
    this.name = 'JourneyAuthoringError';
  }

  get httpStatus(): number {
    return JOURNEY_AUTHORING_HTTP_STATUS[this.code];
  }

  /**
   * ผลที่ deterministic ต่อ request เดิม (auth/validation/conflict) ถูกจำไว้ใน receipt เพื่อให้ key เดิม
   * ได้คำตอบเดิม — ส่วน 404/503 อาจเปลี่ยนได้เมื่อ retry จึงไม่จำ
   */
  get storedInReceipt(): boolean {
    return [403, 409, 422].includes(this.httpStatus);
  }
}

export function assertJourneyLifecycleTransition(from: JourneyLifecycle, to: JourneyLifecycle) {
  if (!(JOURNEY_LIFECYCLE_TRANSITIONS[from] as readonly JourneyLifecycle[]).includes(to)) {
    throw new JourneyAuthoringError('JOURNEY_LIFECYCLE_CONFLICT', { from, to });
  }
}

/** PAUSED/DEPRECATED หยุด enrollment ใหม่เท่านั้น; enrollment เดิมเดินต่อจนจบ (Phase Contract §5) */
export function lifecycleAcceptsNewEnrollments(lifecycle: JourneyLifecycle | undefined): boolean {
  return lifecycle !== 'PAUSED' && lifecycle !== 'DEPRECATED';
}

export type {
  JourneyAuthoringAuthorizationDecision as JourneyAuthorizationDecision,
  JourneyAuthoringAuthorizationPort,
} from '@d-contact/cxa-contracts';

export interface JourneyAuthoringActor {
  readonly subjectId: string;
  readonly correlationId: string;
  /** จาก verified token เท่านั้น — ใช้ตัดสิน strong/recent auth ไม่ใช่ใช้แทน authorization */
  readonly authentication?: JourneyAuthoringAuthentication;
}

/** env kill switch ของแต่ละ feature — effective = env AND tenant rollout field (Phase Spec §9) */
export interface JourneyAuthoringFeatureFlags {
  readonly canvasWrite: boolean;
  readonly publishUi: boolean;
}

export function journeyAuthoringFlagsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): JourneyAuthoringFeatureFlags {
  return {
    canvasWrite: environment.J5_CANVAS_WRITE_ENABLED === 'true',
    publishUi: environment.J5_PUBLISH_UI_ENABLED === 'true',
  };
}
