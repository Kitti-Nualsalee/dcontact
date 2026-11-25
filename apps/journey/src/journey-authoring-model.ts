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
 * J5.2 (#340): errors, state guards and ports of authoring that have no I/O
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
   * Results that are deterministic for the same request (auth/validation/conflict) are remembered in the receipt so the same key
   * gets the same answer — 404/503 may change on retry so they are not remembered
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

/** PAUSED/DEPRECATED only stop new enrollment; existing enrollments continue to the end (Phase Contract §5) */
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
  /** From a verified token only — used to decide strong/recent auth, not as a substitute for authorization */
  readonly authentication?: JourneyAuthoringAuthentication;
}

/** Env kill switch of each feature — effective = env AND tenant rollout field (Phase Spec §9) */
export interface JourneyAuthoringFeatureFlags {
  readonly canvasWrite: boolean;
  readonly publishUi: boolean;
  readonly templateCatalog?: boolean;
  readonly templateUpgrade?: boolean;
}

export function journeyAuthoringFlagsFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): JourneyAuthoringFeatureFlags {
  return {
    canvasWrite: environment.J5_CANVAS_WRITE_ENABLED === 'true',
    publishUi: environment.J5_PUBLISH_UI_ENABLED === 'true',
    templateCatalog: environment.J5_TEMPLATE_CATALOG_ENABLED === 'true',
    templateUpgrade: environment.J5_TEMPLATE_UPGRADE_ENABLED === 'true',
  };
}
