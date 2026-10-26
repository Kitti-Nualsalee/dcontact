import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  catalogActor,
  digest,
  voiceFail,
  voiceUuid,
  type VoiceActor,
} from './tenant-voice-catalog.js';
import type { ConfigurationKind } from './tenant-voice-configuration.js';
import { managedRuntimeReady } from './tenant-voice-runtime-readiness.js';
type Tx = Prisma.TransactionClient;
export function configurationRuntime(db: PrismaClient, identity: VoiceActor, rawId: string) {
  const id = voiceUuid(rawId, 'queueId');
  return withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
    await readFence(tx, identity.tenantId);
    const queue = await configurationResource(tx, identity, 'queue', id);
    const ready =
      queue.voiceConfigVersion === 1 && (await managedRuntimeReady(tx, identity.tenantId));
    const events = await tx.$queryRaw<
      { interactionId: string; reason: string | null; occurredAt: Date }[]
    >`SELECT e.interaction_id AS "interactionId",e.payload->>'reason' AS reason,e.created_at AS "occurredAt" FROM interaction_events e JOIN interactions i ON i.tenant_id=e.tenant_id AND i.id=e.interaction_id WHERE e.tenant_id=${identity.tenantId}::uuid AND i.queue_id=${id}::uuid AND e.type='interaction.managed_terminal' ORDER BY e.created_at DESC,e.id DESC LIMIT 1`;
    const latest = events[0];
    const cleanup = latest
      ? await tx.$queryRaw<
          { status: string; actionRequired: boolean }[]
        >`SELECT status,last_error='MANAGED_VOICE_ORIGINATE_OUTCOME_UNKNOWN' AS "actionRequired" FROM voice_managed_commands WHERE tenant_id=${identity.tenantId}::uuid AND interaction_id=${latest.interactionId}::uuid AND command_type IN ('offer.cancel','call.hangup')`
      : [];
    const teardownState = !cleanup.length
      ? null
      : cleanup.some((item) => item.actionRequired)
        ? 'ACTION_REQUIRED'
        : cleanup.some((item) => item.status !== 'CONFIRMED')
          ? 'PENDING'
          : 'CONFIRMED';
    const reasons = [
      'PREANSWER_DEADLINE_EXCEEDED',
      'CALLER_CANCELLED',
      'CALLER_HANGUP',
      'AGENT_HANGUP',
      'TOTAL_PREANSWER_TIMEOUT',
      'NO_ELIGIBLE_AGENT',
    ];
    return {
      queueId: id,
      configRevision: queue.configRevision,
      ready,
      reasons: ready ? [] : ['CAPABILITY_NOT_READY'],
      policy:
        queue.voiceConfigVersion === 1
          ? {
              version: 1,
              offerTimeoutSec: 20,
              maxTotalPreanswerSec: 60,
              terminalAction: 'HANGUP',
            }
          : null,
      terminal: latest
        ? {
            reason: reasons.includes(latest.reason ?? '') ? latest.reason : 'UNKNOWN',
            occurredAt: latest.occurredAt.toISOString(),
            teardownState,
          }
        : null,
      evaluatedAt: new Date().toISOString(),
    };
  });
}
async function readFence(tx: Tx, tenantId: string) {
  const rows = await tx.$queryRaw<
    { ok: boolean }[]
  >`SELECT pg_try_advisory_xact_lock_shared(hashtextextended(${`dc:v1:voice-config:${tenantId}`},0)) AS ok`;
  if (!rows[0]?.ok) voiceFail('CONFIG_BUSY', 409);
}
interface Resource {
  id: string;
  configRevision: number;
  teamId: string | null;
  voiceConfigVersion?: number | null;
  queueId?: string;
  isActive: boolean;
  destination?: string;
  entryMode?: string;
}

