import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { QmTranscriptionJobMessage } from '@d-contact/shared';

/**
 * job ที่ PENDING แต่ค้างเกินนี้ถือว่า message หาย: process ตายระหว่าง claim กับ publish (dispatchedAt ค้าง)
 * หรือ workflow/API publish ล้มแล้วคืน dispatchedAt เป็น null โดยไม่มีใครเรียกซ้ำ (job ใหม่ที่ไม่มีใครดูแล)
 */
export const QM_DISPATCH_STALE_MS = 5 * 60 * 1_000;

/**
 * - ไม่กรอง attempts: job ที่รอ recording archive ถูกเลื่อน nextAttemptAt ทั้งที่ attempts ยังเป็น 0
 * - job ใหม่ที่ workflow/API กำลัง publish มี dispatchedAt ก่อน publish และ nextAttemptAt เป็น null จึงไม่ถูกหยิบซ้ำ
 * - กวาด job ที่ค้างเกิน QM_DISPATCH_STALE_MS: message ซ้ำปลอดภัยเพราะ worker ตรวจ attempt ของ job
 */
function dueWhere(now: Date) {
  const staleBefore = new Date(now.getTime() - QM_DISPATCH_STALE_MS);
  return {
    status: 'PENDING' as const,
    OR: [
      { dispatchedAt: null, nextAttemptAt: { lte: now } },
      {
        dispatchedAt: { lt: staleBefore },
        OR: [{ nextAttemptAt: null }, { nextAttemptAt: { lte: now } }],
      },
      { dispatchedAt: null, nextAttemptAt: null, createdAt: { lt: staleBefore } },
    ],
  };
}

function isSwept(candidate: { dispatchedAt: Date | null; nextAttemptAt: Date | null }): boolean {
  return candidate.dispatchedAt !== null || candidate.nextAttemptAt === null;
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
              nextAttemptAt: true,
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
          if (isSwept(candidate)) {
            // นับได้จาก log ว่ามี job ที่ message หายบ่อยแค่ไหน (ไม่มีข้อมูลส่วนบุคคล)
            console.warn('[qm] re-dispatched stale transcription job', {
              tenantId: tenant.id,
              jobId: candidate.id,
              attempt: candidate.attempts + 1,
            });
          }
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
