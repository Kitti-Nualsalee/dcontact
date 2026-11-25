/**
 * J2.3 — audit of manual recovery (replay/reconcile/cancel/skip-quarantine)
 *
 * append-only only, per #123: never modify a canonical database row, offset or owner
 * result directly — this is only a record of who did what to which existing reference, when
 * and why, and it must not claim that an owner effect was reverted
 */
import { randomUUID } from 'node:crypto';
import {
  type JrRecoveryAudit,
  type JrRecoveryOperation,
  type JrRecoveryTargetKind,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';

export interface RecordRecoveryInput {
  tenantId: string;
  operation: JrRecoveryOperation;
  targetKind: JrRecoveryTargetKind;
  /** reuse the existing only — an eventId/outcomeId or actionKey, not raw PII */
  targetRef: string;
  reasonCode: string;
  actorId: string;
  evidenceRef?: string;
}

export class JourneyRecoveryAuditLog {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: { id?: () => string } = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  record(input: RecordRecoveryInput): Promise<JrRecoveryAudit> {
    return withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
      transaction.jrRecoveryAudit.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: input.operation,
          targetKind: input.targetKind,
          targetRef: input.targetRef,
          reasonCode: input.reasonCode,
          actorId: input.actorId,
          ...(input.evidenceRef ? { evidenceRef: input.evidenceRef } : {}),
        },
      }),
    );
  }

  findFor(
    tenantId: string,
    targetKind: JrRecoveryTargetKind,
    targetRef: string,
  ): Promise<JrRecoveryAudit[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.jrRecoveryAudit.findMany({
        where: { tenantId, targetKind, targetRef },
        orderBy: { occurredAt: 'asc' },
      }),
    );
  }
}
