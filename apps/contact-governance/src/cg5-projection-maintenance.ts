import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  CG5_EMPTY_DIMENSIONS,
  cg5DimensionKey,
  type Cg5Granularity,
  type Cg5MetricDimensions,
} from '@d-contact/cxa-contracts';
import { cg5BucketStart } from './cg5-event-metrics-consumer.js';
import {
  Cg5IncrementalProjectionReader,
  type Cg5ProjectionRange,
} from './cg5-incremental-projection-reader.js';
import { PrismaCg5TenantConfigRepository } from './cg5-tenant-config-repository.js';

const READINESS_SOURCE_KEY = 'cg5.projection.readiness';
const VOLUME_METRICS = ['cg.decision', 'cg.frequency', 'cg.reservation'] as const;

export type Cg5ProjectionReadinessState = 'NOT_READY' | 'BACKFILL_RUNNING' | 'READY' | 'FAILED';

export interface Cg5ProjectionReadiness {
  state: Cg5ProjectionReadinessState;
  updatedAt: Date | null;
}

type Aggregate = {
  metricKey: string;
  dimensions: Cg5MetricDimensions;
  bucketStart: Date;
  value: Prisma.Decimal;
  sampleCount: bigint;
  updatedAt: Date;
};

type PolicyAggregate = {
  bucketStart: Date;
  policyVersion: number;
  decision: string;
  value: bigint;
};

function assertRange(range: Cg5ProjectionRange): void {
  if (!(range.from instanceof Date) || !(range.to instanceof Date) || range.from >= range.to) {
    throw new TypeError('range ต้องมี from ก่อน to');
  }
}

function nextBucket(date: Date, granularity: Cg5Granularity): Date {
  const milliseconds = { FIVE_MIN: 300_000, HOUR: 3_600_000, DAY: 86_400_000 }[granularity];
  return new Date(cg5BucketStart(date, granularity).valueOf() + milliseconds);
}

function targetRange(range: Cg5ProjectionRange, granularity: Cg5Granularity): Cg5ProjectionRange {
  const from = cg5BucketStart(range.from, granularity);
  const to = nextBucket(new Date(range.to.valueOf() - 1), granularity);
  return { from, to };
}

function dimensions(row: {
  channel: string | null;
  purpose: string | null;
  decision: string | null;
  gate: string | null;
  reasonCode: string | null;
  teamId: string | null;
}): Cg5MetricDimensions {
  return {
    ...CG5_EMPTY_DIMENSIONS,
    channel: row.channel as Cg5MetricDimensions['channel'],
    purpose: row.purpose,
    decision: row.decision as Cg5MetricDimensions['decision'],
    gate: row.gate,
    reasonCode: row.reasonCode,
    teamId: row.teamId,
  };
}

function monthCutoff(now: Date, months: number): Date {
  const result = new Date(now);
  result.setUTCMonth(result.getUTCMonth() - months);
  return result;
}

