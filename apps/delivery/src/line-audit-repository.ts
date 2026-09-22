/**
 * Owner: Delivery/Channels — append-only audit ของ LINE control plane (S2.1 #365, #358 §H)
 *
 * eventId คงที่ต่อการกระทำเดิม: เขียนซ้ำด้วยเนื้อหาเดิมคืนแถวเดิม เนื้อหาต่างเป็น conflict
 * เก็บได้เฉพาะ machine code, opaque actor/subject ref และ digest — ไม่มีช่อง free-form
 */
import {
  type DlLineActorKind,
  type DlLineAuditCategory,
  type DlLineAuditEvent,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import { LineIdempotencyConflictError, isUniqueViolation } from './line-repository-support.js';

export interface AppendLineAuditEventInput {
  id: string;
  tenantId: string;
  eventId: string;
  category: DlLineAuditCategory;
  code: string;
  actorKind: DlLineActorKind;
  actorRef: string;
  subjectId?: string;
  deliveryId?: string;
  evidenceDigest?: string;
  occurredAt: Date;
}

export class LineAuditRepository {
  constructor(private readonly database: PrismaClient) {}

  async append(input: AppendLineAuditEventInput): Promise<DlLineAuditEvent> {
    const data = {
      ...input,
      subjectId: input.subjectId ?? null,
      deliveryId: input.deliveryId ?? null,
      evidenceDigest: input.evidenceDigest ?? null,
    };
    try {
      return await withTenantDatabaseTransaction(this.database, input.tenantId, (transaction) =>
        transaction.dlLineAuditEvent.create({ data }),
      );
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      const existing = await withTenantDatabaseTransaction(
        this.database,
        input.tenantId,
        (transaction) =>
          transaction.dlLineAuditEvent.findFirst({
            where: { tenantId: input.tenantId, eventId: input.eventId },
          }),
      );
      if (
        existing &&
        existing.category === data.category &&
        existing.code === data.code &&
        existing.actorKind === data.actorKind &&
        existing.actorRef === data.actorRef &&
        existing.subjectId === data.subjectId &&
        existing.deliveryId === data.deliveryId &&
        existing.evidenceDigest === data.evidenceDigest &&
        existing.occurredAt.getTime() === data.occurredAt.getTime()
      ) {
        return existing;
      }
      throw new LineIdempotencyConflictError('dl_line_audit_events');
    }
  }

  list(tenantId: string, category?: DlLineAuditCategory): Promise<DlLineAuditEvent[]> {
    return withTenantDatabaseTransaction(this.database, tenantId, (transaction) =>
      transaction.dlLineAuditEvent.findMany({
        where: { tenantId, ...(category ? { category } : {}) },
        orderBy: [{ occurredAt: 'asc' }, { eventId: 'asc' }],
      }),
    );
  }
}
