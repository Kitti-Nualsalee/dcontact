import type { ContactId, TeamId, TenantId } from './identifiers.js';

export type ContactScopePermission = 'CONTACT';

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

export type TeamContactScopeAuthorization = AllowedTeamContactScope | DeniedTeamContactScope;

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
