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

export interface WorkFilter {
  from: Date | null;
  to: Date | null;
  /** undefined = ทุกผลบันทึก, null = งานที่ไม่มีผลบันทึก */
  disposition?: string | null;
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
  const offset = (at: number) => wallClock(at, timeZone).utc - Math.floor(at / 1000) * 1000;
  let candidate = target - offset(target);
  candidate = target - offset(candidate);
  return new Date(candidate);
}

export function periodWindow(period: SummaryPeriod, now: Date, timeZone: string): WorkFilter {
  if (period === 'all') return { from: null, to: null };
  return {
    from: zonedDayStart(now, timeZone, PERIOD_DAYS[period]),
    to: zonedDayStart(now, timeZone, -1),
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
  if (typeof value === 'string' && value.length <= 64 && /^[^\u0000-\u001f\u007f]+$/.test(value))
    return value;
  throw new BadRequestException({ code: 'INVALID_DISPOSITION' });
}

export function workFilterFrom(query: {
  from?: unknown;
  to?: unknown;
  disposition?: unknown;
}): WorkFilter {
  const from = instantFrom(query.from, 'INVALID_FROM');
  const to = instantFrom(query.to, 'INVALID_TO');
  if (from && to && from >= to) throw new BadRequestException({ code: 'INVALID_RANGE' });
  return { from, to, disposition: dispositionFrom(query.disposition) };
}

/** ค่าที่ผูกกับ cursor เพื่อไม่ให้นำ cursor ของตัวกรองหนึ่งไปใช้กับอีกตัวกรอง */
export function filterKey(filter: WorkFilter): string {
  return [
    filter.from?.toISOString() ?? '',
    filter.to?.toISOString() ?? '',
    filter.disposition === undefined ? '*' : (filter.disposition ?? NO_DISPOSITION),
  ].join('|');
}

/** แถวงานที่จบของ Agent — ใช้เป็น CTE `work` */
export function completedWorkSql(actor: WorkActor): Prisma.Sql {
  return Prisma.sql`
    SELECT interaction.id AS interaction_id,
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
    WHERE interaction.tenant_id = ${actor.tenantId}::uuid AND interaction.agent_id = ${actor.userId}::uuid
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
  return conditions;
}

export function whereSql(conditions: Prisma.Sql[]): Prisma.Sql {
  return conditions.length ? Prisma.sql`WHERE ${Prisma.join(conditions, ' AND ')}` : Prisma.empty;
}
