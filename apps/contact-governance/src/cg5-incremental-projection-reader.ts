import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  CG5_EMPTY_DIMENSIONS,
  cg5DimensionKey,
  type Cg5MetricDimensions,
  type Cg5MetricKey,
} from '@d-contact/cxa-contracts';
import { cg5BucketStart } from './cg5-event-metrics-consumer.js';
import { PrismaCg5TenantConfigRepository } from './cg5-tenant-config-repository.js';

/** CG5.4 (#288): append-only canonical volumes become FIVE_MIN projection buckets. */
export const CG5_PROJECTION_SOURCES = ['DECISION', 'ATTEMPT', 'TOUCH', 'RESERVATION'] as const;
export type Cg5ProjectionSource = (typeof CG5_PROJECTION_SOURCES)[number];

export interface Cg5ProjectionCursor {
  lastProcessedAt: Date | null;
  lastProcessedId: string | null;
}

export interface Cg5ProjectionRange {
  from: Date;
  to: Date;
}

export interface Cg5ProjectionRunResult {
  refreshIntervalSeconds: number;
  processed: Readonly<Record<Cg5ProjectionSource, number>>;
}

type ProjectionRow = {
  id: string;
  occurredAt: Date;
  channel: string;
  purpose: string;
  teamId: string | null;
  decision?: string;
  gate?: string;
  reasonCode?: string;
  policyVersion?: number;
};

function dimensionsFor(row: ProjectionRow): Cg5MetricDimensions {
  return {
    ...CG5_EMPTY_DIMENSIONS,
    channel: row.channel as Cg5MetricDimensions['channel'],
    purpose: row.purpose,
    decision: (row.decision ?? null) as Cg5MetricDimensions['decision'],
    gate: row.gate ?? null,
    reasonCode: row.reasonCode ?? null,
    teamId: row.teamId,
  };
}

function metricFor(source: Cg5ProjectionSource): Cg5MetricKey {
  switch (source) {
    case 'DECISION':
      return 'cg.decision';
    case 'ATTEMPT':
    case 'TOUCH':
      return 'cg.frequency';
    case 'RESERVATION':
      return 'cg.reservation';
  }
}

function sourceKey(source: Cg5ProjectionSource): string {
  return `cg5.incremental.${source.toLowerCase()}`;
}

function after(field: string, cursor: Cg5ProjectionCursor): Record<string, unknown> | null {
  if (!cursor.lastProcessedAt || !cursor.lastProcessedId) return null;
  return {
    OR: [
      { [field]: { gt: cursor.lastProcessedAt } },
      { [field]: cursor.lastProcessedAt, id: { gt: cursor.lastProcessedId } },
    ],
  };
}

function whereAfter(
  field: string,
  cursor: Cg5ProjectionCursor,
  range?: Cg5ProjectionRange,
): Record<string, unknown> {
  const clauses: Record<string, unknown>[] = [];
  if (range) clauses.push({ [field]: { gte: range.from, lt: range.to } });
  const afterCursor = after(field, cursor);
  if (afterCursor) clauses.push(afterCursor);
  if (clauses.length === 0) return {};
  return clauses.length === 1 ? clauses[0]! : { AND: clauses };
}

function fiveMinuteRange(range: Cg5ProjectionRange): { gte: Date; lt: Date } {
  const from = cg5BucketStart(range.from, 'FIVE_MIN');
  const last = cg5BucketStart(new Date(range.to.valueOf() - 1), 'FIVE_MIN');
  return { gte: from, lt: new Date(last.valueOf() + 300_000) };
}

