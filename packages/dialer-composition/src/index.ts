import { ContactGovernanceService } from '@d-contact/contact-governance';
import type {
  ContactGovernancePort,
  ContactGovernanceRevalidationPort,
} from '@d-contact/cxa-contracts';
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
