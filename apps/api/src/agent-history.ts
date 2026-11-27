import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { findActiveAgent } from './active-agent.js';
import {
  completedWorkSql,
  filterKey,
  periodWindow,
  resolveTimeZone,
  summaryPeriodFrom,
  whereSql,
  workFilterFrom,
  workFilterSql,
  channelFrom,
  type WorkActor,
  type WorkChannel,
} from './agent-work-metrics.js';
import { readWorkTranscript } from './work-transcript.js';

type Cursor = {
  version: 2;
  tenantId: string;
  userId: string;
  filter: string;
  recordedAt: string;
  interactionId: string;
};
const UNFILTERED = filterKey({ from: null, to: null });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cursorFrom(value: unknown, actor: WorkActor, filter: string): Cursor | undefined {
  if (value === undefined) return;
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    // a cursor v1 (before #964) has no filter — still accepted when the request has no filter, so a tab left open at deploy time does not hang on 400
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as { version: unknown }).version === 1 &&
      filter === UNFILTERED &&
      Object.keys(parsed).sort().join(',') === 'interactionId,recordedAt,tenantId,userId,version'
    )
      Object.assign(parsed, { version: 2, filter });
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !==
        'filter,interactionId,recordedAt,tenantId,userId,version' ||
      parsed.version !== 2 ||
      parsed.tenantId !== actor.tenantId ||
      parsed.userId !== actor.userId ||
      parsed.filter !== filter ||
      typeof parsed.interactionId !== 'string' ||
      !uuid.test(parsed.interactionId) ||
      typeof parsed.recordedAt !== 'string' ||
      new Date(parsed.recordedAt).toISOString() !== parsed.recordedAt
    )
      throw new Error();
    return parsed;
  } catch {
    throw new BadRequestException({ code: 'INVALID_CURSOR' });
  }
}

export interface AgentHistoryQuery {
  limit?: unknown;
  cursor?: unknown;
  from?: unknown;
  to?: unknown;
  disposition?: unknown;
  channel?: unknown;
}

export async function readAgentHistory(
  database: PrismaClient,
  actor: WorkActor,
  query: AgentHistoryQuery,
) {
  const limitValue = query.limit;
  const limit =
    limitValue === undefined
      ? 20
      : typeof limitValue === 'string' && /^(?:[1-9]|[1-9][0-9]|100)$/.test(limitValue)
        ? Number(limitValue)
        : undefined;
  if (limit === undefined) throw new BadRequestException({ code: 'INVALID_LIMIT' });
  const filter = workFilterFrom(query);
  const key = filterKey(filter);
  const cursor = cursorFrom(query.cursor, actor, key);
  return withTenantDatabaseTransaction(database, actor.tenantId, async (transaction) => {
    const agent = await findActiveAgent(transaction, actor);
    if (!agent) throw new ForbiddenException({ code: 'AGENT_REQUIRED' });
    const conditions = workFilterSql(filter);
    if (cursor)
      conditions.push(
        Prisma.sql`(recorded_at, interaction_id) < (${new Date(cursor.recordedAt)}::timestamptz, ${cursor.interactionId}::uuid)`,
      );
    const rows = await transaction.$queryRaw<
      {
        interaction_id: string;
        channel: WorkChannel;
        started_at: Date;
        ended_at: Date | null;
        disposition: string | null;
        recorded_at: Date;
        recorded_at_source: 'SERVER_COMMIT' | 'LEGACY_EVENT' | 'LEGACY_FALLBACK';
        legacy: boolean;
      }[]
    >(Prisma.sql`
      WITH work AS (${completedWorkSql(actor)})
      SELECT * FROM work ${whereSql(conditions)}
      ORDER BY recorded_at DESC, interaction_id DESC LIMIT ${limit + 1}
    `);
    const items = rows.slice(0, limit).map((row) => ({
      interactionId: row.interaction_id,
      channel: row.channel,
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      disposition: row.disposition,
      recordedAt: row.recorded_at.toISOString(),
      recordedAtSource: row.recorded_at_source,
      legacy: row.legacy,
    }));
    const last = items.at(-1);
    const nextCursor =
      rows.length > limit && last
        ? Buffer.from(
            JSON.stringify({
              version: 2,
              tenantId: actor.tenantId,
              userId: actor.userId,
              filter: key,
              recordedAt: last.recordedAt,
              interactionId: last.interactionId,
            } satisfies Cursor),
          ).toString('base64url')
        : null;
    return { items, nextCursor };
  });
}

