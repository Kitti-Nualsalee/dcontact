import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
} from '@nestjs/common';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  completedScopeWorkSql,
  filterKey,
  periodWindow,
  resolveTimeZone,
  summaryPeriodFrom,
  uuidFrom,
  whereSql,
  workFilterFrom,
  workFilterSql,
} from './agent-work-metrics.js';

/**
 * #986 ประวัติและสรุปงานของทีม (owner ตัดสิน #859 วันที่ 22 พ.ย. 2569)
 *
 * - "ของทีม" = ทีมของ Agent ตอนรับสาย ตามหลักฐาน `voice_interaction_handling_attributions` (#967)
 *   สายที่ไม่มีหลักฐานไม่นับ และไม่เติมย้อนหลังจากทีมปัจจุบัน
 * - Supervisor ที่ active เห็นเฉพาะทีมปัจจุบันของตน ส่วน Admin ที่ active เห็นทุกทีมของ tenant
 *   บทบาท สถานะ และทีมอ่านจาก DB ทุก request ไม่เชื่อ role ใน token อย่างเดียว
 * - ทีมอื่น tenant อื่น และรายการที่ไม่มีจริง ตอบ 404 เหมือนกัน
 * - นับงานด้วยนิยามเดียวกับงานของฉัน (#964, `agent-work-metrics.ts`)
 */
export const TEAM_HISTORY_DATABASE = Symbol('TEAM_HISTORY_DATABASE');

type Actor = { tenantId: string; userId: string };
/** ทีมที่ผู้ขอดูได้: `all` = Admin ทุกทีม, `team` = ทีมเดียว */
type Access = { kind: 'admin' } | { kind: 'supervisor'; teamId: string };
type Cursor = {
  version: 1;
  tenantId: string;
  userId: string;
  scope: string;
  filter: string;
  recordedAt: string;
  interactionId: string;
};

const denied = () => new ForbiddenException({ code: 'TEAM_HISTORY_ACCESS_DENIED' });
const notFound = () => new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });

async function accessOf(tx: Prisma.TransactionClient, actor: Actor): Promise<Access> {
  const user = await tx.user.findFirst({
    where: { id: actor.userId, tenantId: actor.tenantId, isActive: true },
    select: { role: true, teamId: true },
  });
  if (user?.role === 'ADMIN') return { kind: 'admin' };
  if (user?.role === 'SUPERVISOR' && user.teamId)
    return { kind: 'supervisor', teamId: user.teamId };
  throw denied();
}

/**
 * ทีมที่จะอ่าน — Supervisor ระบุได้เฉพาะทีมตัวเอง (ไม่ระบุ = ทีมตัวเอง), Admin ไม่ระบุ = ทุกทีม
 * ทีมที่ระบุแต่ไม่มีใน tenant หรือไม่ใช่ของ Supervisor ตอบ 404
 */
async function teamScope(
  tx: Prisma.TransactionClient,
  actor: Actor,
  access: Access,
  requested: string | undefined,
): Promise<string | null> {
  if (access.kind === 'supervisor') {
    if (requested && requested !== access.teamId) throw notFound();
    return access.teamId;
  }
  if (!requested) return null;
  const team = await tx.team.findFirst({
    where: { id: requested, tenantId: actor.tenantId },
    select: { id: true },
  });
  if (!team) throw notFound();
  return team.id;
}

const scopeKey = (teamId: string | null) => teamId ?? '*';

/** เวลาสนทนา = วางสาย − รับสาย (นิยามเดียวกับค่าเฉลี่ยในสรุป) */
function talkSecondsOf(answeredAt: Date | null, endedAt: Date | null): number | null {
  return answeredAt && endedAt && endedAt >= answeredAt
    ? Math.round((endedAt.getTime() - answeredAt.getTime()) / 1000)
    : null;
}

