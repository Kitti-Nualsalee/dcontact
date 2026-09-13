import {
  ContactGovernanceService,
  type ContactGovernanceServiceOptions,
} from '@d-contact/contact-governance';
import {
  contactId,
  identityId,
  tenantId,
  type ContactAuthorizationPort,
  type ContactGovernancePort,
  type ContactGovernanceRevalidationPort,
  type CustomerContextReader,
  type CustomerIdentityResolver,
  type TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import {
  Prisma,
  type IdentityType,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

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
  // package นี้อาจถูก build ก่อน Contact Governance ใน local incremental build;
  // runtime object เดียวกัน implements contract ทั้งสองตาม source owner.
  return {
    revalidation: governance as unknown as ContactGovernanceRevalidationPort,
    settlement: governance,
  };
}

/**
 * composition root ชั่วคราวของ E0.6: Journey รับเพียง narrow ports;
 * concrete domain services และ database adapters อยู่นอก Journey app.
 */
export function createJourneyFoundationPorts(
  database: PrismaClient,
  options: JourneyFoundationPortOptions = {},
): JourneyFoundationPorts {
  return {
    customerContextReader: new PrismaCustomerContextReader(database),
    teamContactScopeAuthorizer: new PrismaTeamContactScopeAuthorizer(database),
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
    // E0.6 ยังไม่มี authoritative mapping ของ CRM_ID จึงรักษา REVIEW path เดิมไว้
    // แทนการปล่อย identifier ที่ยังยืนยันไม่ได้ไปยัง Contact Governance.
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

/** J2.7 composition boundary: outcome trigger processing รับเพียง narrow ports เช่นเดียวกับ #135 */
export interface JourneyOutcomeTriggerPorts {
  identityResolver: CustomerIdentityResolver<Prisma.TransactionClient>;
  teamContactScopeAuthorizer: TeamContactScopeAuthorizer<Prisma.TransactionClient>;
}

export function createJourneyOutcomeTriggerPorts(
  database: PrismaClient,
): JourneyOutcomeTriggerPorts {
  return {
    identityResolver: new PrismaCustomerIdentityResolver(database),
    teamContactScopeAuthorizer: new PrismaTeamContactScopeAuthorizer(database),
  };
}

class PrismaCustomerIdentityResolver implements CustomerIdentityResolver<Prisma.TransactionClient> {
  constructor(private readonly database: PrismaClient) {}

  async resolveByContactId(
    input: Parameters<CustomerIdentityResolver<Prisma.TransactionClient>['resolveByContactId']>[0],
    transaction?: Prisma.TransactionClient,
  ) {
    const resolve = async (client: Prisma.TransactionClient) => {
      const contact = await client.contact.findFirst({
        where: { id: input.contactId, tenantId: input.tenantId },
        select: { id: true },
      });
      // E0/J2 ยังไม่มี contact-merge ledger จึงยังไม่มี survivor ต่างจาก input จริง —
      // ปฏิบัติเหมือน PrismaTeamContactScopeAuthorizer: ซื่อสัตย์ต่อ capability ปัจจุบัน
      // แทนที่จะ fake merge resolution ที่ระบบยังไม่รองรับ
      return contact
        ? {
            status: 'RESOLVED' as const,
            contactId: contactId(contact.id),
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

class PrismaTeamContactScopeAuthorizer implements TeamContactScopeAuthorizer<Prisma.TransactionClient> {
  constructor(private readonly database: PrismaClient) {}

  async authorize(
    input: Parameters<TeamContactScopeAuthorizer<Prisma.TransactionClient>['authorize']>[0],
    transaction?: Prisma.TransactionClient,
  ) {
    const authorize = async (client: Prisma.TransactionClient) => {
      const [team, contact] = await Promise.all([
        client.team.findFirst({
          where: { id: input.teamId, tenantId: input.tenantId },
          select: { id: true },
        }),
        client.contact.findFirst({
          where: { id: input.contactId, tenantId: input.tenantId },
          select: { id: true },
        }),
      ]);
      if (!team) {
        return {
          decision: 'DENY' as const,
          reasonCode: 'TEAM_NOT_FOUND' as const,
          evaluatedAt: input.at,
        };
      }
      if (!contact) {
        return {
          decision: 'DENY' as const,
          reasonCode: 'CONTACT_NOT_FOUND' as const,
          evaluatedAt: input.at,
        };
      }

      // E0 ยังไม่มี persisted team-to-segment grants จึงต้อง fail closed จนกว่า IAM
      // จะส่ง adapter ที่มี trusted scope grant มาแทนที่.
      return {
        decision: 'DENY' as const,
        reasonCode: 'TEAM_SEGMENT_NOT_ALLOWED' as const,
        evaluatedAt: input.at,
      };
    };
    return transaction
      ? authorize(transaction)
      : withTenantDatabaseTransaction(this.database, tenantId(input.tenantId), authorize);
  }
}