/** #964 the summary of an Agent's finished work over a period — every number is counted from the same CTE and filters as the list */
export async function readAgentHistorySummary(
  database: PrismaClient,
  actor: WorkActor,
  periodValue: unknown,
  now: Date = new Date(),
  channelValue?: unknown,
) {
  const period = summaryPeriodFrom(periodValue);
  // #1044 the same channel filter as the list, so the numbers above the table match its rows
  const channel = channelFrom(channelValue);
  return withTenantDatabaseTransaction(database, actor.tenantId, async (transaction) => {
    const agent = await findActiveAgent(transaction, actor);
    if (!agent) throw new ForbiddenException({ code: 'AGENT_REQUIRED' });
    const settings = await transaction.tenantSettings.findUnique({
      where: { tenantId: actor.tenantId },
      select: { timezone: true },
    });
    const timeZone = resolveTimeZone(settings?.timezone);
    const window = { ...periodWindow(period, now, timeZone), ...(channel ? { channel } : {}) };
    const rows = await transaction.$queryRaw<
      {
        disposition: string | null;
        completed: number;
        talk_measured: number;
        talk_seconds: number | null;
      }[]
    >(Prisma.sql`
      WITH work AS (${completedWorkSql(actor)})
      SELECT disposition, count(*)::int AS completed,
        count(*) FILTER (WHERE answered_at IS NOT NULL AND ended_at >= answered_at)::int AS talk_measured,
        sum(EXTRACT(EPOCH FROM (ended_at - answered_at)))
          FILTER (WHERE answered_at IS NOT NULL AND ended_at >= answered_at)::float8 AS talk_seconds
      FROM work ${whereSql(workFilterSql(window))}
      GROUP BY disposition
    `);
    const completed = rows.reduce((total, row) => total + row.completed, 0);
    const measured = rows.reduce((total, row) => total + row.talk_measured, 0);
    const seconds = rows.reduce((total, row) => total + (row.talk_seconds ?? 0), 0);
    return {
      period: {
        key: period,
        from: window.from?.toISOString() ?? null,
        to: window.to?.toISOString() ?? null,
        timeZone,
      },
      completed,
      talk: {
        averageSeconds: measured ? Math.round(seconds / measured) : null,
        measuredCount: measured,
      },
      byDisposition: rows
        .map((row) => ({ disposition: row.disposition, count: row.completed }))
        .sort(
          (left, right) =>
            right.count - left.count ||
            (left.disposition ?? '￿').localeCompare(right.disposition ?? '￿'),
        ),
    };
  });
}

/** #1044 the messages of one of the Agent's own finished chats; a call has none */
export async function readAgentHistoryTranscript(
  database: PrismaClient,
  actor: WorkActor,
  interactionValue: unknown,
) {
  const interactionId =
    typeof interactionValue === 'string' && uuid.test(interactionValue)
      ? interactionValue.toLowerCase()
      : undefined;
  if (!interactionId) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
  return withTenantDatabaseTransaction(database, actor.tenantId, async (transaction) => {
    const agent = await findActiveAgent(transaction, actor);
    if (!agent) throw new ForbiddenException({ code: 'AGENT_REQUIRED' });
    const rows = await transaction.$queryRaw<{ channel: WorkChannel }[]>(Prisma.sql`
      WITH work AS (${completedWorkSql(actor)})
      SELECT channel FROM work WHERE interaction_id = ${interactionId}::uuid
    `);
    // another Agent's work, another tenant's and a missing item all answer the same
    if (!rows[0]) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return readWorkTranscript(transaction, actor.tenantId, interactionId, rows[0].channel);
  });
}