async function incrementMetric(
  transaction: Prisma.TransactionClient,
  tenantId: string,
  source: Cg5ProjectionSource,
  row: ProjectionRow,
): Promise<void> {
  const dimensions = dimensionsFor(row);
  const dimensionKey = cg5DimensionKey(dimensions);
  const bucketStart = cg5BucketStart(row.occurredAt, 'FIVE_MIN');
  await transaction.cg5MetricBucket.upsert({
    where: {
      tenantId_metricKey_granularity_bucketStart_dimensionKey: {
        tenantId,
        metricKey: metricFor(source),
        granularity: 'FIVE_MIN',
        bucketStart,
        dimensionKey,
      },
    },
    create: {
      tenantId,
      metricKey: metricFor(source),
      granularity: 'FIVE_MIN',
      bucketStart,
      ...dimensions,
      dimensionKey,
      value: new Prisma.Decimal(1),
      sampleCount: 1n,
      updatedAt: row.occurredAt,
    },
    update: {
      value: { increment: new Prisma.Decimal(1) },
      sampleCount: { increment: 1n },
      updatedAt: row.occurredAt,
    },
  });

  if (source === 'DECISION' && row.policyVersion !== undefined && row.decision !== undefined) {
    await transaction.cg5PolicyImpactBucket.upsert({
      where: {
        tenantId_granularity_bucketStart_policyVersion_decision: {
          tenantId,
          granularity: 'FIVE_MIN',
          bucketStart,
          policyVersion: row.policyVersion,
          decision: row.decision,
        },
      },
      create: {
        tenantId,
        granularity: 'FIVE_MIN',
        bucketStart,
        policyVersion: row.policyVersion,
        decision: row.decision,
        value: 1n,
      },
      update: { value: { increment: 1n } },
    });
  }
}

