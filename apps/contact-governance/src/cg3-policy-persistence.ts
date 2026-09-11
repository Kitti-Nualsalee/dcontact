import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgPolicyStatus,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import {
  Cg3IdempotencyConflictError,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
} from './cg3-persistence.js';

/**
 * Publish transition สำหรับ synthetic policy fixture (#104 "ไม่มี general policy-draft
 * endpoint"). DRAFT row ถูกสร้างผ่าน fixture โดยตรง ไม่มี HTTP create-draft ใน S1.3
 */

export class Cg3InvalidLifecycleTransitionError extends Error {
  readonly code = 'INVALID_LIFECYCLE_TRANSITION';

  constructor(readonly status: CgPolicyStatus) {
    super(`policy อยู่ในสถานะ ${status} เผยแพร่ไม่ได้`);
    this.name = 'Cg3InvalidLifecycleTransitionError';
  }
}

export class Cg3SourceAuthorityConflictError extends Error {
  readonly code = 'SOURCE_AUTHORITY_CONFLICT';

  constructor() {
    super('checker ต้องต่างจาก maker');
    this.name = 'Cg3SourceAuthorityConflictError';
  }
}

export class Cg3PolicyApprovalRequiredError extends Error {
  readonly code = 'POLICY_APPROVAL_REQUIRED';

  constructor() {
    super('publish ต้องมี approvalRef');
    this.name = 'Cg3PolicyApprovalRequiredError';
  }
}

export interface PublishPolicyInput {
  tenantId: string;
  policyRowId: string;
  expectedVersion: number;
  checkerActorRef: string;
  approvalRef: string;
  publishedAt?: string;
  idempotencyKey: string;
  actorClass: string;
  actorRef: string;
  correlationId: string;
}

export interface PolicyView {
  id: string;
  tenantId: string;
  policyId: string;
  version: number;
  purpose?: string;
  contactKind?: string;
  channel?: ContactChannel;
  status: CgPolicyStatus;
  makerActorRef: string;
  checkerActorRef?: string;
  approvalRef?: string;
  effectiveFrom: string;
  effectiveTo?: string;
  publishedAt?: string;
  createdAt: string;
}

export interface PublishPolicyResult {
  mutationId: string;
  policy: PolicyView;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
  return normalized;
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function view(row: {
  id: string;
  tenantId: string;
  policyId: string;
  version: number;
  purpose: string | null;
  contactKind: string | null;
  channel: ContactChannel | null;
  status: CgPolicyStatus;
  makerActorRef: string;
  checkerActorRef: string | null;
  approvalRef: string | null;
  effectiveFrom: Date;
  effectiveTo: Date | null;
  publishedAt: Date | null;
  createdAt: Date;
}): PolicyView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    policyId: row.policyId,
    version: row.version,
    ...(row.purpose ? { purpose: row.purpose } : {}),
    ...(row.contactKind ? { contactKind: row.contactKind } : {}),
    ...(row.channel ? { channel: row.channel } : {}),
    status: row.status,
    makerActorRef: row.makerActorRef,
    ...(row.checkerActorRef ? { checkerActorRef: row.checkerActorRef } : {}),
    ...(row.approvalRef ? { approvalRef: row.approvalRef } : {}),
    effectiveFrom: row.effectiveFrom.toISOString(),
    ...(row.effectiveTo ? { effectiveTo: row.effectiveTo.toISOString() } : {}),
    ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
    createdAt: row.createdAt.toISOString(),
  };
}

export interface Cg3PolicyRepositoryOptions {
  id?: () => string;
  now?: () => Date;
}

export class Cg3PolicyRepository {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    options: Cg3PolicyRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async publish(input: PublishPolicyInput): Promise<PublishPolicyResult> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.policyRowId, 'policyRowId');
    nonEmpty(input.checkerActorRef, 'checkerActorRef');
    nonEmpty(input.approvalRef, 'approvalRef');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    nonEmpty(input.actorClass, 'actorClass');
    nonEmpty(input.actorRef, 'actorRef');
    nonEmpty(input.correlationId, 'correlationId');
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion <= 0) {
      throw new RangeError('expectedVersion ต้องเป็น integer มากกว่า 0');
    }
    const publishedAt = input.publishedAt ? new Date(input.publishedAt) : this.now();
    if (Number.isNaN(publishedAt.getTime())) {
      throw new TypeError('publishedAt ต้องเป็น ISO-8601 timestamp');
    }

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyRowId: input.policyRowId,
      expectedVersion: input.expectedVersion,
      checkerActorRef: input.checkerActorRef,
      approvalRef: input.approvalRef,
      actorClass: input.actorClass,
      actorRef: input.actorRef,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation: 'POLICY_PUBLISH',
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          throw new Cg3IdempotencyConflictError(input.idempotencyKey);
        }
        return receipt.responseBody as unknown as PublishPolicyResult;
      }

      const policy = await transaction.cgPolicy.findFirst({
        where: { id: input.policyRowId, tenantId: input.tenantId },
      });
      if (!policy) throw new Cg3ResourceNotFoundError();
      if (policy.version !== input.expectedVersion) {
        throw new Cg3VersionConflictError(input.expectedVersion, policy.version);
      }
      if (policy.status !== 'DRAFT') {
        throw new Cg3InvalidLifecycleTransitionError(policy.status);
      }
      if (input.checkerActorRef === policy.makerActorRef) {
        throw new Cg3SourceAuthorityConflictError();
      }

      const updated = await transaction.cgPolicy.update({
        where: { id: policy.id },
        data: {
          status: 'PUBLISHED',
          checkerActorRef: input.checkerActorRef,
          approvalRef: input.approvalRef,
          publishedAt,
        },
      });

      const mutationId = this.id();
      await transaction.cgEventOutbox.create({
        data: {
          id: this.id(),
          mutationId,
          tenantId: input.tenantId,
          aggregateType: 'POLICY',
          aggregateId: updated.policyId,
          aggregateVersion: updated.version,
          eventType: 'policy.changed',
          orderingKey: `${input.tenantId}:${updated.policyId}`,
          payload: json({
            contractVersion: 1,
            mutationId,
            subjectVersion: updated.version,
            affectedScope: {
              identityId: null,
              channel: updated.channel,
              purpose: updated.purpose,
              contactKind: updated.contactKind,
            },
            effectiveAt: updated.effectiveFrom.toISOString(),
            policyVersion: updated.version,
            stateDigest: stableDigest(view(updated)),
          }),
          payloadHash: stableDigest(view(updated)),
        },
      });
      await transaction.cgAuditLog.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          mutationId,
          aggregateType: 'POLICY',
          aggregateId: updated.policyId,
          aggregateVersion: updated.version,
          action: 'POLICY_PUBLISH',
          actorClass: input.actorClass,
          actorRef: input.actorRef,
          sourceKind: 'COMPLIANCE',
          evidenceRef: input.approvalRef,
          afterDigest: stableDigest(view(updated)),
          occurredAt: publishedAt,
        },
      });

      const result: PublishPolicyResult = { mutationId, policy: view(updated) };
      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: 'POLICY_PUBLISH',
          idempotencyKey: input.idempotencyKey,
          requestHash,
          expectedVersion: input.expectedVersion,
          aggregateVersion: updated.version,
          responseStatus: 200,
          responseBody: json(result),
        },
      });
      return result;
    });
  }
}