export async function configurationResource(
  tx: Tx,
  identity: VoiceActor,
  kind: ConfigurationKind,
  id: string,
  write = false,
): Promise<Resource> {
  const actor = await catalogActor(tx, identity, write);
  const team = actor.role === 'SUPERVISOR' ? actor.teamId : null;
  let rows: Resource[];
  if (kind === 'binding') {
    rows = await tx.$queryRaw<
      Resource[]
    >`SELECT d.id,d.config_revision AS "configRevision",q.team_id AS "teamId",d.voice_config_version AS "voiceConfigVersion",d.queue_id AS "queueId",d.is_active AS "isActive",d.destination,d.entry_mode AS "entryMode" FROM voice_destinations d JOIN queues q ON q.tenant_id=d.tenant_id AND q.id=d.queue_id WHERE d.tenant_id=${identity.tenantId}::uuid AND d.id=${id}::uuid AND (${team}::uuid IS NULL OR q.team_id=${team}::uuid) AND EXISTS(SELECT 1 FROM tenant_voice_provisioning_policies p CROSS JOIN LATERAL jsonb_array_elements(p.destination_pool) item WHERE p.tenant_id=d.tenant_id AND item->>'destinationId'=d.id::text)`;
  } else if (kind === 'agent-skills') {
    rows = await tx.$queryRaw<
      Resource[]
    >`SELECT id,config_revision AS "configRevision",team_id AS "teamId",is_active AS "isActive" FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${id}::uuid AND role='AGENT' AND (${team}::uuid IS NULL OR team_id=${team}::uuid)`;
  } else {
    rows = await tx.$queryRaw<
      Resource[]
    >`SELECT id,config_revision AS "configRevision",team_id AS "teamId",voice_config_version AS "voiceConfigVersion",is_active AS "isActive" FROM queues WHERE tenant_id=${identity.tenantId}::uuid AND id=${id}::uuid AND 'VOICE'=ANY(channels) AND (${team}::uuid IS NULL OR team_id=${team}::uuid)`;
  }
  const row = rows[0];
  if (!row) voiceFail('RESOURCE_NOT_FOUND', 404);
  if (write && kind !== 'agent-skills' && row.voiceConfigVersion !== 1)
    voiceFail('VOICE_CONFIG_V1_REQUIRED', 409);
  if (write && kind === 'agent-skills') {
    const lifecycle = await tx.$queryRaw<
      { account: string }[]
    >`SELECT account_state AS account FROM tenant_user_lifecycles WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${id}::uuid`;
    if (!row.isActive && lifecycle[0]?.account !== 'PENDING_ACTIVATION')
      voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
    if (lifecycle[0] && !['ACTIVE', 'PENDING_ACTIVATION'].includes(lifecycle[0].account))
      voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
  }
  return row;
}

export async function configurationRead(
  tx: Tx,
  identity: VoiceActor,
  kind: ConfigurationKind,
  id: string,
) {
  await readFence(tx, identity.tenantId);
  const resource = await configurationResource(tx, identity, kind, id);
  if (kind === 'binding') {
    const { teamId, ...result } = resource;
    return result;
  }
  if (kind === 'queue') {
    const queue = await tx.queue.findFirstOrThrow({
      where: { tenantId: identity.tenantId, id },
      select: {
        id: true,
        name: true,
        teamId: true,
        isActive: true,
        configRevision: true,
        voiceConfigVersion: true,
        voiceWrapupPolicy: true,
      },
    });
    return { ...queue, legacy: queue.voiceConfigVersion !== 1 };
  }
  if (kind === 'requirements') {
    const items = await tx.$queryRaw<
      { skillId: string; minLevel: number }[]
    >`SELECT skill_id AS "skillId",min_level AS "minLevel" FROM queue_skills WHERE tenant_id=${identity.tenantId}::uuid AND queue_id=${id}::uuid ORDER BY skill_id`;
    return { queueId: id, configRevision: resource.configRevision, items };
  }
  const items = await tx.$queryRaw<
    { skillId: string; level: number }[]
  >`SELECT skill_id AS "skillId",level FROM agent_skills WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${id}::uuid ORDER BY skill_id`;
  return { userId: id, configRevision: resource.configRevision, items };
}

export function readConfiguration(
  db: PrismaClient,
  identity: VoiceActor,
  kind: ConfigurationKind,
  rawId: string,
) {
  const id = voiceUuid(rawId, 'id');
  return withTenantDatabaseTransaction(db, identity.tenantId, (tx) =>
    configurationRead(tx, identity, kind, id),
  );
}

