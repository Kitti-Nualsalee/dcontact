import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { type Cg5ExportDataset } from '@d-contact/cxa-contracts';
import { Cg5ExportJobRepository, Cg5ExportTransitionError } from './cg5-export-job-repository.js';
import type { Cg5ExportObjectStorage } from './cg5-export-worker.js';

function objectKeys(job: { storagePrefix: string | null; datasets: string[] }): string[] {
  if (!job.storagePrefix) return [];
  return [
    ...(job.datasets as Cg5ExportDataset[]).map(
      (dataset) => `${job.storagePrefix}/${dataset}.json`,
    ),
    `${job.storagePrefix}/manifest.json`,
  ];
}

/** Removes objects only after the durable state makes the export unavailable to every reader. */
export class Cg5ExportLifecycleService {
  private readonly jobs: Cg5ExportJobRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly storage: Cg5ExportObjectStorage,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.jobs = new Cg5ExportJobRepository(database, now);
  }

  async expireDue(tenantId: string): Promise<number> {
    const due = await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.cg5ExportJob.findMany({
        where: { tenantId, state: 'READY', expiresAt: { lte: this.now() } },
        select: { exportId: true, storagePrefix: true, datasets: true },
      }),
    );
    let expired = 0;
    for (const job of due) {
      try {
        await this.jobs.transition({
          tenantId,
          exportId: job.exportId,
          target: 'EXPIRED',
          actorRef: 'cg5-export-retention',
        });
      } catch (error) {
        if (error instanceof Cg5ExportTransitionError) continue;
        throw error;
      }
      await Promise.allSettled(objectKeys(job).map((key) => this.storage.delete(key)));
      expired += 1;
    }
    return expired;
  }

  /** Called by the data-erasure orchestrator; REVOKED is committed before object deletion. */
  async revoke(tenantId: string, exportId: string, actorRef = 'data-erasure'): Promise<boolean> {
    const job = await this.jobs.get(tenantId, exportId);
    if (!job) return false;
    if (job.state === 'QUEUED' || job.state === 'RUNNING' || job.state === 'READY') {
      try {
        await this.jobs.transition({ tenantId, exportId, target: 'REVOKED', actorRef });
      } catch (error) {
        if (error instanceof Cg5ExportTransitionError) return false;
        throw error;
      }
    }
    await Promise.allSettled(objectKeys(job).map((key) => this.storage.delete(key)));
    return true;
  }
}
