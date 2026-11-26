import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { QmTranscriptionJobMessage } from '@d-contact/shared';

/**
 * A PENDING job stuck longer than this is treated as a lost message: the process died between claim and publish (stale dispatchedAt)
 * or the workflow/API publish failed and reset dispatchedAt to null with nobody retrying (a new job nobody owns)
 */
export const QM_DISPATCH_STALE_MS = 5 * 60 * 1_000;

/**
 * - Does not filter on attempts: a job waiting for the recording archive gets nextAttemptAt moved while attempts is still 0
 * - A new job the workflow/API is publishing has dispatchedAt set before publish and a null nextAttemptAt, so it is not picked twice
 * - Sweeps jobs stuck longer than QM_DISPATCH_STALE_MS: a duplicate message is safe because the worker checks the job attempt
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
 * Covers both retries after a provider failure and jobs waiting for the recording archive (attempts still 0) */
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
            // The log shows how often jobs lose their message (no personal data)
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
              // Restore the old value: a job swept because it was stuck must be sweepable again, not become a null nobody picks
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