interface ProjectionRow {
  id: string;
  createdAt: Date;
  [key: string]: unknown;
}
export function configurationProjection(
  db: PrismaClient,
  identity: VoiceActor,
  kind: 'roster' | 'destinations',
  query: Record<string, unknown>,
) {
  return withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
    await readFence(tx, identity.tenantId);
    const actor = await catalogActor(tx, identity);
    if (
      Object.keys(query).some(
        (key) => !['teamId', 'role', 'state', 'limit', 'cursor'].includes(key),
      )
    )
      voiceFail('VALIDATION_FAILED', 400);
    if (kind === 'destinations' && (query.role !== undefined || query.state !== undefined))
      voiceFail('VALIDATION_FAILED', 400);
    const limit =
      typeof (query.limit ?? '20') === 'string' && /^\d+$/.test(String(query.limit ?? '20'))
        ? Number(query.limit ?? '20')
        : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) voiceFail('INVALID_LIMIT', 400);
    const requestedTeam = query.teamId === undefined ? null : voiceUuid(query.teamId, 'teamId');
    if (query.role !== undefined && !['AGENT', 'SUPERVISOR', 'ADMIN'].includes(String(query.role)))
      voiceFail('VALIDATION_FAILED', 400);
    if (
      query.state !== undefined &&
      !['OFFLINE', 'AVAILABLE', 'RESERVED', 'BUSY', 'ACW', 'BREAK'].includes(String(query.state))
    )
      voiceFail('VALIDATION_FAILED', 400);
    const filterDigest = digest([kind, requestedTeam, query.role ?? null, query.state ?? null]);
    let afterId: string | null = null;
    let afterAt: Date | null = null;
    if (query.cursor !== undefined) {
      try {
        if (
          typeof query.cursor !== 'string' ||
          query.cursor.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(query.cursor)
        )
          throw Error();
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (
          cursor.v !== 1 ||
          cursor.tenantId !== identity.tenantId ||
          cursor.actorId !== identity.userId ||
          cursor.scopeStamp !== actor.scopeStamp ||
          cursor.filterDigest !== filterDigest ||
          typeof cursor.at !== 'string' ||
          new Date(cursor.at).toISOString() !== cursor.at
        )
          throw Error();
        afterId = voiceUuid(cursor.id, 'cursor');
        afterAt = new Date(cursor.at);
      } catch {
        voiceFail('INVALID_CURSOR', 400);
      }
    }
    const team = actor.role === 'SUPERVISOR' ? actor.teamId : null;
    const rows =
      kind === 'roster'
        ? await tx.$queryRaw<
            ProjectionRow[]
          >`SELECT u.id,u.created_at AS "createdAt",u.display_name AS "displayName",u.role,u.team_id AS "teamId",u.extension,u.is_active AS "isActive",u.config_revision AS "configRevision",COALESCE(s.state::text,'OFFLINE') AS state FROM users u LEFT JOIN LATERAL (SELECT state FROM agent_state_logs WHERE tenant_id=u.tenant_id AND user_id=u.id AND ended_at IS NULL ORDER BY started_at DESC,id DESC LIMIT 1) s ON true WHERE u.tenant_id=${identity.tenantId}::uuid AND (${team}::uuid IS NULL OR u.team_id=${team}::uuid) AND (${requestedTeam}::uuid IS NULL OR u.team_id=${requestedTeam}::uuid) AND (${query.role ?? null}::text IS NULL OR u.role::text=${query.role ?? null}::text) AND (${query.state ?? null}::text IS NULL OR COALESCE(s.state::text,'OFFLINE')=${query.state ?? null}::text) AND (${afterId}::uuid IS NULL OR (u.created_at,u.id)>(${afterAt}::timestamp,${afterId}::uuid)) ORDER BY u.created_at,u.id LIMIT ${limit + 1}`
        : await tx.$queryRaw<
            ProjectionRow[]
          >`SELECT d.id,d.created_at AS "createdAt",d.destination,d.queue_id AS "queueId",d.entry_mode AS "entryMode",d.is_active AS "isActive",d.config_revision AS "configRevision",d.voice_config_version AS "voiceConfigVersion" FROM voice_destinations d JOIN queues q ON q.tenant_id=d.tenant_id AND q.id=d.queue_id WHERE d.tenant_id=${identity.tenantId}::uuid AND (${team}::uuid IS NULL OR q.team_id=${team}::uuid) AND (${requestedTeam}::uuid IS NULL OR q.team_id=${requestedTeam}::uuid) AND EXISTS(SELECT 1 FROM tenant_voice_provisioning_policies p CROSS JOIN LATERAL jsonb_array_elements(p.destination_pool) item WHERE p.tenant_id=d.tenant_id AND item->>'destinationId'=d.id::text) AND (${afterId}::uuid IS NULL OR (d.created_at,d.id)>(${afterAt}::timestamp,${afterId}::uuid)) ORDER BY d.created_at,d.id LIMIT ${limit + 1}`;
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(({ createdAt, ...row }) => row),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                tenantId: identity.tenantId,
                actorId: identity.userId,
                scopeStamp: actor.scopeStamp,
                filterDigest,
                at: last.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  });
}

