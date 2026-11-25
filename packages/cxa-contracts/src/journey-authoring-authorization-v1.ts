/**
 * J5.3 (#341): authorization port for Journey authoring (decision #331 §1, §4, §6, §10, §13)
 *
 * IAM is the single authority: every mutation/review/publish/lifecycle resolves the subject, grant, delegation,
 * team active-state, authorization epoch and scope version afresh from the current store in the same transaction as
 * the command; role/team/capability from a token or browser is not authority (stop condition #341)
 */
import type { JourneyAuthoringErrorCode } from './journey-authoring-errors-v1.js';
import type { JourneyAuthoringCapability } from './journey-authoring-v1.js';

/** presence is only an advisory soft lease: it grants no permission and is not a lock (#331 §7) */
export const JOURNEY_PRESENCE_TTL_SECONDS = 60;
export const JOURNEY_PRESENCE_HEARTBEAT_SECONDS = 20;

/** strong auth must be fresh enough for a unilateral publish (#331 §10) */
export const JOURNEY_STRONG_AUTH_MAX_AGE_SECONDS = 10 * 60;

export interface JourneyAuthoringAuthentication {
  readonly strength: 'STANDARD' | 'STRONG';
  /** authentication time from the verified token (`auth_time`): evidence of authentication, not authorization */
  readonly authenticatedAt: string;
}

export interface JourneyAuthoringAuthorizationScope {
  /** the owner team always comes from the canonical head, not a value sent by the client */
  readonly teamId: string;
  /** a resource that a narrow, object-level delegation can reference */
  readonly resource?: { readonly kind: 'JOURNEY' | 'TEMPLATE'; readonly id: string };
}

export interface JourneyAuthoringAuthorizationRequest {
  readonly tenantId: string;
  readonly subjectId: string;
  readonly capability: JourneyAuthoringCapability;
  readonly scope: JourneyAuthoringAuthorizationScope;
  /** approve/publish/lifecycle/transfer/audit cannot use a delegation */
  readonly requireDirect?: boolean;
  /** pause/deprecate/transfer are allowed even when the team is inactive; edit/review/publish/resume are not */
  readonly allowInactiveTeam?: boolean;
  /**
   * a template with visibility = TENANT can be read by anyone in the tenant who holds this capability in any scope
   * (#330 §2): used with read capabilities only
   */
  readonly anyTeam?: boolean;
}

export type JourneyAuthoringAuthorizationDecision =
  | {
      readonly allowed: true;
      readonly source: 'DIRECT' | 'DELEGATION';
      readonly delegationId: string | null;
      readonly authorizationEpoch: number;
      readonly scopeVersion: number;
      readonly directReviewAuthority: boolean;
      readonly authenticationStrength: 'STANDARD' | 'STRONG';
    }
  | { readonly allowed: false; readonly code: JourneyAuthoringErrorCode };

export interface JourneyAuthoringAuthorizationPort<TTransaction = unknown> {
  authorize(
    transaction: TTransaction,
    request: JourneyAuthoringAuthorizationRequest,
  ): Promise<JourneyAuthoringAuthorizationDecision>;
}
