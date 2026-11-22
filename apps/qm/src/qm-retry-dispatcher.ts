import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { QmTranscriptionJobMessage } from '@d-contact/shared';

/** job ที่ PENDING แต่ dispatchedAt ค้างเกินนี้ถือว่า message หาย (process ตายระหว่าง claim กับ publish) */
export const QM_DISPATCH_STALE_MS = 5 * 60 * 1_000;

/**
 * - ไม่กรอง attempts: job ที่รอ recording archive ถูกเลื่อน nextAttemptAt ทั้งที่ attempts ยังเป็น 0
 *   job ใหม่ที่ workflow/API กำลัง publish มี nextAttemptAt เป็น null และ dispatchedAt มีค่าก่อน publish จึงไม่ถูกหยิบซ้ำ
 * - กวาด dispatchedAt ที่ค้าง: message ซ้ำปลอดภัยเพราะ worker ตรวจ attempt ของ job
 */
function dueWhere(now: Date) {
  return {
    status: 'PENDING' as const,
    OR: [
      { dispatchedAt: null, nextAttemptAt: { lte: now } },
      {
        dispatchedAt: { lt: new Date(now.getTime() - QM_DISPATCH_STALE_MS) },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
    ],
  };
}

export interface QmRetryPublisher {
  publish(input: { tenantId: string; job: QmTranscriptionJobMessage }): Promise<void>;
}

/** Durable retry scan: database time controls eligibility; Kafka messages remain idempotent by job/attempt.
 * ครอบทั้ง retry หลัง provider ล้มและ job ที่รอ recording archive (attempts ยังเป็น 0) */
export class QmRetryDispatcher {
  constructor(
    private readonly database: PrismaClient,
    private readonly publisher: QmRetryPublisher,
  ) {}

  async dispatchDue(now = new Date()): Promise<string[]> {
    const tenants = await this.database.tenant.findMany({ select: { id: true } });
    const published: string[] = [];
    for (const tenant of tenants) {
      const candidates = await withTenantDatabaseTransaction(
        this.database,
        tenant.id,
        (transaction) =>
          transaction.qmTranscriptionJob.findMany({
            where: { tenantId: tenant.id, ...dueWhere(now) },
            orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
            take: 100,
            select: {
              id: true,
              interactionId: true,
              recordingId: true,
              languageHint: true,
              trigger: true,
              attempts: true,
              dispatchedAt: true,
            },
          }),
      );
      for (const candidate of candidates) {
        const claimed = await withTenantDatabaseTransaction(
          this.database,
          tenant.id,
          (transaction) =>
            transaction.qmTranscriptionJob.updateMany({
              where: {
                id: candidate.id,
                tenantId: tenant.id,
                attempts: candidate.attempts,
                ...dueWhere(now),
              },
              data: { dispatchedAt: now },
            }),
        );
        if (claimed.count !== 1) continue;
        try {
          await this.publisher.publish({
            tenantId: tenant.id,
            job: {
              kind: 'TRANSCRIBE',
              jobId: candidate.id,
              interactionId: candidate.interactionId,
              recordingId: candidate.recordingId,
              languageHint: candidate.languageHint,
              trigger: candidate.trigger,
              attempt: candidate.attempts + 1,
            },
          });
          published.push(candidate.id);
        } catch (error) {
          await withTenantDatabaseTransaction(this.database, tenant.id, (transaction) =>
            transaction.qmTranscriptionJob.updateMany({
              where: { id: candidate.id, tenantId: tenant.id, dispatchedAt: now },
              // คืนค่าเดิม: job ที่ถูกกวาดเพราะค้างต้องถูกกวาดได้อีก ไม่ใช่กลายเป็น null ที่ไม่มีใครหยิบ
              data: { dispatchedAt: candidate.dispatchedAt },
            }),
          );
          throw error;
        }
      }
    }
    return published;
  }
}