function cursorFrom(value: unknown, actor: Actor, scope: string, filter: string) {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !==
        'filter,interactionId,recordedAt,scope,tenantId,userId,version' ||
      parsed.version !== 1 ||
      parsed.tenantId !== actor.tenantId ||
      parsed.userId !== actor.userId ||
      parsed.scope !== scope ||
      parsed.filter !== filter ||
      typeof parsed.interactionId !== 'string' ||
      uuidFrom(parsed.interactionId, 'INVALID_CURSOR') === undefined ||
      typeof parsed.recordedAt !== 'string' ||
      new Date(parsed.recordedAt).toISOString() !== parsed.recordedAt
    )
      throw new Error();
    return parsed;
  } catch {
    throw new BadRequestException({ code: 'INVALID_CURSOR' });
  }
}

export interface TeamHistoryQuery {
  teamId?: unknown;
  agentId?: unknown;
  limit?: unknown;
  cursor?: unknown;
  from?: unknown;
  to?: unknown;
  disposition?: unknown;
}

/** ทีมที่ผู้ขอดูได้ — Supervisor ได้ทีมเดียว Admin ได้ทุกทีมของ tenant */
export async function readTeamHistoryTeams(database: PrismaClient, actor: Actor) {
  return withTenantDatabaseTransaction(database, actor.tenantId, async (tx) => {
    const access = await accessOf(tx, actor);
    const teams = await tx.team.findMany({
      where: {
        tenantId: actor.tenantId,
        ...(access.kind === 'supervisor' ? { id: access.teamId } : {}),
      },
      select: { id: true, name: true, isActive: true },
      orderBy: [{ name: 'asc' }, { id: 'asc' }],
    });
    return { allTeams: access.kind === 'admin', items: teams };
  });
}

export async function readTeamHistory(
  database: PrismaClient,
  actor: Actor,
  query: TeamHistoryQuery,
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
  const requestedTeam = uuidFrom(query.teamId, 'INVALID_TEAM');
  return withTenantDatabaseTransaction(database, actor.tenantId, async (tx) => {
    const access = await accessOf(tx, actor);
    const teamId = await teamScope(tx, actor, access, requestedTeam);
    const key = filterKey(filter);
    const cursor = cursorFrom(query.cursor, actor, scopeKey(teamId), key);
    const conditions = workFilterSql(filter);
    if (cursor)
      conditions.push(
        Prisma.sql`(recorded_at, interaction_id) < (${new Date(cursor.recordedAt)}::timestamptz, ${cursor.interactionId}::uuid)`,
      );
    const rows = await tx.$queryRaw<
      {
        interaction_id: string;
        agent_id: string;
        agent_name: string | null;
        team_id: string;
        team_name: string | null;
        started_at: Date;
        answered_at: Date | null;
        ended_at: Date | null;
        disposition: string | null;
        recorded_at: Date;
        recorded_at_source: 'SERVER_COMMIT' | 'LEGACY_EVENT' | 'LEGACY_FALLBACK';
        legacy: boolean;
      }[]
    >(Prisma.sql`
      WITH work AS (${completedScopeWorkSql(actor.tenantId, { teamId })})
      SELECT work.*, agent.display_name AS agent_name, team.name AS team_name
      FROM work
      LEFT JOIN users agent ON agent.tenant_id = ${actor.tenantId}::uuid AND agent.id = work.agent_id
      LEFT JOIN teams team ON team.tenant_id = ${actor.tenantId}::uuid AND team.id = work.team_id
      ${whereSql(conditions)}
      ORDER BY recorded_at DESC, interaction_id DESC LIMIT ${limit + 1}
    `);
    const items = rows.slice(0, limit).map((row) => ({
      interactionId: row.interaction_id,
      agent: { id: row.agent_id, displayName: row.agent_name },
      team: { id: row.team_id, name: row.team_name },
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      talkSeconds: talkSecondsOf(row.answered_at, row.ended_at),
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
              version: 1,
              tenantId: actor.tenantId,
              userId: actor.userId,
              scope: scopeKey(teamId),
              filter: key,
              recordedAt: last.recordedAt,
              interactionId: last.interactionId,
            } satisfies Cursor),
          ).toString('base64url')
        : null;
    return { teamId, items, nextCursor };
  });
}

