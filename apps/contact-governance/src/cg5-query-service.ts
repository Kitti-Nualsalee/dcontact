import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { Cg5Granularity, Cg5MetricKey } from '@d-contact/cxa-contracts';
import { Cg5ProjectionMaintenance } from './cg5-projection-maintenance.js';

export type Cg5QueryScope = { kind: 'TENANT' } | { kind: 'TEAM'; teamId: string };

export class Cg5ProjectionNotReadyError extends Error {
  readonly code = 'CG5_PROJECTION_NOT_READY';

  constructor(readonly state: string) {
    super(`CG5 projection ยังไม่พร้อม: ${state}`);
    this.name = 'Cg5ProjectionNotReadyError';
  }
}

export interface Cg5PageCursor {
  occurredAt: Date;
  id: string;
}

export interface Cg5MetricQuery {
  metricKey?: Cg5MetricKey;
  granularity: Cg5Granularity;
  from?: Date;
  to?: Date;
  channel?: string;
  purpose?: string;
  teamId?: string;
  cursor?: Cg5PageCursor;
  limit: number;
}

export interface Cg5AlertQuery {
  states?: readonly ('OPEN' | 'ACKED' | 'RESOLVED' | 'SUPPRESSED')[];
  severities?: readonly ('WARNING' | 'CRITICAL')[];
  cursor?: Cg5PageCursor;
  limit: number;
}

function cursorWhere(cursor: Cg5PageCursor | undefined, field: 'bucketStart' | 'updatedAt') {
  if (!cursor) return undefined;
  return {
    OR: [{ [field]: { lt: cursor.occurredAt } }, { [field]: cursor.occurredAt, id: { lt: cursor.id } }],
  };
}

function pageCursor(row: { id: string; bucketStart?: Date; updatedAt?: Date }): Cg5PageCursor {
  return { id: row.id, occurredAt: row.bucketStart ?? row.updatedAt! };
}

/** Projection reader for CG5.7. It deliberately exposes only aggregate data and never accepts tenantId from HTTP. */
export class Cg5QueryService {
  private readonly maintenance: Cg5ProjectionMaintenance;

  constructor(private readonly database: PrismaClient) {
    this.maintenance = new Cg5ProjectionMaintenance(database);
  }

  async metrics(tenantId: string, scope: Cg5QueryScope, query: Cg5MetricQuery) {
    await this.assertReady(tenantId);
    if (scope.kind === 'TEAM' && query.teamId && query.teamId !== scope.teamId) {
      throw new TypeError('team scope ไม่อนุญาต');
    }
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const rows = await tx.cg5MetricBucket.findMany({
        where: {
          tenantId,
          granularity: query.granularity,
          ...(query.metricKey ? { metricKey: query.metricKey } : {}),
          ...(query.from || query.to
            ? { bucketStart: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } }
            : {}),
          ...(query.channel ? { channel: query.channel } : {}),
          ...(query.purpose ? { purpose: query.purpose } : {}),
          ...(scope.kind === 'TEAM' ? { teamId: scope.teamId } : query.teamId ? { teamId: query.teamId } : {}),
          ...(cursorWhere(query.cursor, 'bucketStart') ?? {}),
        },
        orderBy: [{ bucketStart: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        asOf: page.reduce<Date | null>((latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest), null),
        items: page.map((row) => ({
          metricKey: row.metricKey,
          granularity: row.granularity,
          bucketStart: row.bucketStart,
          channel: row.channel,
          purpose: row.purpose,
          decision: row.decision,
          gate: row.gate,
          reasonCode: row.reasonCode,
          teamId: row.teamId,
          value: row.value.toString(),
          sampleCount: row.sampleCount.toString(),
          updatedAt: row.updatedAt,
        })),
        nextCursor: rows.length > query.limit && last ? pageCursor(last) : null,
      };
    });
  }

  async policyImpact(
    tenantId: string,
    scope: Cg5QueryScope,
    query: { granularity: Cg5Granularity; from?: Date; to?: Date; cursor?: Cg5PageCursor; limit: number },
  ) {
    await this.assertReady(tenantId);
    // These buckets intentionally have no team dimension. Returning them to a supervisor would leak tenant totals.
    if (scope.kind === 'TEAM') throw new TypeError('team scope ไม่อนุญาต');
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const rows = await tx.cg5PolicyImpactBucket.findMany({
        where: {
          tenantId,
          granularity: query.granularity,
          ...(query.from || query.to
            ? { bucketStart: { ...(query.from ? { gte: query.from } : {}), ...(query.to ? { lt: query.to } : {}) } }
            : {}),
          ...(cursorWhere(query.cursor, 'bucketStart') ?? {}),
        },
        orderBy: [{ bucketStart: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        asOf: page.reduce<Date | null>((latest, row) => (!latest || row.bucketStart > latest ? row.bucketStart : latest), null),
        items: page.map((row) => ({
          bucketStart: row.bucketStart,
          policyVersion: row.policyVersion,
          decision: row.decision,
          value: row.value.toString(),
        })),
        nextCursor: rows.length > query.limit && last ? pageCursor(last) : null,
      };
    });
  }

  async alerts(tenantId: string, scope: Cg5QueryScope, query: Cg5AlertQuery) {
    await this.assertReady(tenantId);
    return withTenantDatabaseTransaction(this.database, tenantId, async (tx) => {
      const rows = await tx.cg5AlertState.findMany({
        where: {
          tenantId,
          ...(scope.kind === 'TEAM' ? { teamId: scope.teamId } : {}),
          ...(query.states ? { state: { in: [...query.states] } } : {}),
          ...(query.severities ? { severity: { in: [...query.severities] } } : {}),
          ...(cursorWhere(query.cursor, 'updatedAt') ?? {}),
        },
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      });
      const page = rows.slice(0, query.limit);
      const last = page.at(-1);
      return {
        asOf: page.reduce<Date | null>((latest, row) => (!latest || row.updatedAt > latest ? row.updatedAt : latest), null),
        items: page.map((row) => ({
          id: row.id,
          ruleCode: row.ruleCode,
          state: row.state,
          severity: row.severity,
          channel: row.channel,
          purpose: row.purpose,
          teamId: row.teamId,
          value: row.value.toString(),
          threshold: row.threshold.toString(),
          consecutiveHits: row.consecutiveHits,
          openedAt: row.openedAt,
          ackedAt: row.ackedAt,
          resolvedAt: row.resolvedAt,
          version: row.version,
          updatedAt: row.updatedAt,
        })),
        nextCursor: rows.length > query.limit && last ? pageCursor(last) : null,
      };
    });
  }

  private async assertReady(tenantId: string): Promise<void> {
    const readiness = await this.maintenance.readiness(tenantId);
    if (readiness.state !== 'READY') throw new Cg5ProjectionNotReadyError(readiness.state);
  }
}
