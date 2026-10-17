import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { findActiveAgent } from './active-agent.js';

type Actor = { tenantId: string; userId: string };
type Cursor = {
  version: 1;
  tenantId: string;
  userId: string;
  recordedAt: string;
  interactionId: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function cursorFrom(value: unknown, actor: Actor): Cursor | undefined {
  if (value === undefined) return;
  try {
    if (typeof value !== 'string' || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value))
      throw new Error();
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Cursor;
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      Array.isArray(parsed) ||
      Object.keys(parsed).sort().join(',') !== 'interactionId,recordedAt,tenantId,userId,version' ||
      parsed.version !== 1 ||
      parsed.tenantId !== actor.tenantId ||
      parsed.userId !== actor.userId ||
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

export async function readAgentHistory(
  database: PrismaClient,
  actor: Actor,
  limitValue: unknown,
  cursorValue: unknown,
) {
  const limit =
    limitValue === undefined
      ? 20
      : typeof limitValue === 'string' && /^(?:[1-9]|[1-9][0-9]|100)$/.test(limitValue)
        ? Number(limitValue)
        : undefined;
  if (limit === undefined) throw new BadRequestException({ code: 'INVALID_LIMIT' });
  const cursor = cursorFrom(cursorValue, actor);
  return withTenantDatabaseTransaction(database, actor.tenantId, async (transaction) => {
    const agent = await findActiveAgent(transaction, actor);
    if (!agent) throw new ForbiddenException({ code: 'AGENT_REQUIRED' });
    const predicate = cursor
      ? Prisma.sql`WHERE (recorded_at, interaction_id) < (${new Date(cursor.recordedAt)}::timestamptz, ${cursor.interactionId}::uuid)`
      : Prisma.empty;
    const rows = await transaction.$queryRaw<
      {
        interaction_id: string;
        started_at: Date;
        ended_at: Date | null;
        disposition: string | null;
        recorded_at: Date;
        recorded_at_source: 'SERVER_COMMIT' | 'LEGACY_EVENT' | 'LEGACY_FALLBACK';
        legacy: boolean;
      }[]
    >(Prisma.sql`
      WITH history AS (
        SELECT interaction.id AS interaction_id,
          COALESCE(interaction.answered_at, interaction.queued_at) AS started_at,
          interaction.ended_at, interaction.wrap_up_code AS disposition,
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
          AND (interaction.voice_wrapup_policy = 'LEGACY' OR result.interaction_id IS NOT NULL)
      )
      SELECT * FROM history ${predicate}
      ORDER BY recorded_at DESC, interaction_id DESC LIMIT ${limit + 1}
    `);
    const items = rows.slice(0, limit).map((row) => ({
      interactionId: row.interaction_id,
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
              version: 1,
              tenantId: actor.tenantId,
              userId: actor.userId,
              recordedAt: last.recordedAt,
              interactionId: last.interactionId,
            }),
          ).toString('base64url')
        : null;
    return { items, nextCursor };
  });
}
