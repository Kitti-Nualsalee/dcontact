import type {
  AuthorizeTeamContactScopeInput,
  AuthorizeTeamSegmentConfigurationInput,
  TeamContactScopeAuthorization,
  TeamContactScopeAuthorizer,
  TeamSegmentConfigurationAuthorization,
  TeamSegmentConfigurationAuthorizer,
} from '@d-contact/cxa-contracts';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

type ScopeTransaction = Prisma.TransactionClient;

export class IamTeamContactScopeAuthorizer implements TeamContactScopeAuthorizer<ScopeTransaction> {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authorize(
    input: AuthorizeTeamContactScopeInput,
    context?: ScopeTransaction,
  ): Promise<TeamContactScopeAuthorization> {
    if (context) return this.evaluate(context, input);
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      this.evaluate(transaction, input),
    );
  }

  private async evaluate(
    transaction: ScopeTransaction,
    input: AuthorizeTeamContactScopeInput,
  ): Promise<TeamContactScopeAuthorization> {
    const evaluatedAt = this.now().toISOString();
    const team = await transaction.team.findFirst({
      where: { id: input.teamId, tenantId: input.tenantId, isActive: true },
      select: { id: true },
    });
    if (!team) return { decision: 'DENY', reasonCode: 'TEAM_NOT_FOUND', evaluatedAt };
    const contact = await transaction.contact.findFirst({
      where: { id: input.contactId, tenantId: input.tenantId },
      select: { id: true },
    });
    if (!contact) return { decision: 'DENY', reasonCode: 'CONTACT_NOT_FOUND', evaluatedAt };
    const grants = await transaction.iamTeamSegmentScopeActiveGrant.findMany({
      where: { tenantId: input.tenantId, teamId: input.teamId, permission: input.permission },
      select: { segmentId: true },
    });
    if (grants.length === 0) {
      return { decision: 'DENY', reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED', evaluatedAt };
    }
    const projections = await transaction.iamContactSegmentScopeProjection.findMany({
      where: {
        tenantId: input.tenantId,
        contactId: input.contactId,
        segmentId: { in: grants.map((grant) => grant.segmentId) },
      },
      select: { state: true },
    });
    if (projections.some((projection) => projection.state === 'IN')) {
      const version = await transaction.iamTeamScopeVersion.findUnique({
        where: { tenantId_teamId: { tenantId: input.tenantId, teamId: input.teamId } },
        select: { scopeVersion: true },
      });
      return { decision: 'ALLOW', scopeVersion: version?.scopeVersion ?? 0, evaluatedAt };
    }
    if (
      projections.length !== grants.length ||
      projections.some((projection) => projection.state === 'INVALIDATED')
    ) {
      return { decision: 'DEFER', reasonCode: 'SCOPE_CONTEXT_STALE', evaluatedAt };
    }
    return { decision: 'DENY', reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED', evaluatedAt };
  }
}

export class IamTeamSegmentConfigurationAuthorizer implements TeamSegmentConfigurationAuthorizer<ScopeTransaction> {
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authorizeConfiguration(
    input: AuthorizeTeamSegmentConfigurationInput,
    context?: ScopeTransaction,
  ): Promise<TeamSegmentConfigurationAuthorization> {
    if (context) return this.evaluate(context, input);
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      this.evaluate(transaction, input),
    );
  }

  private async evaluate(
    transaction: ScopeTransaction,
    input: AuthorizeTeamSegmentConfigurationInput,
  ): Promise<TeamSegmentConfigurationAuthorization> {
    const evaluatedAt = this.now().toISOString();
    const team = await transaction.team.findFirst({
      where: { id: input.teamId, tenantId: input.tenantId, isActive: true },
      select: { id: true },
    });
    if (!team) return { decision: 'DENY', reasonCode: 'TEAM_NOT_FOUND', evaluatedAt };
    const grant = await transaction.iamTeamSegmentScopeActiveGrant.findUnique({
      where: {
        tenantId_teamId_segmentId_permission: {
          tenantId: input.tenantId,
          teamId: input.teamId,
          segmentId: input.segmentId,
          permission: input.permission,
        },
      },
    });
    if (!grant) return { decision: 'DENY', reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED', evaluatedAt };
    const version = await transaction.iamTeamScopeVersion.findUniqueOrThrow({
      where: { tenantId_teamId: { tenantId: input.tenantId, teamId: input.teamId } },
      select: { scopeVersion: true },
    });
    return { decision: 'ALLOW', scopeVersion: version.scopeVersion, evaluatedAt };
  }
}
