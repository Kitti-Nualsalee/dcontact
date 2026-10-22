import type { PeopleWorkerClaim } from './tenant-people-worker.js';

export type PeopleActivationClaim = Pick<
  PeopleWorkerClaim,
  'tenantId' | 'operationId' | 'userId' | 'payloadDigest' | 'command'
>;

export type PeopleActivationOutcome =
  | { outcome: 'UNKNOWN' }
  | {
      outcome: 'PENDING' | 'VERIFIED';
      tenantId: string;
      operationId: string;
      userId: string;
      payloadDigest: string;
      probeRef: string;
      serverEpoch: number;
    };

export interface TenantPeopleActivationPort {
  readActivation(claim: PeopleActivationClaim): Promise<PeopleActivationOutcome>;
}
