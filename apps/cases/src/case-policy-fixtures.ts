/**
 * J2.4 — tenant-scoped case-type dedupe/reopen/routing policy fixtures.
 *
 * Not a metadata-driven admin product (that is case-management.md's C2 phase,
 * out of scope here) — just enough durable fixture rows for `ENSURE_CASE` to
 * resolve `caseTypePolicyRef`/`routingPolicyRef` into a case type key, reopen
 * policy, and routing queue.
 */
import { randomUUID } from 'node:crypto';
import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';

export interface UpsertCaseTypePolicyInput {
  tenantId: string;
  policyRef: string;
  caseTypeKey: string;
  reopenAllowed: boolean;
}

export interface UpsertRoutingPolicyInput {
  tenantId: string;
  policyRef: string;
  queueRef: string;
}

export class CasePolicyFixtures {
  constructor(private readonly database: PrismaClient) {}

  upsertCaseTypePolicy(input: UpsertCaseTypePolicyInput) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      transaction.csCaseTypePolicy.upsert({
        where: {
          tenantId_policyRef: { tenantId: input.tenantId, policyRef: input.policyRef },
        },
        create: {
          id: randomUUID(),
          tenantId: input.tenantId,
          policyRef: input.policyRef,
          caseTypeKey: input.caseTypeKey,
          reopenAllowed: input.reopenAllowed,
        },
        update: { caseTypeKey: input.caseTypeKey, reopenAllowed: input.reopenAllowed },
      }),
    );
  }

  upsertRoutingPolicy(input: UpsertRoutingPolicyInput) {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      transaction.csRoutingPolicy.upsert({
        where: { tenantId_policyRef: { tenantId: input.tenantId, policyRef: input.policyRef } },
        create: {
          id: randomUUID(),
          tenantId: input.tenantId,
          policyRef: input.policyRef,
          queueRef: input.queueRef,
        },
        update: { queueRef: input.queueRef },
      }),
    );
  }
}
