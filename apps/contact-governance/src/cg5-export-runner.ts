import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  Cg5ExportWorker,
  type Cg5CanonicalExportReader,
  type Cg5ExportObjectStorage,
} from './cg5-export-worker.js';

/** Picks one queued export per tenant; the worker's QUEUED→RUNNING transition is the durable claim. */
export class Cg5ExportRunner {
  private readonly worker: Cg5ExportWorker;

  constructor(
    database: PrismaClient,
    storage: Cg5ExportObjectStorage,
    reader: Cg5CanonicalExportReader,
  ) {
    this.worker = new Cg5ExportWorker(database, storage, reader);
    this.database = database;
  }

  private readonly database: PrismaClient;

  async runNext(tenantId: string): Promise<string | undefined> {
    const job = await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.cg5ExportJob.findFirst({
        where: { tenantId, state: 'QUEUED' },
        orderBy: { createdAt: 'asc' },
        select: { exportId: true },
      }),
    );
    if (!job) return undefined;
    await this.worker.run(tenantId, job.exportId);
    return job.exportId;
  }
}
