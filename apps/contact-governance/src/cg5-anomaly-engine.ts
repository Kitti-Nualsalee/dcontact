import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { CG5_RULE_CODES, cg5RuleMetadata, type Cg5RuleCode } from '@d-contact/cxa-contracts';
import { evaluateCg5Anomaly } from './cg5-anomaly-evaluator.js';
import { Cg5AlertRepository } from './cg5-alert-repository.js';
import { Cg5ProjectionMaintenance } from './cg5-projection-maintenance.js';
import { PrismaCg5TenantConfigRepository } from './cg5-tenant-config-repository.js';

const BASELINE_RULES = new Set<Cg5RuleCode>(
  CG5_RULE_CODES.filter((code) => cg5RuleMetadata(code).kind === 'BASELINE_RELATIVE'),
);

export class Cg5AnomalyEngine {
  private readonly alerts: Cg5AlertRepository;
  private readonly config: PrismaCg5TenantConfigRepository;
  private readonly maintenance: Cg5ProjectionMaintenance;
  constructor(
    private readonly database: PrismaClient,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.alerts = new Cg5AlertRepository(database, now);
    this.config = new PrismaCg5TenantConfigRepository(database);
    this.maintenance = new Cg5ProjectionMaintenance(database, now);
  }

  async evaluateTenant(tenantId: string): Promise<void> {
    const now = this.now();
    const [{ config }, readiness, snapshot] = await Promise.all([
      this.config.read(tenantId),
      this.maintenance.readiness(tenantId),
      this.readSnapshot(tenantId, now),
    ]);
    const lagSeconds = readiness.updatedAt
      ? Math.max(0, Math.floor((now.valueOf() - readiness.updatedAt.valueOf()) / 1000))
      : Number.MAX_SAFE_INTEGER;
    const dataGap = readiness.state !== 'READY' || snapshot.scopePaused;
    const baselineUnavailable = [...BASELINE_RULES].some(
      (code) => snapshot.baseline.get(cg5RuleMetadata(code).metricKey!) === null,
    );
    for (const ruleCode of CG5_RULE_CODES) {
      const metadata = cg5RuleMetadata(ruleCode);
      const key = metadata.metricKey;
      const value =
        ruleCode === 'CG5_BASELINE_UNAVAILABLE'
          ? baselineUnavailable
            ? 1
            : 0
          : key
            ? (snapshot.current.get(key) ?? 0)
            : 0;
      const result = evaluateCg5Anomaly(
        {
          ruleCode,
          value,
          baseline: key ? (snapshot.baseline.get(key) ?? null) : null,
          volume: key ? (snapshot.current.get(key) ?? 0) : 0,
          projectionLagSeconds: lagSeconds,
          scopePaused: dataGap,
        },
        config,
        null,
      );
      await this.alerts.record({
        tenantId,
        ruleCode,
        scope: { channel: null, purpose: null, teamId: null },
        state: result.state,
        severity: metadata.defaultSeverity,
        value: result.value,
        threshold: result.threshold,
      });
    }
  }

  private async readSnapshot(tenantId: string, now: Date) {
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const from = new Date(now.valueOf() - 300_000);
      const currentRows = await tx.cg5MetricBucket.groupBy({
        by: ['metricKey'],
        where: { tenantId, granularity: 'FIVE_MIN', bucketStart: { gte: from, lte: now } },
        _sum: { value: true },
      });
      const current = new Map(
        currentRows.map((row) => [row.metricKey, Number(row._sum.value ?? 0)]),
      );
      const baseline = new Map<string, number | null>();
      for (const key of new Set(
        [...BASELINE_RULES].map((code) => cg5RuleMetadata(code).metricKey!),
      )) {
        const weeks = await Promise.all(
          [1, 2, 3, 4].map(async (week) =>
            tx.cg5MetricBucket.aggregate({
              where: {
                tenantId,
                metricKey: key,
                granularity: 'FIVE_MIN',
                bucketStart: {
                  gte: new Date(from.valueOf() - week * 604800000),
                  lte: new Date(now.valueOf() - week * 604800000),
                },
              },
              _sum: { value: true },
            }),
          ),
        );
        const values = weeks
          .map((row) => row._sum.value)
          .filter((value): value is NonNullable<typeof value> => value !== null);
        baseline.set(
          key,
          values.length === 4 ? values.reduce((sum, value) => sum + Number(value), 0) / 4 : null,
        );
      }
      return {
        current,
        baseline,
        scopePaused: (await tx.cgScopePause.count({ where: { tenantId, state: 'ACTIVE' } })) > 0,
      };
    });
  }
}