export function configurationEligibility(
  db: PrismaClient,
  identity: VoiceActor,
  query: Record<string, unknown>,
) {
  if (Object.keys(query).some((key) => key !== 'queueId')) voiceFail('VALIDATION_FAILED', 400);
  const id = voiceUuid(query.queueId, 'queueId');
  return withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
    await readFence(tx, identity.tenantId);
    const queue = await configurationResource(tx, identity, 'queue', id);
    const requirements = await tx.$queryRaw<
      { skillId: string; minLevel: number }[]
    >`SELECT skill_id AS "skillId",min_level AS "minLevel" FROM queue_skills WHERE tenant_id=${identity.tenantId}::uuid AND queue_id=${id}::uuid`;
    const agents = await tx.$queryRaw<
      {
        userId: string;
        displayName: string;
        isActive: boolean;
        extension: string | null;
        state: string;
        account: string | null;
      }[]
    >`SELECT u.id AS "userId",u.display_name AS "displayName",u.is_active AS "isActive",u.extension,COALESCE(s.state::text,'OFFLINE') AS state,l.account_state AS account FROM users u LEFT JOIN tenant_user_lifecycles l ON l.tenant_id=u.tenant_id AND l.user_id=u.id LEFT JOIN LATERAL (SELECT state FROM agent_state_logs WHERE tenant_id=u.tenant_id AND user_id=u.id AND ended_at IS NULL ORDER BY started_at DESC,id DESC LIMIT 1) s ON true WHERE u.tenant_id=${identity.tenantId}::uuid AND u.role='AGENT' AND u.team_id=${queue.teamId}::uuid ORDER BY u.id`;
    const skills = await tx.$queryRaw<
      { userId: string; skillId: string; level: number }[]
    >`SELECT a.user_id AS "userId",a.skill_id AS "skillId",a.level FROM agent_skills a JOIN users u ON u.tenant_id=a.tenant_id AND u.id=a.user_id WHERE a.tenant_id=${identity.tenantId}::uuid AND u.team_id=${queue.teamId}::uuid`;
    const candidates = agents.map((agent) => {
      const reasons: string[] = [];
      if (!agent.isActive || (agent.account !== null && agent.account !== 'ACTIVE'))
        reasons.push('INACTIVE_AGENT');
      if (!agent.extension) reasons.push('EXTENSION_REQUIRED');
      if (!requirements.length) reasons.push('NO_REQUIRED_SKILLS');
      if (
        requirements.some(
          (required) =>
            !skills.some(
              (skill) =>
                skill.userId === agent.userId &&
                skill.skillId === required.skillId &&
                skill.level >= required.minLevel,
            ),
        )
      )
        reasons.push('SKILL_LEVEL_INSUFFICIENT');
      const eligible = reasons.length === 0;
      if (agent.state !== 'AVAILABLE') reasons.push('NOT_AVAILABLE');
      return {
        userId: agent.userId,
        displayName: agent.displayName,
        eligible,
        available: eligible && agent.state === 'AVAILABLE',
        reasons,
      };
    });
    return {
      queueId: id,
      configRevision: queue.configRevision,
      evaluatedAt: new Date().toISOString(),
      candidates,
      warnings: candidates.some((agent) => agent.available) ? [] : ['NO_ELIGIBLE_AVAILABLE_AGENT'],
    };
  });
}