export class Cg5IncrementalProjectionReader {
  private readonly config: PrismaCg5TenantConfigRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly batchSize = 250,
    private readonly maxBatchesPerSource = Number.POSITIVE_INFINITY,
  ) {
    this.config = new PrismaCg5TenantConfigRepository(database);
  }

  async run(tenantId: string): Promise<Cg5ProjectionRunResult> {
    const config = await this.config.read(tenantId);
    const processed = {
      DECISION: 0,
      ATTEMPT: 0,
      TOUCH: 0,
      RESERVATION: 0,
    } satisfies Record<Cg5ProjectionSource, number>;

    for (const source of CG5_PROJECTION_SOURCES) {
      processed[source] = await this.projectSource(tenantId, source);
    }
    return { refreshIntervalSeconds: config.config.refreshIntervalSeconds, processed };
  }

  /** Rebuilds canonical-volume metrics in a range and advances only stale source cursors. */
  async rebuildRange(tenantId: string, range: Cg5ProjectionRange): Promise<void> {
    if (!(range.from instanceof Date) || !(range.to instanceof Date) || range.from >= range.to) {
      throw new TypeError('range ต้องมี from ก่อน to');
    }
    const bucketRange = fiveMinuteRange(range);
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.cg5MetricBucket.deleteMany({
        where: {
          tenantId,
          metricKey: { in: ['cg.decision', 'cg.frequency', 'cg.reservation'] },
          granularity: 'FIVE_MIN',
          bucketStart: bucketRange,
        },
      });
      await transaction.cg5PolicyImpactBucket.deleteMany({
        where: { tenantId, granularity: 'FIVE_MIN', bucketStart: bucketRange },
      });
    });
    for (const source of CG5_PROJECTION_SOURCES) {
      const last = await this.rebuildSource(tenantId, source, range);
      if (last) await this.advanceCursor(tenantId, source, last);
    }
  }

  private async projectSource(tenantId: string, source: Cg5ProjectionSource): Promise<number> {
    let processed = 0;
    let batches = 0;
    for (;;) {
      const count = await withTenantDatabaseTransaction(
        this.database,
        tenantId,
        async (transaction) => {
          await transaction.$queryRaw(
            Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg5-projection:${tenantId}:${source}`}))`,
          );
          const cursor = await transaction.cg5ProjectionCursor.findUnique({
            where: { tenantId_sourceKey: { tenantId, sourceKey: sourceKey(source) } },
          });
          const boundary: Cg5ProjectionCursor = {
            lastProcessedAt: cursor?.lastProcessedAt ?? null,
            lastProcessedId: cursor?.lastProcessedId ?? null,
          };
          const rows = await this.readRows(transaction, tenantId, source, boundary);
          for (const row of rows) await incrementMetric(transaction, tenantId, source, row);
          const last = rows.at(-1);
          if (last) {
            await transaction.cg5ProjectionCursor.upsert({
              where: { tenantId_sourceKey: { tenantId, sourceKey: sourceKey(source) } },
              create: {
                tenantId,
                sourceKey: sourceKey(source),
                lastProcessedAt: last.occurredAt,
                lastProcessedId: last.id,
                state: 'ACTIVE',
                lastRunAt: new Date(),
              },
              update: {
                lastProcessedAt: last.occurredAt,
                lastProcessedId: last.id,
                state: 'ACTIVE',
                lastRunAt: new Date(),
              },
            });
          }
          return rows.length;
        },
      );
      processed += count;
      batches += 1;
      if (count < this.batchSize || batches >= this.maxBatchesPerSource) return processed;
    }
  }

  private async rebuildSource(
    tenantId: string,
    source: Cg5ProjectionSource,
    range: Cg5ProjectionRange,
  ): Promise<ProjectionRow | null> {
    let cursor: Cg5ProjectionCursor = { lastProcessedAt: null, lastProcessedId: null };
    let lastProcessed: ProjectionRow | null = null;
    for (;;) {
      const rows = await withTenantDatabaseTransaction(
        this.database,
        tenantId,
        async (transaction) => {
          await transaction.$queryRaw(
            Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg5-projection:${tenantId}:${source}`}))`,
          );
          const batch = await this.readRows(transaction, tenantId, source, cursor, range);
          for (const row of batch) await incrementMetric(transaction, tenantId, source, row);
          return batch;
        },
      );
      const last = rows.at(-1);
      if (!last) return lastProcessed;
      lastProcessed = last;
      if (rows.length < this.batchSize) return lastProcessed;
      cursor = { lastProcessedAt: last.occurredAt, lastProcessedId: last.id };
    }
  }

  private async advanceCursor(
    tenantId: string,
    source: Cg5ProjectionSource,
    last: ProjectionRow,
  ): Promise<void> {
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const existing = await transaction.cg5ProjectionCursor.findUnique({
        where: { tenantId_sourceKey: { tenantId, sourceKey: sourceKey(source) } },
      });
      const boundary = existing?.lastProcessedAt;
      const isNewer =
        !boundary ||
        last.occurredAt > boundary ||
        (last.occurredAt.valueOf() === boundary.valueOf() &&
          (!existing.lastProcessedId || last.id > existing.lastProcessedId));
      if (!isNewer) return;
      await transaction.cg5ProjectionCursor.upsert({
        where: { tenantId_sourceKey: { tenantId, sourceKey: sourceKey(source) } },
        create: {
          tenantId,
          sourceKey: sourceKey(source),
          lastProcessedAt: last.occurredAt,
          lastProcessedId: last.id,
          state: 'ACTIVE',
          lastRunAt: new Date(),
        },
        update: {
          lastProcessedAt: last.occurredAt,
          lastProcessedId: last.id,
          state: 'ACTIVE',
          lastRunAt: new Date(),
        },
      });
    });
  }

  private async readRows(
    transaction: Prisma.TransactionClient,
    tenantId: string,
    source: Cg5ProjectionSource,
    cursor: Cg5ProjectionCursor,
    range?: Cg5ProjectionRange,
  ): Promise<ProjectionRow[]> {
    if (source === 'DECISION') {
      const rows = await transaction.cgDecisionLog.findMany({
        where: { tenantId, ...whereAfter('decidedAt', cursor, range) },
        orderBy: [{ decidedAt: 'asc' }, { id: 'asc' }],
        take: this.batchSize,
        select: {
          id: true,
          decidedAt: true,
          channel: true,
          purpose: true,
          teamId: true,
          decision: true,
          gate: true,
          reasonCode: true,
          policyVersion: true,
        },
      });
      return rows.map((row) => ({ ...row, occurredAt: row.decidedAt }));
    }
    if (source === 'ATTEMPT') {
      const rows = await transaction.cgAttempt.findMany({
        where: { tenantId, ...whereAfter('occurredAt', cursor, range) },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: this.batchSize,
        select: { id: true, occurredAt: true, channel: true, purpose: true },
      });
      return rows.map((row) => ({ ...row, teamId: null, gate: 'ATTEMPT' }));
    }
    if (source === 'TOUCH') {
      const rows = await transaction.cgTouch.findMany({
        where: { tenantId, ...whereAfter('occurredAt', cursor, range) },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: this.batchSize,
        select: { id: true, occurredAt: true, channel: true, purpose: true },
      });
      return rows.map((row) => ({ ...row, teamId: null, gate: 'TOUCH' }));
    }
    const rows = await transaction.cgReservation.findMany({
      where: { tenantId, ...whereAfter('createdAt', cursor, range) },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: this.batchSize,
      select: { id: true, createdAt: true, channel: true, purpose: true, teamId: true },
    });
    return rows.map((row) => ({ ...row, occurredAt: row.createdAt, gate: 'RESERVATION_CREATED' }));
  }
}
