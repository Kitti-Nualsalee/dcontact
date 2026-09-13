import { randomUUID } from 'node:crypto';
import { type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { Cg4Capability } from '@d-contact/cxa-contracts';
import { assertCg4DelegationGrantAllowed } from './cg4-authorization-engine.js';
import { Cg3IdempotencyConflictError, stableDigest } from './cg3-persistence.js';

/**
 * CG4.3 (#186): append-only delegation grants (#173 §3). Only IAM-attested facts
 * (`delegatorHoldsCapabilityDirectly`, `delegateIsServicePrincipal`) let this repository
 * enforce "no recursive/sub-delegation" and "no shared/service checker" — it has no way
 * to derive those from the grant alone, so it trusts the caller to have resolved them
 * from the current IAM/team-scope port, the same way `Cg4AuthorizationPort` does for
 * approval authorization.
 */

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
  return normalized;
}

function instant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} ต้องเป็น ISO-8601 timestamp`);
  return parsed;
}

export interface GrantCg4DelegationInput {
  tenantId: string;
  delegatorSubjectId: string;
  delegateSubjectId: string;
  delegatorHoldsCapabilityDirectly: boolean;
  delegateIsServicePrincipal: boolean;
  capability: Cg4Capability;
  scopeKey: string;
  grantVersion: number;
  startsAt: string;
  expiresAt: string;
  idempotencyKey: string;
}

export interface Cg4DelegationView {
  delegationId: string;
  tenantId: string;
  delegatorSubjectId: string;
  delegateSubjectId: string;
  capability: Cg4Capability;
  scopeKey: string;
  grantVersion: number;
  startsAt: string;
  expiresAt: string;
  createdAt: string;
}

export interface Cg4DelegationRepositoryOptions {
  id?: () => string;
}

export class Cg4DelegationRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: Cg4DelegationRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  async grant(input: GrantCg4DelegationInput): Promise<Cg4DelegationView> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.delegatorSubjectId, 'delegatorSubjectId');
    nonEmpty(input.delegateSubjectId, 'delegateSubjectId');
    nonEmpty(input.scopeKey, 'scopeKey');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    if (!Number.isInteger(input.grantVersion) || input.grantVersion < 1) {
      throw new RangeError('grantVersion ต้องเป็น positive integer');
    }
    const startsAt = instant(input.startsAt, 'startsAt');
    const expiresAt = instant(input.expiresAt, 'expiresAt');
    assertCg4DelegationGrantAllowed({
      capability: input.capability,
      delegatorSubjectId: input.delegatorSubjectId,
      delegateSubjectId: input.delegateSubjectId,
      delegatorHoldsCapabilityDirectly: input.delegatorHoldsCapabilityDirectly,
      delegateIsServicePrincipal: input.delegateIsServicePrincipal,
      startsAt,
      expiresAt,
    });

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      delegatorSubjectId: input.delegatorSubjectId,
      delegateSubjectId: input.delegateSubjectId,
      capability: input.capability,
      scopeKey: input.scopeKey,
      grantVersion: input.grantVersion,
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation: 'CG4_DELEGATION_GRANT',
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          throw new Cg3IdempotencyConflictError(input.idempotencyKey);
        }
        return receipt.responseBody as unknown as Cg4DelegationView;
      }

      const delegation = await transaction.cg4Delegation.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          delegatorSubjectId: input.delegatorSubjectId,
          delegateSubjectId: input.delegateSubjectId,
          capability: input.capability,
          scopeKey: input.scopeKey,
          grantVersion: input.grantVersion,
          startsAt,
          expiresAt,
        },
      });
      const view: Cg4DelegationView = {
        delegationId: delegation.id,
        tenantId: delegation.tenantId,
        delegatorSubjectId: delegation.delegatorSubjectId,
        delegateSubjectId: delegation.delegateSubjectId,
        capability: delegation.capability as Cg4Capability,
        scopeKey: delegation.scopeKey,
        grantVersion: delegation.grantVersion,
        startsAt: delegation.startsAt.toISOString(),
        expiresAt: delegation.expiresAt.toISOString(),
        createdAt: delegation.createdAt.toISOString(),
      };

      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: 'CG4_DELEGATION_GRANT',
          idempotencyKey: input.idempotencyKey,
          requestHash,
          expectedVersion: 0,
          aggregateVersion: input.grantVersion,
          responseStatus: 201,
          responseBody: view as unknown as object,
        },
      });
      return view;
    });
  }

  /** Active (not-yet-expired) delegations a subject currently holds, for capability resolution. */
  async activeDelegationsFor(
    tenantId: string,
    delegateSubjectId: string,
    now: Date,
  ): Promise<Cg4DelegationView[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const rows = await transaction.cg4Delegation.findMany({
        where: { tenantId, delegateSubjectId, startsAt: { lte: now }, expiresAt: { gt: now } },
        orderBy: { startsAt: 'asc' },
      });
      return rows.map((delegation) => ({
        delegationId: delegation.id,
        tenantId: delegation.tenantId,
        delegatorSubjectId: delegation.delegatorSubjectId,
        delegateSubjectId: delegation.delegateSubjectId,
        capability: delegation.capability as Cg4Capability,
        scopeKey: delegation.scopeKey,
        grantVersion: delegation.grantVersion,
        startsAt: delegation.startsAt.toISOString(),
        expiresAt: delegation.expiresAt.toISOString(),
        createdAt: delegation.createdAt.toISOString(),
      }));
    });
  }
}