/** สรุปงานที่จบของทีมในช่วงเวลา แยกตามผลบันทึกและตาม Agent — นับจาก CTE และตัวกรองเดียวกับรายการ */
export async function readTeamHistorySummary(
  database: PrismaClient,
  actor: Actor,
  query: { teamId?: unknown; period?: unknown },
  now: Date = new Date(),
) {
  const period = summaryPeriodFrom(query.period);
  const requestedTeam = uuidFrom(query.teamId, 'INVALID_TEAM');
  return withTenantDatabaseTransaction(database, actor.tenantId, async (tx) => {
    const access = await accessOf(tx, actor);
    const teamId = await teamScope(tx, actor, access, requestedTeam);
    const settings = await tx.tenantSettings.findUnique({
      where: { tenantId: actor.tenantId },
      select: { timezone: true },
    });
    const timeZone = resolveTimeZone(settings?.timezone);
    const window = periodWindow(period, now, timeZone);
    const rows = await tx.$queryRaw<
      {
        agent_id: string;
        agent_name: string | null;
        disposition: string | null;
        completed: number;
        talk_measured: number;
        talk_seconds: number | null;
      }[]
    >(Prisma.sql`
      WITH work AS (${completedScopeWorkSql(actor.tenantId, { teamId })})
      SELECT work.agent_id, agent.display_name AS agent_name, work.disposition,
        count(*)::int AS completed,
        count(*) FILTER (WHERE answered_at IS NOT NULL AND ended_at >= answered_at)::int AS talk_measured,
        sum(EXTRACT(EPOCH FROM (ended_at - answered_at)))
          FILTER (WHERE answered_at IS NOT NULL AND ended_at >= answered_at)::float8 AS talk_seconds
      FROM work
      LEFT JOIN users agent ON agent.tenant_id = ${actor.tenantId}::uuid AND agent.id = work.agent_id
      ${whereSql(workFilterSql(window))}
      GROUP BY work.agent_id, agent.display_name, work.disposition
    `);
    const total = (selected: typeof rows) => ({
      completed: selected.reduce((sum, row) => sum + row.completed, 0),
      measured: selected.reduce((sum, row) => sum + row.talk_measured, 0),
      seconds: selected.reduce((sum, row) => sum + (row.talk_seconds ?? 0), 0),
    });
    const talk = (value: ReturnType<typeof total>) => ({
      averageSeconds: value.measured ? Math.round(value.seconds / value.measured) : null,
      measuredCount: value.measured,
    });
    const all = total(rows);
    const dispositions = new Map<string | null, number>();
    const agents = new Map<string, { name: string | null; rows: typeof rows }>();
    for (const row of rows) {
      dispositions.set(row.disposition, (dispositions.get(row.disposition) ?? 0) + row.completed);
      const agent = agents.get(row.agent_id) ?? { name: row.agent_name, rows: [] };
      agent.rows.push(row);
      agents.set(row.agent_id, agent);
    }
    return {
      teamId,
      period: {
        key: period,
        from: window.from?.toISOString() ?? null,
        to: window.to?.toISOString() ?? null,
        timeZone,
      },
      completed: all.completed,
      talk: talk(all),
      byDisposition: [...dispositions]
        .map(([disposition, count]) => ({ disposition, count }))
        .sort(
          (left, right) =>
            right.count - left.count ||
            (left.disposition ?? '￿').localeCompare(right.disposition ?? '￿'),
        ),
      byAgent: [...agents]
        .map(([agentId, agent]) => {
          const value = total(agent.rows);
          return {
            agent: { id: agentId, displayName: agent.name },
            completed: value.completed,
            talk: talk(value),
          };
        })
        .sort(
          (left, right) =>
            right.completed - left.completed ||
            (left.agent.displayName ?? '').localeCompare(right.agent.displayName ?? '') ||
            left.agent.id.localeCompare(right.agent.id),
        ),
    };
  });
}

