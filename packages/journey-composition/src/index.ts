import {
  ContactGovernanceService,
  type ContactGovernanceServiceOptions,
} from '@d-contact/contact-governance';
import {
  contactId,
  identityId,
  type ContactAuthorizationPort,
  type ContactGovernancePort,
  type ContactGovernanceRevalidationPort,
  type CustomerContextReader,
  type CustomerIdentityResolver,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import {
  legacyIdentityEligibility,
  Prisma,
  type IdentityType,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import { IamTeamContactScopeAuthorizer } from '@d-contact/iam';

export interface JourneyFoundationPorts {
  customerContextReader: CustomerContextReader<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
  contactAuthorizationPort: ContactAuthorizationPort<Prisma.TransactionClient>;
}

export interface JourneyFoundationPortOptions {
  contactGovernance?: ContactGovernanceServiceOptions;
}

/** S1.5 composition boundary: Journey runtime receives only stable cross-domain ports. */
export interface JourneyRealtimeGovernancePorts {
  revalidation: ContactGovernanceRevalidationPort;
  settlement: ContactGovernancePort;
}

export function createJourneyRealtimeGovernancePorts(
  database: PrismaClient,
  options: JourneyFoundationPortOptions = {},
): JourneyRealtimeGovernancePorts {
  const governance = new ContactGovernanceService(database, options.contactGovernance);
  // This package may be built before Contact Governance in a local incremental build;
  // the same runtime object implements both contracts per the source owner.
  return {
    revalidation: governance as unknown as ContactGovernanceRevalidationPort,
    settlement: governance,
  };
}

/**
 * Temporary composition root of E0.6: Journey receives only narrow ports;
 * concrete domain services and database adapters live outside the Journey app.
 */
export function createJourneyFoundationPorts(
  database: PrismaClient,
  options: JourneyFoundationPortOptions = {},
): JourneyFoundationPorts {
  return {
    customerContextReader: new PrismaCustomerContextReader(database),
    teamContactScopeAuthorizer: new IamTeamContactScopeAuthorizer(database),
    contactAuthorizationPort: new ContactGovernanceService(database, options.contactGovernance),
  };
}

class PrismaCustomerContextReader implements CustomerContextReader<Prisma.TransactionClient> {
  constructor(private readonly database: PrismaClient) {}

  async resolveCurrentContext(
    input: Parameters<CustomerContextReader<Prisma.TransactionClient>['resolveCurrentContext']>[0],
    transaction?: Prisma.TransactionClient,
  ) {
    const contactRef = input.contactRef;
    const identityType = contactRef.kind === 'CRM_ID' ? undefined : contactRef.kind;
    // E0.6 has no authoritative mapping of CRM_ID yet, so the existing REVIEW path is kept
    // instead of releasing an identifier that cannot yet be verified to Contact Governance.
    if (!identityType) {
      return { status: 'AMBIGUOUS' as const, reasonCode: 'IDENTITY_AMBIGUOUS' as const };
    }

    const resolve = async (client: Prisma.TransactionClient) => {
      const identity = await client.contactIdentity.findUnique({
        where: {
          tenantId_type_value: {
            tenantId: input.tenantId,
            type: identityType as IdentityType,
            value: contactRef.value,
          },
        },
        select: { id: true, contactId: true },
      });
      if (!identity)
        return { status: 'NOT_FOUND' as const, reasonCode: 'IDENTITY_NOT_FOUND' as const };
      // C3 (#793) bridge: a raw unique match is not a verified identity; PHONE/EMAIL need a contact point
      // imported from this identity and still ACTIVE; the same value on several contacts = AMBIGUOUS
      if (identityType === 'PHONE' || identityType === 'EMAIL') {
        const eligibility = await legacyIdentityEligibility(client, input.tenantId, identity.id);
        if (eligibility === 'SHARED')
          return { status: 'AMBIGUOUS' as const, reasonCode: 'IDENTITY_AMBIGUOUS' as const };
        // Not yet imported: must not decide a permanent NOT_FOUND during rollout; let the consumer retry after import
        if (eligibility === 'UNMAPPED')
          return { status: 'DEFERRED' as const, reasonCode: 'IDENTITY_MAPPING_PENDING' as const };
        if (eligibility !== 'ELIGIBLE')
          return { status: 'NOT_FOUND' as const, reasonCode: 'IDENTITY_NOT_FOUND' as const };
      }
      return identity
        ? {
            status: 'RESOLVED' as const,
            contactId: contactId(identity.contactId),
            identityId: identityId(identity.id),
            segmentMemberships: [],
            snapshotVersion: 1,
            evaluatedAt: input.at,
          }
        : { status: 'NOT_FOUND' as const, reasonCode: 'IDENTITY_NOT_FOUND' as const };
    };

    return transaction
      ? resolve(transaction)
      : withTenantDatabaseTransaction(this.database, input.tenantId, resolve);
  }
}

/** J2.7 composition boundary: outcome trigger processing receives only narrow ports, as in #135 */
export interface JourneyOutcomeTriggerPorts {
  identityResolver: CustomerIdentityResolver<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
}

export function createJourneyOutcomeTriggerPorts(
  database: PrismaClient,
): JourneyOutcomeTriggerPorts {
  return {
    identityResolver: new PrismaCustomerIdentityResolver(database),
    teamContactScopeAuthorizer: new IamTeamContactScopeAuthorizer(database),
  };
}

class PrismaCustomerIdentityResolver implements CustomerIdentityResolver<Prisma.TransactionClient> {
  constructor(private readonly database: PrismaClient) {}

  async resolveByContactId(
    input: Parameters<CustomerIdentityResolver<Prisma.TransactionClient>['resolveByContactId']>[0],
    transaction?: Prisma.TransactionClient,
  ) {
    const notFound = { status: 'NOT_FOUND' as const, reasonCode: 'IDENTITY_NOT_FOUND' as const };
    const ambiguous = { status: 'AMBIGUOUS' as const, reasonCode: 'IDENTITY_AMBIGUOUS' as const };
    const resolve = async (client: Prisma.TransactionClient) => {
      const contact = await client.contact.findFirst({
        where: { id: input.contactId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (!contact) return notFound;

      /**
       * The Customer 360 identity head (J3) is the authority for merge/split/unmerge — the head stores
       * a flattened canonical pointer (repointMergeChain), so reading one level is enough.
       * No head = the contact never went through any identity operation, so it is its own survivor
       */
      const head = await client.c360IdentityHead.findUnique({
        where: { tenantId_contactId: { tenantId: input.tenantId, contactId: input.contactId } },
        select: { state: true, canonicalContactId: true, lineageRevision: true },
      });
      const resolved = (survivorId: string, lineageRevision: number) => ({
        status: 'RESOLVED' as const,
        contactId: contactId(survivorId),
        ...(survivorId !== input.contactId
          ? { originalContactId: contactId(input.contactId) }
          : {}),
        segmentMemberships: [],
        snapshotVersion: lineageRevision + 1,
        evaluatedAt: input.at,
      });
      if (!head) return resolved(input.contactId, 0);
      if (head.state === 'AMBIGUOUS') return ambiguous;
      if (head.state === 'ACTIVE') {
        return head.canonicalContactId === input.contactId
          ? resolved(input.contactId, head.lineageRevision)
          : ambiguous;
      }

      // MERGED: the survivor must still be ACTIVE and point to itself in the same tenant — if the chain is not yet stable
      // (the survivor was merged/made ambiguous further), treat it as not yet resolvable and do not guess the survivor
      const survivor = await client.c360IdentityHead.findUnique({
        where: {
          tenantId_contactId: { tenantId: input.tenantId, contactId: head.canonicalContactId },
        },
        select: { state: true, canonicalContactId: true },
      });
      // A survivor without a head = never went through an identity operation itself; the head FK guarantees that
      // the canonical contact is in the same tenant, so there is no way to redirect across tenants
      if (
        survivor &&
        (survivor.state !== 'ACTIVE' || survivor.canonicalContactId !== head.canonicalContactId)
      ) {
        return ambiguous;
      }
      return resolved(head.canonicalContactId, head.lineageRevision);
    };
    return transaction
      ? resolve(transaction)
      : withTenantDatabaseTransaction(this.database, input.tenantId, resolve);
  }
}
