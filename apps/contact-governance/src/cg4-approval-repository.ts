import { randomUUID } from 'node:crypto';
import {
  type Cg4ApprovalDecision as PrismaCg4ApprovalDecision,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type {
  Cg4ApprovalDecision,
  Cg4AuthorizationSubject,
  Cg4PolicyDiffClass,
  Cg4QuorumEvaluation,
  Cg4RecordedApproval,
} from '@d-contact/cxa-contracts';
import {
  cg4DelegationId,
  cg4SubjectId,
  resolveCg4ExceptionQuorum,
  resolveCg4PolicyQuorum,
} from '@d-contact/cxa-contracts';
import {
  assertCg4ApprovalAuthorization,
  evaluateCg4Quorum,
  resolveCg4RequiredExceptionCapability,
  resolveCg4RequiredPolicyCapability,
} from './cg4-authorization-engine.js';
import {
  Cg3IdempotencyConflictError,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
  stableDigest,
} from './cg3-persistence.js';

/**
 * CG4.3 (#186): records one checker's vote and returns the current quorum evaluation.
 * This repository never advances `Cg4ExceptionHead.status`/`Cg4Policy.status` — CG4.4
 * (exception lifecycle) and CG4.5 (policy studio runtime) own the actual finalization
 * once they observe `evaluation.status === 'MET'`, per this ticket's "no full
 * exception/policy lifecycle" boundary.
 */

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
  return normalized;
}

/** Wire decision (`APPROVE`/`REJECT`, CG4.1) vs. the Prisma enum (`APPROVED`/`REJECTED`, CG4.2). */
function toPrismaDecision(decision: Cg4ApprovalDecision): PrismaCg4ApprovalDecision {
  return decision === 'APPROVE' ? 'APPROVED' : 'REJECTED';
}

function toRecordedApproval(row: {
  approverRef: string;
  capability: string;
  capabilitySource: string;
  delegationId: string | null;
  directCompliance: boolean;
  emergencyAuthority: boolean;
  authorizationEpoch: number;
  scopeVersion: number;
  decidedAt: Date;
}): Cg4RecordedApproval {
  return {
    checkerSubjectId: cg4SubjectId(row.approverRef),
    capability: row.capability as Cg4RecordedApproval['capability'],
    directComplianceAuthority: row.directCompliance,
    emergencyAuthority: row.emergencyAuthority,
    source: row.capabilitySource as Cg4RecordedApproval['source'],
    ...(row.delegationId ? { delegationId: cg4DelegationId(row.delegationId) } : {}),
    authorizationEpoch: row.authorizationEpoch,
    scopeVersion: row.scopeVersion,
    decidedAt: row.decidedAt.toISOString(),
  };
}

export interface RecordCg4ExceptionApprovalInput {
  tenantId: string;
  exceptionId: string;
  expectedRevision: number;
  expectedContentDigest: string;
  decision: Cg4ApprovalDecision;
  evidenceRef: string;
  makerSubjectId: string;
  scopeKey: string;
  checker: Cg4AuthorizationSubject;
  idempotencyKey: string;
}

export interface Cg4ApprovalCommandResult {
  approvalId: string;
  quorum: Cg4QuorumEvaluation;
}

export interface RecordCg4PolicyApprovalInput {
  tenantId: string;
  policyId: string;
  expectedVersion: number;
  expectedContentDigest: string;
  diffClass: Cg4PolicyDiffClass;
  decision: Cg4ApprovalDecision;
  evidenceRef: string;
  makerSubjectId: string;
  scopeKey: string;
  checker: Cg4AuthorizationSubject;
  idempotencyKey: string;
}

export interface Cg4ApprovalRepositoryOptions {
  id?: () => string;
  now?: () => Date;
}

export class Cg4ApprovalRepository {
  private readonly id: () => string;
  private readonly now: () => Date;

  constructor(
    private readonly database: PrismaClient,
    options: Cg4ApprovalRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
    this.now = options.now ?? (() => new Date());
  }