/** ผลบันทึกและโน้ตของงานหนึ่งรายการ — เปิดได้เมื่อรายการนั้นอยู่ในขอบเขตทีมของผู้ขอ */
export async function readTeamHistoryItem(
  database: PrismaClient,
  actor: Actor,
  interactionValue: unknown,
) {
  const interactionId = uuidFrom(interactionValue, 'INVALID_INTERACTION');
  if (!interactionId) throw notFound();
  return withTenantDatabaseTransaction(database, actor.tenantId, async (tx) => {
    const access = await accessOf(tx, actor);
    const teamId = access.kind === 'supervisor' ? access.teamId : null;
    const rows = await tx.$queryRaw<
      {
        interaction_id: string;
        agent_id: string;
        agent_name: string | null;
        team_id: string;
        team_name: string | null;
        started_at: Date;
        answered_at: Date | null;
        ended_at: Date | null;
        disposition: string | null;
        note: string | null;
        recorded_at: Date;
        recorded_at_source: 'SERVER_COMMIT' | 'LEGACY_EVENT' | 'LEGACY_FALLBACK';
        legacy: boolean;
      }[]
    >(Prisma.sql`
      WITH work AS (${completedScopeWorkSql(actor.tenantId, { teamId })})
      SELECT work.*, agent.display_name AS agent_name, team.name AS team_name, result.note
      FROM work
      LEFT JOIN users agent ON agent.tenant_id = ${actor.tenantId}::uuid AND agent.id = work.agent_id
      LEFT JOIN teams team ON team.tenant_id = ${actor.tenantId}::uuid AND team.id = work.team_id
      LEFT JOIN interaction_wrapup_results result ON result.tenant_id = ${actor.tenantId}::uuid
        AND result.interaction_id = work.interaction_id AND result.owner_agent_id = work.agent_id
      WHERE work.interaction_id = ${interactionId}::uuid
    `);
    const row = rows[0];
    if (!row) throw notFound();
    return {
      interactionId: row.interaction_id,
      agent: { id: row.agent_id, displayName: row.agent_name },
      team: { id: row.team_id, name: row.team_name },
      startedAt: row.started_at.toISOString(),
      endedAt: row.ended_at?.toISOString() ?? null,
      talkSeconds: talkSecondsOf(row.answered_at, row.ended_at),
      disposition: row.disposition,
      note: row.note,
      recordedAt: row.recorded_at.toISOString(),
      recordedAtSource: row.recorded_at_source,
      legacy: row.legacy,
    };
  });
}

function actorOf(request: AuthenticatedGatewayRequest): Actor {
  const identity = request.gatewayIdentity;
  if (!identity) throw denied();
  return { tenantId: identity.tenantId, userId: identity.userId };
}

@Controller('api/v1/team-history')
@GatewayRoles('admin', 'supervisor')
export class TeamHistoryController {
  constructor(@Inject(TEAM_HISTORY_DATABASE) private readonly database: PrismaClient) {}

  @Get('teams')
  @Header('Cache-Control', 'no-store')
  teams(@Req() request: AuthenticatedGatewayRequest) {
    return readTeamHistoryTeams(this.database, actorOf(request));
  }

  @Get('items')
  @Header('Cache-Control', 'no-store')
  items(@Req() request: AuthenticatedGatewayRequest, @Query() query: Record<string, unknown>) {
    return readTeamHistory(this.database, actorOf(request), {
      teamId: query.teamId,
      agentId: query.agentId,
      limit: query.limit,
      cursor: query.cursor,
      from: query.from,
      to: query.to,
      disposition: query.disposition,
    });
  }

  @Get('summary')
  @Header('Cache-Control', 'no-store')
  summary(@Req() request: AuthenticatedGatewayRequest, @Query() query: Record<string, unknown>) {
    return readTeamHistorySummary(this.database, actorOf(request), {
      teamId: query.teamId,
      period: query.period,
    });
  }

  @Get('items/:interactionId')
  @Header('Cache-Control', 'no-store')
  item(@Req() request: AuthenticatedGatewayRequest, @Param('interactionId') id: string) {
    return readTeamHistoryItem(this.database, actorOf(request), id);
  }
}
