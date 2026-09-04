import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { QmTranscriptionJobMessage } from '@d-contact/shared';

export interface QmRetryPublisher {
  publish(input: { tenantId: string; job: QmTranscriptionJobMessage }): Promise<void>;
}

/** Durable retry scan: database time controls eligibility; Kafka messages remain idempotent by job/attempt. */
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
            where: {
              tenantId: tenant.id,
              status: 'PENDING',
              attempts: { gt: 0 },
              dispatchedAt: null,
              nextAttemptAt: { lte: now },
            },
            orderBy: [{ nextAttemptAt: 'asc' }, { id: 'asc' }],
            take: 100,
            select: {
              id: true,
              interactionId: true,
              recordingId: true,
              languageHint: true,
              trigger: true,
              attempts: true,
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
                status: 'PENDING',
                dispatchedAt: null,
                nextAttemptAt: { lte: now },
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
              data: { dispatchedAt: null },
            }),
          );
          throw error;
        }
      }
    }
    return published;
  }
}
