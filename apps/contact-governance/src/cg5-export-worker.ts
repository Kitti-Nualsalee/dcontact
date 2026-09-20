import { createHash } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  CG5_CONTRACT_VERSION,
  CG5_MANIFEST_SCHEMA_VERSION,
  type Cg5ExportDataset,
  type Cg5ExportManifestV1,
} from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import { Cg5ExportJobRepository } from './cg5-export-job-repository.js';

export interface Cg5ExportObjectStorage {
  put(key: string, body: Uint8Array): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface Cg5CanonicalExportReader {
  read(input: {
    tenantId: string;
    datasets: readonly Cg5ExportDataset[];
    rangeFrom: Date;
    rangeTo: Date;
    filters: unknown;
    evidenceLevel: string;
  }): Promise<ReadonlyArray<{ dataset: Cg5ExportDataset; body: Uint8Array; rowCount: number }>>;
}

function digest(body: Uint8Array): string {
  return createHash('sha256').update(body).digest('hex');
}

function prefix(tenantId: string, exportId: string): string {
  return `governance-exports/${tenantId}/${exportId}`;
}

/** Worker writes only after reading canonical data; a failure removes every uploaded object before FAILED. */
export class Cg5ExportWorker {
  private readonly jobs: Cg5ExportJobRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly storage: Cg5ExportObjectStorage,
    private readonly reader: Cg5CanonicalExportReader,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.jobs = new Cg5ExportJobRepository(database, now);
  }

  async run(tenantId: string, exportId: string): Promise<void> {
    const job = await withTenantDatabaseTransaction(this.database, tenantId, (tx) =>
      tx.cg5ExportJob.findFirst({ where: { tenantId, exportId } }),
    );
    if (!job) throw new TypeError('ไม่พบ export job');
    if (job.state !== 'QUEUED') return;
    const storagePrefix = prefix(tenantId, exportId);
    const written: string[] = [];
    try {
      await this.jobs.transition({
        tenantId,
        exportId,
        target: 'RUNNING',
        actorRef: 'cg5-export-worker',
      });
      const files = await this.reader.read({
        tenantId,
        datasets: job.datasets as Cg5ExportDataset[],
        rangeFrom: job.rangeFrom,
        rangeTo: job.rangeTo,
        filters: job.filters,
        evidenceLevel: job.evidenceLevel,
      });
      const fileDigests: Record<string, string> = {};
      const rowCounts = Object.fromEntries(job.datasets.map((dataset) => [dataset, 0]));
      for (const file of files) {
        const key = `${storagePrefix}/${file.dataset}.json`;
        await this.storage.put(key, file.body);
        written.push(key);
        fileDigests[file.dataset] = digest(file.body);
        rowCounts[file.dataset] = file.rowCount;
      }
      const manifest: Cg5ExportManifestV1 = {
        contractVersion: CG5_CONTRACT_VERSION,
        manifestSchemaVersion: CG5_MANIFEST_SCHEMA_VERSION,
        exportId,
        datasets: job.datasets as Cg5ExportDataset[],
        evidenceLevel: job.evidenceLevel as 'SUMMARY' | 'EVIDENCE',
        rangeFrom: job.rangeFrom.toISOString(),
        rangeTo: job.rangeTo.toISOString(),
        rowCounts: rowCounts as Record<Cg5ExportDataset, number>,
        fileDigests,
        requestedByRef: job.requestedByRef,
        generatedAt: this.now().toISOString(),
        tenantWatermark: stableDigest({ tenantId, exportId }),
      };
      const manifestBody = new TextEncoder().encode(JSON.stringify(manifest));
      await this.storage.put(`${storagePrefix}/manifest.json`, manifestBody);
      written.push(`${storagePrefix}/manifest.json`);
      await this.jobs.transition({
        tenantId,
        exportId,
        target: 'READY',
        actorRef: 'cg5-export-worker',
        storagePrefix,
        manifestDigest: digest(manifestBody),
        rowCounts,
        expiresAt: new Date(this.now().valueOf() + 86_400_000),
      });
    } catch (error) {
      await Promise.allSettled(written.map((key) => this.storage.delete(key)));
      await this.jobs.transition({
        tenantId,
        exportId,
        target: 'FAILED',
        actorRef: 'cg5-export-worker',
      });
      throw error;
    }
  }
}
