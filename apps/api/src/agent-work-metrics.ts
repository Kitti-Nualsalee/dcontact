import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@d-contact/db';

/**
 * #964 นิยามตัวเลข "งานของฉัน" ที่เดียว (ADR-019 ข้อ 1) — รายการประวัติและสรุปใช้ CTE และตัวกรองชุดนี้
 * งานที่จบ = งาน VOICE ของ Agent ที่ COMPLETED และมีผลบันทึก (หรือเป็นงาน LEGACY ก่อนระบบบันทึกผล)
 * งานเข้าช่วงเวลาตาม recorded_at; เวลาสนทนา = ended_at - answered_at เมื่อมีทั้งสองค่า
 */
export type WorkActor = { tenantId: string; userId: string };

export const SUMMARY_PERIODS = ['today', '7d', '30d', 'all'] as const;
export type SummaryPeriod = (typeof SUMMARY_PERIODS)[number];
export const DEFAULT_SUMMARY_PERIOD: SummaryPeriod = '7d';
/** ใช้กรองงานที่ไม่มีผลบันทึก (งานเดิม) — ผลบันทึกจริงไม่มีขีดล่างนำหน้า */
export const NO_DISPOSITION = '__none__';
/** wrap_up_code เป็น TEXT; endpoint LEGACY รับได้ถึง 80 ตัว — เผื่อค่าที่เก็บอยู่แล้ว */
export const MAX_DISPOSITION_LENGTH = 256;

export interface WorkFilter {
  from: Date | null;
  to: Date | null;
  /** undefined = ทุกผลบันทึก, null = งานที่ไม่มีผลบันทึก */
  disposition?: string | null;
  /** #986 เฉพาะงานของ Agent คนนี้ในขอบเขตทีม */
  agentId?: string;
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

/** เขตเวลาของ tenant ที่ Intl รู้จัก ไม่เช่นนั้นใช้ UTC และรายงานค่าที่ใช้จริงกลับไป */
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

/** เวลาเที่ยงคืนตามเขตเวลา ของวันที่ย้อนจากวันของ instant ไป daysBack วัน (ค่าลบ = วันถัดไป) */
export function zonedDayStart(instant: Date, timeZone: string, daysBack: number): Date {
  const today = wallClock(instant.getTime(), timeZone);
  const target = Date.UTC(today.year, today.month - 1, today.day - daysBack);
  const targetDay = new Date(target).toISOString().slice(0, 10);
  const offset = (at: number) => wallClock(at, timeZone).utc - Math.floor(at / 1000) * 1000;
  const first = target - offset(target);
  const second = target - offset(first);
  // เที่ยงคืนที่หายไปตอนเปลี่ยน DST (เช่น America/Santiago) — ใช้ instant แรกที่ยังอยู่ในวันเป้าหมาย
  const sameDay = [first, second].filter(
    (candidate) =>
      new Date(wallClock(candidate, timeZone).utc).toISOString().slice(0, 10) === targetDay,
  );
  return new Date(sameDay.length ? Math.min(...sameDay) : second);
}

/** ช่วงของสรุปสิ้นสุดที่เวลาคำนวณ (as of) — รายการที่ใช้ช่วงเดียวกันจึงไม่รวมงานที่จบหลังโหลดสรุป */
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
}): WorkFilter {
  const from = instantFrom(query.from, 'INVALID_FROM');
  const to = instantFrom(query.to, 'INVALID_TO');
  if (from && to && from >= to) throw new BadRequestException({ code: 'INVALID_RANGE' });
  const agentId = uuidFrom(query.agentId, 'INVALID_AGENT');
  return {
    from,
    to,
    disposition: dispositionFrom(query.disposition),
    ...(agentId ? { agentId } : {}),
  };
}

/** ค่าที่ผูกกับ cursor เพื่อไม่ให้นำ cursor ของตัวกรองหนึ่งไปใช้กับอีกตัวกรอง */
export function filterKey(filter: WorkFilter): string {
  return [
    filter.from?.toISOString() ?? '',
    filter.to?.toISOString() ?? '',
    filter.disposition === undefined ? '*' : (filter.disposition ?? NO_DISPOSITION),
    // ต่อท้ายเฉพาะเมื่อมี — key ของงานของฉัน (#964) จึงเหมือนเดิม cursor ที่ออกไปแล้วยังใช้ได้
    ...(filter.agentId ? [filter.agentId] : []),
  ].join('|');
}

/**
 * ขอบเขตของงานที่จบ: งานของ Agent คนเดียว หรือ #986 งานที่ทีมรับตามหลักฐาน
 * `voice_interaction_handling_attributions` (ทีมของ Agent ตอนรับสาย ไม่ใช่ทีมปัจจุบัน)
 * `teamId: null` = ทุกทีมของ tenant ที่มีหลักฐาน — สายที่ไม่มีหลักฐานหรือ Agent ไม่มีทีมตอนรับไม่ถูกนับ
 */
export type WorkScope = { agentId: string } | { teamId: string | null };

/** แถวงานที่จบของ Agent — ใช้เป็น CTE `work` */
export function completedWorkSql(actor: WorkActor): Prisma.Sql {
  return completedScopeWorkSql(actor.tenantId, { agentId: actor.userId });
}

/** นิยามเดียวของงานที่จบ (ADR-019 ข้อ 1) ใช้ทั้งงานของฉัน (#964) และงานของทีม (#986) */
export function completedScopeWorkSql(tenantId: string, scope: WorkScope): Prisma.Sql {
  const team = 'teamId' in scope;
  return Prisma.sql`
    SELECT interaction.id AS interaction_id, interaction.agent_id,
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
      AND interaction.channel = 'VOICE' AND interaction.state = 'COMPLETED'
      AND (interaction.voice_wrapup_policy = 'LEGACY' OR result.interaction_id IS NOT NULL)`;
}

/** เงื่อนไขบนแถวของ CTE `work` */
export function workFilterSql(filter: WorkFilter): Prisma.Sql[] {
  const conditions: Prisma.Sql[] = [];
  if (filter.from) conditions.push(Prisma.sql`recorded_at >= ${filter.from}::timestamptz`);
  if (filter.to) conditions.push(Prisma.sql`recorded_at < ${filter.to}::timestamptz`);
  if (filter.disposition === null) conditions.push(Prisma.sql`disposition IS NULL`);
  else if (filter.disposition !== undefined)
    conditions.push(Prisma.sql`disposition = ${filter.disposition}`);
  if (filter.agentId) conditions.push(Prisma.sql`agent_id = ${filter.agentId}::uuid`);
  return conditions;
}

export function whereSql(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}