  async recordExceptionApproval(
    input: RecordCg4ExceptionApprovalInput,
  ): Promise<Cg4ApprovalCommandResult> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.exceptionId, 'exceptionId');
    nonEmpty(input.evidenceRef, 'evidenceRef');
    nonEmpty(input.makerSubjectId, 'makerSubjectId');
    nonEmpty(input.scopeKey, 'scopeKey');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      exceptionId: input.exceptionId,
      expectedRevision: input.expectedRevision,
      expectedContentDigest: input.expectedContentDigest,
      decision: input.decision,
      evidenceRef: input.evidenceRef,
      makerSubjectId: input.makerSubjectId,
      scopeKey: input.scopeKey,
      checkerSubjectId: input.checker.subjectId,
      authorizationEpoch: input.checker.authorizationEpoch,
      scopeVersion: input.checker.scopeVersion,
    });
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation: 'CG4_EXCEPTION_APPROVAL_RECORD',
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          throw new Cg3IdempotencyConflictError(input.idempotencyKey);
        }
        return receipt.responseBody as unknown as Cg4ApprovalCommandResult;
      }

      const head = await transaction.cg4ExceptionHead.findUnique({
        where: {
          tenantId_exceptionId: { tenantId: input.tenantId, exceptionId: input.exceptionId },
        },
      });
      if (!head) throw new Cg3ResourceNotFoundError();
      if (head.currentRevision !== input.expectedRevision) {
        throw new Cg3VersionConflictError(input.expectedRevision, head.currentRevision);
      }
      const exception = await transaction.cg4Exception.findFirst({
        where: { tenantId: input.tenantId, id: head.currentRevisionId },
      });
      if (!exception) throw new Cg3ResourceNotFoundError();
      if (exception.requestHash !== input.expectedContentDigest) {
        throw new Cg3VersionConflictError(input.expectedRevision, head.currentRevision);
      }

      const existingRows = await transaction.cg4ExceptionApproval.findMany({
        where: {
          tenantId: input.tenantId,
          exceptionId: input.exceptionId,
          exceptionRevision: input.expectedRevision,
        },
      });
      const existingApprovals = existingRows.map(toRecordedApproval);
      const requiredCapability = resolveCg4RequiredExceptionCapability(exception.tier);
      const now = this.now();
      const grant = assertCg4ApprovalAuthorization({
        requiredCapability,
        checker: input.checker,
        scopeKey: input.scopeKey,
        makerSubjectId: input.makerSubjectId,
        existingApprovals,
        now,
      });

      const approval = await transaction.cg4ExceptionApproval.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          exceptionId: input.exceptionId,
          exceptionRevision: input.expectedRevision,
          decision: toPrismaDecision(input.decision),
          approverRef: input.checker.subjectId,
          evidenceRef: input.evidenceRef,
          decidedAt: now,
          capability: requiredCapability,
          capabilitySource: grant.source,
          delegationId: grant.delegationId,
          directCompliance: input.checker.directComplianceAuthority,
          emergencyAuthority: input.checker.emergencyAuthority,
          authorizationEpoch: input.checker.authorizationEpoch,
          scopeVersion: input.checker.scopeVersion,
        },
      });

      const allApprovals = [...existingApprovals, toRecordedApproval(approval)];
      const requirement = resolveCg4ExceptionQuorum(exception.tier);
      const quorum = evaluateCg4Quorum(requirement, allApprovals, input.decision === 'REJECT', now);

      const mutationId = this.id();
      await transaction.cgAuditLog.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          mutationId,
          aggregateType: 'CONTACT',
          aggregateId: exception.contactId,
          aggregateVersion: input.expectedRevision,
          action:
            input.decision === 'APPROVE'
              ? 'CG4_EXCEPTION_APPROVAL_RECORDED'
              : 'CG4_EXCEPTION_REJECTION_RECORDED',
          actorClass: 'COMPLIANCE',
          actorRef: input.checker.subjectId,
          sourceKind: 'COMPLIANCE',
          evidenceRef: input.evidenceRef,
          beforeDigest: exception.requestHash,
          afterDigest: exception.requestHash,
          occurredAt: now,
        },
      });

      const result: Cg4ApprovalCommandResult = { approvalId: approval.id, quorum };
      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: 'CG4_EXCEPTION_APPROVAL_RECORD',
          idempotencyKey: input.idempotencyKey,
          requestHash,
          expectedVersion: input.expectedRevision,
          aggregateVersion: input.expectedRevision,
          responseStatus: 201,
          responseBody: result as unknown as object,
        },
      });
      return result;
    });
  }

  async recordPolicyApproval(
    input: RecordCg4PolicyApprovalInput,
  ): Promise<Cg4ApprovalCommandResult> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.policyId, 'policyId');
    nonEmpty(input.evidenceRef, 'evidenceRef');
    nonEmpty(input.makerSubjectId, 'makerSubjectId');
    nonEmpty(input.scopeKey, 'scopeKey');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      policyId: input.policyId,
      expectedVersion: input.expectedVersion,
      expectedContentDigest: input.expectedContentDigest,
      diffClass: input.diffClass,
      decision: input.decision,
      evidenceRef: input.evidenceRef,
      makerSubjectId: input.makerSubjectId,
      scopeKey: input.scopeKey,
      checkerSubjectId: input.checker.subjectId,
      authorizationEpoch: input.checker.authorizationEpoch,
      scopeVersion: input.checker.scopeVersion,
    });
    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation: 'CG4_POLICY_APPROVAL_RECORD',
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          throw new Cg3IdempotencyConflictError(input.idempotencyKey);
        }
        return receipt.responseBody as unknown as Cg4ApprovalCommandResult;
      }

      const policy = await transaction.cg4Policy.findFirst({
        where: {
          tenantId: input.tenantId,
          policyId: input.policyId,
          version: input.expectedVersion,
        },
      });
      if (!policy) throw new Cg3ResourceNotFoundError();
      if (policy.contentDigest !== input.expectedContentDigest) {
        throw new Cg3VersionConflictError(input.expectedVersion, policy.version);
      }

      const existingRows = await transaction.cg4PolicyApproval.findMany({
        where: {
          tenantId: input.tenantId,
          policyId: input.policyId,
          policyVersion: input.expectedVersion,
        },
      });
      const existingApprovals = existingRows.map(toRecordedApproval);
      const requiredCapability = resolveCg4RequiredPolicyCapability(input.diffClass);
      const now = this.now();
      const grant = assertCg4ApprovalAuthorization({
        requiredCapability,
        checker: input.checker,
        scopeKey: input.scopeKey,
        makerSubjectId: input.makerSubjectId,
        existingApprovals,
        now,
      });

      const approval = await transaction.cg4PolicyApproval.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          policyId: input.policyId,
          policyVersion: input.expectedVersion,
          decision: toPrismaDecision(input.decision),
          approverRef: input.checker.subjectId,
          evidenceRef: input.evidenceRef,
          decidedAt: now,
          capability: requiredCapability,
          capabilitySource: grant.source,
          delegationId: grant.delegationId,
          directCompliance: input.checker.directComplianceAuthority,
          emergencyAuthority: input.checker.emergencyAuthority,
          authorizationEpoch: input.checker.authorizationEpoch,
          scopeVersion: input.checker.scopeVersion,
        },
      });

      const allApprovals = [...existingApprovals, toRecordedApproval(approval)];
      const requirement = resolveCg4PolicyQuorum(input.diffClass);
      const quorum = evaluateCg4Quorum(requirement, allApprovals, input.decision === 'REJECT', now);

      const mutationId = this.id();
      await transaction.cgAuditLog.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          mutationId,
          aggregateType: 'POLICY',
          aggregateId: policy.id,
          aggregateVersion: input.expectedVersion,
          action:
            input.decision === 'APPROVE'
              ? 'CG4_POLICY_APPROVAL_RECORDED'
              : 'CG4_POLICY_REJECTION_RECORDED',
          actorClass: 'COMPLIANCE',
          actorRef: input.checker.subjectId,
          sourceKind: 'COMPLIANCE',
          evidenceRef: input.evidenceRef,
          beforeDigest: policy.contentDigest,
          afterDigest: policy.contentDigest,
          occurredAt: now,
        },
      });

      const result: Cg4ApprovalCommandResult = { approvalId: approval.id, quorum };
      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: 'CG4_POLICY_APPROVAL_RECORD',
          idempotencyKey: input.idempotencyKey,
          requestHash,
          expectedVersion: input.expectedVersion,
          aggregateVersion: input.expectedVersion,
          responseStatus: 201,
          responseBody: result as unknown as object,
        },
      });
      return result;
    });
  }
}
