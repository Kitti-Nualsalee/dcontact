import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  cg4DelegationId,
  cg4SubjectId,
  tenantId as tenantIdBrand,
  type Cg4AuthorizationPort,
  type Cg4AuthorizationSubject,
  type Cg4Capability,
  type Cg4CapabilityGrant,
  type ResolveCg4AuthorizationSubjectInput,
} from '@d-contact/cxa-contracts';

/**
 * CG4.7 (#190): resolves a `Cg4AuthorizationSubject` from canonical state.
 *
 * CG4.3 declared `Cg4AuthorizationPort` as IAM's boundary; this repository has no IAM
 * service, so the canonical state is `cg_authorization_subject` + `cg_capability_grant`,
 * with live delegations folded in from `cg_delegation`. Callers never pass capabilities
 * in — a request body or a gateway role can say who is asking, never what they may do
 * (#173 §1). Replacing this adapter with a real IAM client changes nothing above it.
 *
 * Returns `null` for an unknown subject so every caller fails closed.
 */
export class Cg4DatabaseAuthorizationPort implements Cg4AuthorizationPort {
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async resolveSubject(
    input: ResolveCg4AuthorizationSubjectInput,
  ): Promise<Cg4AuthorizationSubject | null> {
    const now = this.now();
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const subject = await transaction.cg4AuthorizationSubject.findUnique({
        where: {
          tenantId_subjectId: { tenantId: input.tenantId, subjectId: input.subjectId },
        },
      });
      if (!subject) return null;

      const [grants, delegations] = await Promise.all([
        transaction.cg4CapabilityGrant.findMany({
          where: {
            tenantId: input.tenantId,
            subjectId: input.subjectId,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        }),
        transaction.cg4Delegation.findMany({
          where: {
            tenantId: input.tenantId,
            delegateSubjectId: input.subjectId,
            startsAt: { lte: now },
            expiresAt: { gt: now },
          },
        }),
      ]);

      const capabilities: Cg4CapabilityGrant[] = [
        ...grants.map((grant) => ({
          capability: grant.capability as Cg4Capability,
          scopeKey: grant.scopeKey,
          source: 'DIRECT' as const,
          ...(grant.expiresAt ? { expiresAt: grant.expiresAt.toISOString() } : {}),
        })),
        ...delegations.map((delegation) => ({
          capability: delegation.capability as Cg4Capability,
          scopeKey: delegation.scopeKey,
          source: 'DELEGATED' as const,
          delegationId: cg4DelegationId(delegation.id),
          expiresAt: delegation.expiresAt.toISOString(),
        })),
      ];

      return {
        subjectId: cg4SubjectId(subject.subjectId),
        tenantId: tenantIdBrand(subject.tenantId),
        authenticationStrength: subject.authenticationStrength,
        capabilities,
        // Standing IAM authority, never grantable by delegation (#173 §2).
        directComplianceAuthority: subject.directComplianceAuthority,
        emergencyAuthority: subject.emergencyAuthority,
        authorizationEpoch: subject.authorizationEpoch,
        scopeVersion: subject.scopeVersion,
        evaluatedAt: now.toISOString(),
      };
    });
  }

  /** IAM-attested facts the delegation repository cannot derive from a grant alone. */
  async describeDelegationEligibility(input: {
    tenantId: string;
    delegatorSubjectId: string;
    delegateSubjectId: string;
    capability: Cg4Capability;
    scopeKey: string;
  }): Promise<{ delegatorHoldsCapabilityDirectly: boolean; delegateIsServicePrincipal: boolean }> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const [direct, delegate] = await Promise.all([
        transaction.cg4CapabilityGrant.findFirst({
          where: {
            tenantId: input.tenantId,
            subjectId: input.delegatorSubjectId,
            capability: input.capability,
            scopeKey: input.scopeKey,
          },
          select: { id: true },
        }),
        transaction.cg4AuthorizationSubject.findUnique({
          where: {
            tenantId_subjectId: {
              tenantId: input.tenantId,
              subjectId: input.delegateSubjectId,
            },
          },
          select: { isServicePrincipal: true },
        }),
      ]);
      return {
        delegatorHoldsCapabilityDirectly: direct !== null,
        // An unknown delegate is treated as ineligible rather than as a person.
        delegateIsServicePrincipal: delegate?.isServicePrincipal ?? true,
      };
    });
  }
}
