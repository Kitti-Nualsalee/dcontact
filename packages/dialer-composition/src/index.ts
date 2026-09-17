import { ContactGovernanceService } from '@d-contact/contact-governance';
import type {
  ContactGovernancePort,
  ContactGovernanceRevalidationPort,
  TeamContactScopeAuthorizer,
} from '@d-contact/cxa-contracts';
import { IamTeamContactScopeAuthorizer } from '@d-contact/iam';
import type { PrismaClient } from '@d-contact/db';

/** composition boundary: Dialer เห็นเฉพาะ CG3 contract ที่เสถียร ไม่ import service owner ใน domain code. */
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
 * J2.8 (#136): owner command ของ Dialer ตรวจ current team/contact scope ผ่าน IAM — composition
 * เป็นจุดเดียวที่รู้ concrete implementation เหมือน Governance port ด้านบน
 */
export function createDialerOwnerScopeAuthorizer(
  database: PrismaClient,
): TeamContactScopeAuthorizer {
  return new IamTeamContactScopeAuthorizer(database);
}
