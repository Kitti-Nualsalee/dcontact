import { ContactGovernanceService } from '@d-contact/contact-governance';
import type {
  ContactGovernancePort,
  ContactGovernanceRevalidationPort,
  TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { IamTeamContactScopeAuthorizer } from '@d-contact/iam';
import type { PrismaClient } from '@d-contact/db';

/** Composition boundary: Dialer sees only the stable CG3 contract and does not import the service owner in domain code. */
export interface DialerRealtimeGovernancePorts {
  revalidation: ContactGovernanceRevalidationPort;
  settlement: ContactGovernancePort;
}

export function createDialerRealtimeGovernancePorts(
  database: PrismaClient,
): DialerRealtimeGovernancePorts {
  const governance = new ContactGovernanceService(database);
  return {
    revalidation: governance as unknown as ContactGovernanceRevalidationPort,
    settlement: governance,
  };
}

/**
 * J2.8 (#136): Dialer owner commands check the current team/contact scope through IAM — composition
 * is the only place that knows the concrete implementation, like the Governance port above
 */
export function createDialerOwnerScopeAuthorizer(
  database: PrismaClient,
): TeamContactScopeAuthorizer {
  return new IamTeamContactScopeAuthorizer(database);
}
