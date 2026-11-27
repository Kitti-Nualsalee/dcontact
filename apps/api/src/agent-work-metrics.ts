import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@d-contact/db';

/**
 * #964 defines the "my work" numbers in one place (ADR-019 item 1) — the history list and summary use this CTE and filter set
 * finished work = an Agent's VOICE or WEBCHAT (#1044) work that is COMPLETED and has a wrap-up result (or is LEGACY work from before the result recording system)
 * work falls in a period by recorded_at; conversation time = ended_at - answered_at when both values exist
 */
export type WorkActor = { tenantId: string; userId: string };

export const SUMMARY_PERIODS = ['today', '7d', '30d', 'all'] as const;
export type SummaryPeriod = (typeof SUMMARY_PERIODS)[number];
export const DEFAULT_SUMMARY_PERIOD: SummaryPeriod = '7d';
/** used to filter work with no wrap-up result (old work) — a real wrap-up result has no leading underscore */
export const NO_DISPOSITION = '__none__';
/** wrap_up_code is TEXT; the LEGACY endpoint accepts up to 80 characters — leaving room for values already stored */
export const MAX_DISPOSITION_LENGTH = 256;

export interface WorkFilter {
  from: Date | null;
  to: Date | null;
  /** undefined = every wrap-up result, null = work with no wrap-up result */
  disposition?: string | null;
  /** #986 only this Agent's work within the team scope */
  agentId?: string;
  /** #1044 only work of this channel */
  channel?: WorkChannel;
}

export const WORK_CHANNELS = ['VOICE', 'WEBCHAT'] as const;
export type WorkChannel = (typeof WORK_CHANNELS)[number];

export function channelFrom(value: unknown): WorkChannel | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && (WORK_CHANNELS as readonly string[]).includes(value))
    return value as WorkChannel;
  throw new BadRequestException({ code: 'INVALID_CHANNEL' });
}

const PERIOD_DAYS: Record<Exclude<SummaryPeriod, 'all'>, number> = {
  today: 0,
  '7d': 6,
  '30d': 29,
};

export function summaryPeriodFrom(value: unknown): SummaryPeriod {
  if (value === undefined) return DEFAULT_SUMMARY_PERIOD;
  if (typeof value === 'string' && (SUMMARY_PERIODS as readonly string[]).includes(value))
    return value as SummaryPeriod;
  throw new BadRequestException({ code: 'INVALID_PERIOD' });
}

/** the tenant time zone if Intl knows it, otherwise UTC, and reports the value actually used back */
export function resolveTimeZone(value: string | null | undefined): string {
  if (!value) return 'UTC';
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: value }).resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

function wallClock(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((entry) => entry.type === type)?.value);
  return {
    year: part('year'),
    month: part('month'),
    day: part('day'),
    utc: Date.UTC(
      part('year'),
      part('month') - 1,
      part('day'),
      part('hour'),
      part('minute'),
      part('second'),
    ),
  };
}

/** midnight in the time zone, for the day daysBack days before the day of the instant (a negative value = a later day) */
export function zonedDayStart(instant: Date, timeZone: string, daysBack: number): Date {
  const today = wallClock(instant.getTime(), timeZone);
  const target = Date.UTC(today.year, today.month - 1, today.day - daysBack);
  const targetDay = new Date(target).toISOString().slice(0, 10);
  const offset = (at: number) => wallClock(at, timeZone).utc - Math.floor(at / 1000) * 1000;
  const first = target - offset(target);
  const second = target - offset(first);
  // midnight that disappears at a DST change (e.g. America/Santiago) — use the first instant still within the target day
  const sameDay = [first, second].filter(
    (candidate) =>
      new Date(wallClock(candidate, timeZone).utc).toISOString().slice(0, 10) === targetDay,
  );
  return new Date(sameDay.length ? Math.min(...sameDay) : second);
}

/** the summary period ends at the as-of time — so lists using the same period do not include work that finished after the summary loaded */
export function periodWindow(period: SummaryPeriod, now: Date, timeZone: string): WorkFilter {
  return {
    from: period === 'all' ? null : zonedDayStart(now, timeZone, PERIOD_DAYS[period]),
    to: now,
  };
}

function instantFrom(value: unknown, code: string): Date | null {
  if (value === undefined) return null;
  if (typeof value === 'string' && value.length <= 32) {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime()) && parsed.toISOString() === value) return parsed;
  }
  throw new BadRequestException({ code });
}

export function dispositionFrom(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === NO_DISPOSITION) return null;
  // eslint-disable-next-line no-control-regex
  if (
    typeof value === 'string' &&
    value.length <= MAX_DISPOSITION_LENGTH &&
    /^[^\u0000-\u001f\u007f]+$/.test(value)
  )
    return value;
  throw new BadRequestException({ code: 'INVALID_DISPOSITION' });
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function uuidFrom(value: unknown, code: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'string' && UUID.test(value)) return value.toLowerCase();
  throw new BadRequestException({ code });
}

