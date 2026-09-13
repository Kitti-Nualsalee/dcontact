import type { ContactId, TeamId, TenantId } from './identifiers.js';

/**
 * `WORK` is additive for J2 (#122): a cross-team owner-command checkpoint distinct
 * from the C1 `CONTACT` outbound-send permission. Adding it does not change what
 * `CONTACT` means or how existing C1 callers evaluate it.
 */
export type ContactScopePermission = 'CONTACT' | 'WORK';

export interface AuthorizeTeamContactScopeInput {
  tenantId: TenantId;
  teamId: TeamId;
  contactId: ContactId;
  permission: ContactScopePermission;
  at: string;
}

export interface AllowedTeamContactScope {
  decision: 'ALLOW';
  /** Version of the trusted IAM scope evaluation that authorized this request. */
  scopeVersion: number;
  evaluatedAt: string;
}

export interface DeniedTeamContactScope {
  decision: 'DENY';
  reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED' | 'TEAM_NOT_FOUND' | 'CONTACT_NOT_FOUND';
  evaluatedAt: string;
}

/**
 * Additive for J2 (#122): current membership/scope projection is stale or could not
 * be refreshed. This must never be treated as `ALLOW` after a later refresh — the
 * caller retries authorization from scratch instead of caching this result.
 */
export interface DeferredTeamContactScope {
  decision: 'DEFER';
  reasonCode: 'SCOPE_CONTEXT_STALE';
  evaluatedAt: string;
}

export type TeamContactScopeAuthorization =
  AllowedTeamContactScope | DeniedTeamContactScope | DeferredTeamContactScope;

/**
 * IAM owns this authorization boundary. It must resolve current membership and
 * trusted team scope itself; callers cannot pass a segment or membership to be
 * treated as authorization evidence.
 */
export interface TeamContactScopeAuthorizer<TContext = undefined> {
  authorize(
    input: AuthorizeTeamContactScopeInput,
    context?: TContext,
  ): Promise<TeamContactScopeAuthorization>;
}