export class Cg5ProjectionMaintenance {
  private readonly config: PrismaCg5TenantConfigRepository;
  private readonly reader: Cg5IncrementalProjectionReader;

  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.config = new PrismaCg5TenantConfigRepository(database);
    this.reader = new Cg5IncrementalProjectionReader(database);
  }

  async readiness(tenantId: string): Promise<Cg5ProjectionReadiness> {
    return withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const row = await transaction.cg5ProjectionCursor.findUnique({
        where: { tenantId_sourceKey: { tenantId, sourceKey: READINESS_SOURCE_KEY } },
      });
      return {
        state: (row?.state as Cg5ProjectionReadinessState | undefined) ?? 'NOT_READY',
        updatedAt: row?.lastRunAt ?? null,
      };
    });
  }

  async backfill(tenantId: string): Promise<void> {
    const { config } = await this.config.read(tenantId);
    await this.rebuild(tenantId, {
      from: monthCutoff(this.now(), config.retentionDailyMonths),
      to: this.now(),
    });
    await this.applyRetention(tenantId);
  }

  async rebuild(tenantId: string, range: Cg5ProjectionRange): Promise<void> {
    assertRange(range);
    await this.setReadiness(tenantId, 'BACKFILL_RUNNING');
    try {
      await this.reader.rebuildRange(tenantId, range);
      await this.rollup(tenantId, range, 'FIVE_MIN', 'HOUR');
      await this.rollup(tenantId, range, 'HOUR', 'DAY');
      await this.setReadiness(tenantId, 'READY');
    } catch (error) {
      await this.setReadiness(tenantId, 'FAILED');
      throw error;
    }
  }

  async applyRetention(tenantId: string): Promise<void> {
    const { config } = await this.config.read(tenantId);
    const now = this.now();
    const cutoffs: ReadonlyArray<readonly [Cg5Granularity, Date]> = [
      ['FIVE_MIN', new Date(now.valueOf() - config.retentionFiveMinuteDays * 86_400_000)],
      ['HOUR', new Date(now.valueOf() - config.retentionHourlyDays * 86_400_000)],
      ['DAY', monthCutoff(now, config.retentionDailyMonths)],
    ];
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      for (const [granularity, cutoff] of cutoffs) {
        await transaction.cg5MetricBucket.deleteMany({
          where: { tenantId, granularity, bucketStart: { lt: cutoff } },
        });
        await transaction.cg5PolicyImpactBucket.deleteMany({
          where: { tenantId, granularity, bucketStart: { lt: cutoff } },
        });
      }
    });
  }

  private async setReadiness(
    tenantId: string,
    state: Exclude<Cg5ProjectionReadinessState, 'NOT_READY'>,
  ) {
    const lastRunAt = this.now();
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      await transaction.cg5ProjectionCursor.upsert({
        where: { tenantId_sourceKey: { tenantId, sourceKey: READINESS_SOURCE_KEY } },
        create: { tenantId, sourceKey: READINESS_SOURCE_KEY, state, lastRunAt },
        update: { state, lastRunAt },
      });
    });
  }

  private async rollup(
    tenantId: string,
    sourceRange: Cg5ProjectionRange,
    source: Cg5Granularity,
    target: Cg5Granularity,
  ): Promise<void> {
    const range = targetRange(sourceRange, target);
    await withTenantDatabaseTransaction(this.database, tenantId, async (transaction) => {
      const sourceRows = await transaction.cg5MetricBucket.findMany({
        where: {
          tenantId,
          metricKey: { in: [...VOLUME_METRICS] },
          granularity: source,
          bucketStart: { gte: range.from, lt: range.to },
        },
      });
      const aggregates = new Map<string, Aggregate>();
      for (const row of sourceRows) {
        const bucketStart = cg5BucketStart(row.bucketStart, target);
        const rowDimensions = dimensions(row);
        const key = `${row.metricKey}:${bucketStart.toISOString()}:${cg5DimensionKey(rowDimensions)}`;
        const current = aggregates.get(key);
        if (current) {
          current.value = current.value.add(row.value);
          current.sampleCount += row.sampleCount;
          if (row.updatedAt > current.updatedAt) current.updatedAt = row.updatedAt;
        } else {
          aggregates.set(key, {
            metricKey: row.metricKey,
            dimensions: rowDimensions,
            bucketStart,
            value: new Prisma.Decimal(row.value),
            sampleCount: row.sampleCount,
            updatedAt: row.updatedAt,
          });
        }
      }
      await transaction.cg5MetricBucket.deleteMany({
        where: {
          tenantId,
          metricKey: { in: [...VOLUME_METRICS] },
          granularity: target,
          bucketStart: { gte: range.from, lt: range.to },
        },
      });
      for (const aggregate of aggregates.values()) {
        const dimensionKey = cg5DimensionKey(aggregate.dimensions);
        await transaction.cg5MetricBucket.create({
          data: {
            tenantId,
            metricKey: aggregate.metricKey,
            granularity: target,
            bucketStart: aggregate.bucketStart,
            ...aggregate.dimensions,
            dimensionKey,
            value: aggregate.value,
            sampleCount: aggregate.sampleCount,
            updatedAt: aggregate.updatedAt,
          },
        });
      }

      const policyRows = await transaction.cg5PolicyImpactBucket.findMany({
        where: { tenantId, granularity: source, bucketStart: { gte: range.from, lt: range.to } },
      });
      const policyAggregates = new Map<string, PolicyAggregate>();
      for (const row of policyRows) {
        const bucketStart = cg5BucketStart(row.bucketStart, target);
        const key = `${bucketStart.toISOString()}:${row.policyVersion}:${row.decision}`;
        const current = policyAggregates.get(key);
        if (current) current.value += row.value;
        else {
          policyAggregates.set(key, {
            bucketStart,
            policyVersion: row.policyVersion,
            decision: row.decision,
            value: row.value,
          });
        }
      }
      await transaction.cg5PolicyImpactBucket.deleteMany({
        where: { tenantId, granularity: target, bucketStart: { gte: range.from, lt: range.to } },
      });
      for (const aggregate of policyAggregates.values()) {
        await transaction.cg5PolicyImpactBucket.create({
          data: { tenantId, granularity: target, ...aggregate },
        });
      }
    });
  }
}