export function workFilterFrom(query: {
  from?: unknown;
  to?: unknown;
  disposition?: unknown;
  agentId?: unknown;
  channel?: unknown;
}): WorkFilter {
  const from = instantFrom(query.from, 'INVALID_FROM');
  const to = instantFrom(query.to, 'INVALID_TO');
  if (from && to && from >= to) throw new BadRequestException({ code: 'INVALID_RANGE' });
  const agentId = uuidFrom(query.agentId, 'INVALID_AGENT');
  const channel = channelFrom(query.channel);
  return {
    from,
    to,
    disposition: dispositionFrom(query.disposition),
    ...(agentId ? { agentId } : {}),
    ...(channel ? { channel } : {}),
  };
}

/** a value bound to the cursor so a cursor of one filter cannot be used with another filter */
export function filterKey(filter: WorkFilter): string {
  return [
    filter.from?.toISOString() ?? '',
    filter.to?.toISOString() ?? '',
    filter.disposition === undefined ? '*' : (filter.disposition ?? NO_DISPOSITION),
    // append only when present — so the key of my work (#964) stays the same and cursors already issued still work
    ...(filter.agentId ? [filter.agentId] : []),
    ...(filter.channel ? [`channel=${filter.channel}`] : []),
  ].join('|');
}

/**
 * the scope of finished work: a single Agent's work, or #986 work the team answered per the evidence
 * `voice_interaction_handling_attributions` (the Agent's team at answer time, not the current team)
 * `teamId: null` = every team of the tenant that has evidence — a call with no evidence or whose Agent had no team at answer time is not counted
 */
export type WorkScope = { agentId: string } | { teamId: string | null };

/** a row of an Agent's finished work — used as the CTE `work` */
export function completedWorkSql(actor: WorkActor): Prisma.Sql {
  return completedScopeWorkSql(actor.tenantId, { agentId: actor.userId });
}

/** the single definition of finished work (ADR-019 item 1), used by both my work (#964) and team work (#986) */
export function completedScopeWorkSql(tenantId: string, scope: WorkScope): Prisma.Sql {
  const team = 'teamId' in scope;
  return Prisma.sql`
    SELECT interaction.id AS interaction_id, interaction.agent_id, interaction.channel::text AS channel,
      ${team ? Prisma.sql`attribution.team_id` : Prisma.sql`NULL::uuid`} AS team_id,
      COALESCE(interaction.answered_at, interaction.queued_at) AS started_at,
      interaction.answered_at, interaction.ended_at, interaction.wrap_up_code AS disposition,
      COALESCE(result.recorded_at, completion.created_at AT TIME ZONE 'UTC',
        interaction.ended_at AT TIME ZONE 'UTC', interaction.queued_at AT TIME ZONE 'UTC') AS recorded_at,
      CASE WHEN result.interaction_id IS NOT NULL THEN 'SERVER_COMMIT'
        WHEN completion.created_at IS NOT NULL THEN 'LEGACY_EVENT' ELSE 'LEGACY_FALLBACK' END AS recorded_at_source,
      interaction.voice_wrapup_policy = 'LEGACY' AS legacy
    FROM interactions interaction
    LEFT JOIN interaction_wrapup_results result ON result.interaction_id = interaction.id
      AND result.tenant_id = interaction.tenant_id AND result.owner_agent_id = interaction.agent_id
    LEFT JOIN LATERAL (
      SELECT event.created_at FROM interaction_events event
      WHERE event.tenant_id = interaction.tenant_id AND event.interaction_id = interaction.id
        AND event.type = 'interaction.wrapup_completed'
      ORDER BY event.created_at, event.id LIMIT 1
    ) completion ON interaction.voice_wrapup_policy = 'LEGACY'
    ${
      team
        ? Prisma.sql`JOIN voice_interaction_handling_attributions attribution
      ON attribution.tenant_id = interaction.tenant_id AND attribution.interaction_id = interaction.id
        AND attribution.agent_id = interaction.agent_id AND attribution.team_id IS NOT NULL
        ${scope.teamId === null ? Prisma.empty : Prisma.sql`AND attribution.team_id = ${scope.teamId}::uuid`}`
        : Prisma.empty
    }
    WHERE interaction.tenant_id = ${tenantId}::uuid
      ${team ? Prisma.empty : Prisma.sql`AND interaction.agent_id = ${(scope as { agentId: string }).agentId}::uuid`}
      AND interaction.channel IN ('VOICE', 'WEBCHAT') AND interaction.state = 'COMPLETED'
      AND (interaction.voice_wrapup_policy = 'LEGACY' OR result.interaction_id IS NOT NULL)`;
}

/** conditions on the rows of the CTE `work` */
export function workFilterSql(filter: WorkFilter): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filter.from) conditions.push(Prisma.sql`recorded_at >= ${filter.from}::timestamptz`);
  if (filter.to) conditions.push(Prisma.sql`recorded_at < ${filter.to}::timestamptz`);
  if (filter.disposition === null) conditions.push(Prisma.sql`disposition IS NULL`);
  else if (filter.disposition !== undefined)
    conditions.push(Prisma.sql`disposition = ${filter.disposition}`);
  if (filter.agentId) conditions.push(Prisma.sql`agent_id = ${filter.agentId}::uuid`);
  if (filter.channel) conditions.push(Prisma.sql`channel = ${filter.channel}`);
  return conditions;
}

export function whereSql(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}
