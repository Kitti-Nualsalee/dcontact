import type {
  AuthorizeTeamContactScopeInput,
  TeamContactScopeAuthorization,
  TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

/**
 * Runtime IAM authority. It resolves segment membership from IAM's canonical
 * projection; callers supply a contact identifier only and cannot assert membership.
 */
export class IamTeamContactScopeAuthorizer implements TeamContactScopeAuthorizer {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authorize(input: AuthorizeTeamContactScopeInput): Promise<TeamContactScopeAuthorization> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const evaluatedAt = this.now().toISOString();
      const team = await transaction.team.findFirst({
        where: { id: input.teamId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (!team) return { decision: 'DENY', reasonCode: 'TEAM_NOT_FOUND', evaluatedAt };

      const contact = await transaction.contact.findFirst({
        where: { id: input.contactId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (!contact) return { decision: 'DENY', reasonCode: 'CONTACT_NOT_FOUND', evaluatedAt };

      const version = await transaction.iamTeamScopeVersion.findUnique({
        where: { tenantId_teamId: { tenantId: input.tenantId, teamId: input.teamId } },
        select: { scopeVersion: true },
      });
      const active = await transaction.iamTeamSegmentScopeActiveGrant.findMany({
        where: {
          tenantId: input.tenantId,
          teamId: input.teamId,
          permission: input.permission,
        },
        select: { segmentId: true },
      });
      if (active.length === 0) {
        return { decision: 'DENY', reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED', evaluatedAt };
      }

      const projections = await transaction.iamContactSegmentScopeProjection.findMany({
        where: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          segmentId: { in: active.map((grant) => grant.segmentId) },
        },
        select: { segmentId: true, state: true },
      });
      if (projections.some((projection) => projection.state === 'IN')) {
        return { decision: 'ALLOW', scopeVersion: version?.scopeVersion ?? 0, evaluatedAt };
      }
      if (
        projections.length !== active.length ||
        projections.some((projection) => projection.state === 'INVALIDATED')
      ) {
        return { decision: 'DEFER', reasonCode: 'SCOPE_CONTEXT_STALE', evaluatedAt };
      }
      return { decision: 'DENY', reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED', evaluatedAt };
    });
  }
}
