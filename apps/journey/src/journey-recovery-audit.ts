/**
 * J2.3 — audit ของ manual recovery (replay/reconcile/cancel/skip-quarantine)
 *
 * append-only เท่านั้นตาม #123: ห้ามแก้ canonical database row, offset หรือ owner
 * result โดยตรง — ที่นี่เป็นเพียง record ว่าใครทำอะไรกับ reference เดิม เมื่อไร
 * และเพราะอะไร ห้ามอ้างว่า owner effect ถูกย้อน
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
  /** reuse ของเดิมเท่านั้น — eventId/outcomeId หรือ actionKey ไม่ใช่ raw PII */
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
