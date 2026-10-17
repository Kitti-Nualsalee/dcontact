import { createHash, randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';

type Tx = Prisma.TransactionClient;
export type CatalogKind = 'queues' | 'skills';
export interface VoiceActor {
  tenantId: string;
  userId: string;
  roles: readonly string[];
  correlationId?: string;
}
interface Actor {
  id: string;
  role: 'ADMIN' | 'SUPERVISOR';
  teamId: string | null;
  scopeStamp: string;
}
interface Policy {
  revision: number;
  sourceKind: string;
  sourcePlanDigest: string | null;
  accountsLimit: number;
  agentsLimit: number;
  voiceQueuesLimit: number;
  skillsLimit: number;
}
interface CatalogRow {
  id: string;
  name: string;
  teamId: string | null;
  createdAt: Date;
  voiceConfigVersion: number | null;
  revision: number;
  code?: string | null;
  isActive?: boolean;
  voiceWrapupPolicy?: string;
}
export function voiceFail(
  code: string,
  status: number,
  extra: Record<string, unknown> = {},
): never {
  throw new HttpException({ code, ...extra }, status);
}
export const digest = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
export function voiceUuid(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
  )
    voiceFail('VALIDATION_FAILED', 400, { field });
  return value.toLowerCase();
}
export function parseCatalogCreate(body: unknown, kind: CatalogKind) {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    voiceFail('VALIDATION_FAILED', 400, { field: 'body' });
  const b = body as Record<string, unknown>;
  const allowed =
    kind === 'skills' ? ['commandId', 'name', 'teamId', 'code'] : ['commandId', 'name', 'teamId'];
  if (Object.keys(b).some((k) => !allowed.includes(k)))
    voiceFail('VALIDATION_FAILED', 400, { field: 'body' });
  if (typeof b.name !== 'string' || /[\p{Cc}\p{Cf}]/u.test(b.name))
    voiceFail('VALIDATION_FAILED', 400, { field: 'name' });
  const name = b.name.trim().replace(/\s+/gu, ' ');
  if (Array.from(name).length < 1 || Array.from(name).length > 120)
    voiceFail('VALIDATION_FAILED', 400, { field: 'name' });
  let code: string | undefined;
  if (kind === 'skills') {
    if (typeof b.code !== 'string' || !/^[A-Z][A-Z0-9_]{1,39}$/.test(b.code))
      voiceFail('VALIDATION_FAILED', 400, { field: 'code' });
    code = b.code;
  }
  return {
    commandId: voiceUuid(b.commandId, 'commandId'),
    name,
    teamId: voiceUuid(b.teamId, 'teamId'),
    ...(code ? { code } : {}),
  };
}
export async function catalogActor(tx: Tx, identity: VoiceActor, write = false): Promise<Actor> {
  const user = await tx.user.findFirst({
    where: { id: identity.userId, tenantId: identity.tenantId, isActive: true },
    select: { id: true, role: true, teamId: true },
  });
  if (
    !user ||
    !identity.roles.includes(user.role.toLowerCase()) ||
    (user.role !== 'ADMIN' && user.role !== 'SUPERVISOR') ||
    (write && user.role !== 'ADMIN')
  )
    voiceFail('FORBIDDEN', 403);
  if (user.role === 'SUPERVISOR') {
    if (
      !user.teamId ||
      !(await tx.team.findFirst({
        where: { tenantId: identity.tenantId, id: user.teamId, isActive: true },
      }))
    )
      voiceFail('FORBIDDEN', 403);
  }
  return {
    ...user,
    role: user.role as Actor['role'],
    scopeStamp: digest([identity.tenantId, user.id, user.role, true, user.teamId]),
  };
}
async function policy(tx: Tx, tenantId: string) {
  const rows = await tx.$queryRaw<
    Policy[]
  >`SELECT revision,source_kind AS "sourceKind",source_plan_digest AS "sourcePlanDigest",accounts_limit AS "accountsLimit",agents_limit AS "agentsLimit",voice_queues_limit AS "voiceQueuesLimit",skills_limit AS "skillsLimit" FROM tenant_voice_provisioning_policies WHERE tenant_id=${tenantId}::uuid`;
  const p = rows[0];
  const binding = await tx.tenantPlanBinding.findUnique({
    where: { tenantId },
    select: { snapshotDigest: true },
  });
  const reason = !p
    ? 'RESOURCE_POLICY_NOT_READY'
    : binding
      ? p.sourceKind !== 'PLAN_SNAPSHOT' || p.sourcePlanDigest !== binding.snapshotDigest
        ? 'RESOURCE_POLICY_STALE'
        : null
      : p.sourceKind !== 'UAT_EXPLICIT'
        ? 'RESOURCE_POLICY_STALE'
        : null;
  return { policy: p, reason };
}
export function catalogCapabilities(db: PrismaClient, identity: VoiceActor) {
  return withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
    const actor = await catalogActor(tx, identity);
    const p = await policy(tx, identity.tenantId);
    const [voiceQueues, skills, accounts, agents] = await Promise.all([
      tx.queue.count({ where: { tenantId: identity.tenantId, channels: { has: 'VOICE' } } }),
      tx.skill.count({ where: { tenantId: identity.tenantId } }),
      tx.user.count({ where: { tenantId: identity.tenantId } }),
      tx.user.count({ where: { tenantId: identity.tenantId, role: 'AGENT' } }),
    ]);
    return {
      version: 1,
      canWrite: actor.role === 'ADMIN',
      catalog: { ready: true, reasons: [] },
      configuration: { ready: !p.reason, reasons: p.reason ? [p.reason] : [] },
      managedRouting: { ready: false, reasons: ['CAPABILITY_NOT_READY'] },
      peopleProvisioning: { ready: false, reasons: ['CAPABILITY_NOT_READY'] },
      invitation: { ready: false, reasons: ['CAPABILITY_NOT_READY'] },
      disable: { ready: false, reasons: ['CAPABILITY_NOT_READY'] },
      policyRevision: p.policy?.revision ?? null,
      sourceKind: p.policy?.sourceKind ?? null,
      limits:
        actor.role === 'ADMIN' && p.policy
          ? {
              accounts: { used: accounts, limit: p.policy.accountsLimit },
              agents: { used: agents, limit: p.policy.agentsLimit },
              voiceQueues: { used: voiceQueues, limit: p.policy.voiceQueuesLimit },
              skills: { used: skills, limit: p.policy.skillsLimit },
            }
          : null,
    };
  });
}
export function catalogTeams(db: PrismaClient, identity: VoiceActor) {
  return withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
    const actor = await catalogActor(tx, identity);
    return {
      items: await tx.team.findMany({
        where: {
          tenantId: identity.tenantId,
          isActive: true,
          ...(actor.role === 'SUPERVISOR' ? { id: actor.teamId! } : {}),
        },
        select: { id: true, name: true },
        orderBy: { id: 'asc' },
      }),
    };
  });
}
const selection = {
  id: true,
  name: true,
  teamId: true,
  createdAt: true,
  voiceConfigVersion: true,
} as const;
function dto(row: CatalogRow, kind: CatalogKind) {
  return {
    id: row.id,
    name: row.name,
    teamId: row.teamId,
    createdAt: row.createdAt.toISOString(),
    voiceConfigVersion: row.voiceConfigVersion,
    legacy: row.voiceConfigVersion !== 1,
    ...(kind === 'queues'
      ? {
          configRevision: row.revision,
          isActive: row.isActive,
          voiceWrapupPolicy: row.voiceWrapupPolicy ?? 'LEGACY',
          policy:
            row.voiceConfigVersion === 1
              ? {
                  version: 1,
                  offerTimeoutSec: 20,
                  maxTotalPreanswerSec: 60,
                  terminalAction: 'HANGUP',
                  skipTimedOutAgent: true,
                }
              : null,
        }
      : { revision: row.revision, code: row.code }),
  };
}
function resourceWhere(identity: VoiceActor, actor: Actor) {
  return {
    tenantId: identity.tenantId,
    ...(actor.role === 'SUPERVISOR' ? { teamId: actor.teamId! } : {}),
  };
}
export function readCatalog(
  db: PrismaClient,
  identity: VoiceActor,
  kind: CatalogKind,
  query: Record<string, unknown>,
  id?: string,
) {
  return withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
    const actor = await catalogActor(tx, identity);
    if (Object.keys(query).some((k) => !['limit', 'cursor', 'teamId'].includes(k)))
      voiceFail('VALIDATION_FAILED', 400);
    const raw = query.limit ?? '20';
    const limit = typeof raw === 'string' && /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) voiceFail('INVALID_LIMIT', 400);
    const team = query.teamId === undefined ? undefined : voiceUuid(query.teamId, 'teamId');
    const scope = resourceWhere(identity, actor);
    const filterDigest = digest([kind, team ?? null]);
    let after: { createdAt: Date; id: string } | undefined;
    if (query.cursor !== undefined) {
      try {
        if (
          typeof query.cursor !== 'string' ||
          query.cursor.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(query.cursor)
        )
          throw Error();
        const c = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (
          c.v !== 1 ||
          c.tenantId !== identity.tenantId ||
          c.actorId !== identity.userId ||
          c.scopeStamp !== actor.scopeStamp ||
          c.filterDigest !== filterDigest ||
          typeof c.at !== 'string' ||
          new Date(c.at).toISOString() !== c.at
        )
          throw Error();
        after = { createdAt: new Date(c.at), id: voiceUuid(c.id, 'cursor') };
      } catch {
        voiceFail('INVALID_CURSOR', 400);
      }
    }
    const where = {
      ...scope,
      ...(id ? { id: voiceUuid(id, 'id') } : {}),
      AND: [
        ...(team ? [{ teamId: team }] : []),
        ...(after
          ? [
              {
                OR: [
                  { createdAt: { gt: after.createdAt } },
                  { createdAt: after.createdAt, id: { gt: after.id } },
                ],
              },
            ]
          : []),
      ],
    };
    const rows: CatalogRow[] =
      kind === 'queues'
        ? (
            await tx.queue.findMany({
              where: { ...where, channels: { has: 'VOICE' } },
              select: {
                ...selection,
                configRevision: true,
                isActive: true,
                voiceWrapupPolicy: true,
              },
              orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
              take: id ? 1 : limit + 1,
            })
          ).map((r) => ({ ...r, revision: r.configRevision }))
        : await tx.skill.findMany({
            where,
            select: { ...selection, code: true, revision: true },
            orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
            take: id ? 1 : limit + 1,
          });
    if (id) {
      if (!rows[0]) voiceFail('RESOURCE_NOT_FOUND', 404);
      return dto(rows[0], kind);
    }
    const hasMore = rows.length > limit,
      items = rows.slice(0, limit),
      last = items.at(-1);
    return {
      items: items.map((r) => dto(r, kind)),
      nextCursor:
        hasMore && last
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
function mapDatabaseError(error: unknown): never {
  if (error instanceof HttpException) throw error;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    const code = String(error.meta?.code ?? '');
    if (error.code === 'P2002' || code === '23505') voiceFail('IDENTITY_CONFLICT', 409);
    if (['55P03', '57014', '40P01'].includes(code) || error.code === 'P2028')
      voiceFail('CONFIG_BUSY', 409);
    if (String(error.meta?.message ?? '').includes('VOICE_CONFIG_V1_REQUIRED'))
      voiceFail('VOICE_CONFIG_V1_REQUIRED', 409);
    if (error.code === 'P2003') voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
  }
  throw error;
}
async function rejection(
  db: PrismaClient,
  identity: VoiceActor,
  commandId: string,
  action: string,
  code: string,
) {
  // แยก transaction หลัง rollback: ไม่เก็บ payload หรือชื่อทรัพยากรที่ส่งมา
  await withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
    await catalogActor(tx, identity, true);
    await tx.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,command_id,action,outcome,reason_code,correlation_id) VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${commandId}::uuid,${action},'REJECTED',${code},${identity.correlationId ?? randomUUID()})`;
  });
}
export async function createCatalog(
  db: PrismaClient,
  identity: VoiceActor,
  kind: CatalogKind,
  raw: unknown,
) {
  const command = parseCatalogCreate(raw, kind),
    action = kind === 'queues' ? 'QUEUE_CREATE' : 'SKILL_CREATE';
  const hash = digest([
    identity.tenantId,
    identity.userId,
    action,
    { name: command.name, teamId: command.teamId, code: command.code ?? null },
  ]);
  try {
    return await withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
      await catalogActor(tx, identity, true);
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-command:${identity.tenantId}:${command.commandId}`},0))`;
      const previous = await tx.$queryRaw<
        { payloadDigest: string; result: unknown }[]
      >`SELECT c.payload_digest AS "payloadDigest",r.result_summary AS result FROM voice_config_commands c JOIN voice_config_command_receipts r USING(tenant_id,command_id) WHERE c.tenant_id=${identity.tenantId}::uuid AND c.command_id=${command.commandId}::uuid`;
      if (previous[0]) {
        if (previous[0].payloadDigest !== hash) voiceFail('COMMAND_PAYLOAD_MISMATCH', 409);
        return previous[0].result;
      }
      const initialPolicy = await policy(tx, identity.tenantId);
      if (initialPolicy.reason)
        voiceFail(
          initialPolicy.reason,
          initialPolicy.reason === 'RESOURCE_POLICY_STALE' ? 409 : 503,
        );
      const fence = await tx.$queryRaw<
        { ok: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`dc:v1:voice-config:${identity.tenantId}`},0)) AS ok`;
      if (!fence[0]?.ok) voiceFail('CONFIG_BUSY', 409);
      const refs = [
        { table: 'users', id: identity.userId },
        { table: 'teams', id: command.teamId },
        { table: 'tenants', id: identity.tenantId },
      ].sort((a, b) => a.id.localeCompare(b.id) || a.table.localeCompare(b.table));
      for (const r of refs)
        await tx.$queryRawUnsafe(
          `SELECT id FROM ${r.table} WHERE id=$1::uuid FOR UPDATE NOWAIT`,
          r.id,
        );
      await tx.$executeRaw`SELECT dc_voice_lock_policy_refs(${identity.tenantId}::uuid)`;
      await catalogActor(tx, identity, true);
      const team = await tx.team.findFirst({
        where: { id: command.teamId, tenantId: identity.tenantId, isActive: true },
      });
      if (!team) voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
      const p = await policy(tx, identity.tenantId);
      if (p.reason) voiceFail(p.reason, p.reason === 'RESOURCE_POLICY_STALE' ? 409 : 503);
      const used =
        kind === 'queues'
          ? await tx.queue.count({
              where: { tenantId: identity.tenantId, channels: { has: 'VOICE' } },
            })
          : await tx.skill.count({ where: { tenantId: identity.tenantId } });
      if (used >= (kind === 'queues' ? p.policy!.voiceQueuesLimit : p.policy!.skillsLimit))
        voiceFail('RESOURCE_LIMIT_REACHED', 429);
      const resourceId = randomUUID();
      await tx.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,command_kind) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${action},${resourceId}::uuid,${hash},'CATALOG_CREATE')`;
      await tx.$executeRaw`SELECT set_config('app.voice_config_command',${command.commandId},true)`;
      let row: CatalogRow;
      if (kind === 'queues') {
        const q = await tx.queue.create({
          data: {
            id: resourceId,
            tenantId: identity.tenantId,
            name: command.name,
            teamId: command.teamId,
            channels: ['VOICE'],
            isActive: false,
            voiceConfigVersion: 1,
            voiceWrapupPolicy: 'VOICE_NOTE_V1',
            offerTimeoutSec: 20,
            offerTimeoutAction: 'IMMEDIATE_REQUEUE',
            maxWaitSec: 60,
            maxWaitAction: 'WAIT',
            recordingEnabled: false,
            transcriptionMode: 'OFF',
            autoQmEnabled: false,
          },
          select: { ...selection, configRevision: true, isActive: true, voiceWrapupPolicy: true },
        });
        row = { ...q, revision: q.configRevision };
        await tx.$executeRaw`INSERT INTO voice_managed_queue_policies(tenant_id,queue_id) VALUES(${identity.tenantId}::uuid,${resourceId}::uuid)`;
      } else {
        row = await tx.skill.create({
          data: {
            id: resourceId,
            tenantId: identity.tenantId,
            name: command.name,
            code: command.code!,
            teamId: command.teamId,
            voiceConfigVersion: 1,
          },
          select: { ...selection, revision: true, code: true },
        });
      }
      const result = dto(row, kind);
      const changedKeys =
        kind === 'skills'
          ? ['name', 'code', 'teamId']
          : ['name', 'teamId', 'isActive', 'voiceConfigVersion', 'voiceWrapupPolicy'];
      await tx.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,after_revision,changed_keys,reason_code,correlation_id) VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${resourceId}::uuid,${command.commandId}::uuid,${action},'SUCCEEDED',1,${changedKeys}::text[],'CATALOG_CREATE',${identity.correlationId ?? randomUUID()})`;
      await tx.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${JSON.stringify(result)}::jsonb)`;
      await tx.$executeRawUnsafe('SET CONSTRAINTS voice_receipt_required IMMEDIATE');
      return result;
    });
  } catch (error) {
    let mapped: unknown;
    try {
      mapDatabaseError(error);
    } catch (e) {
      mapped = e;
    }
    if (mapped instanceof HttpException && ![401, 403].includes(mapped.getStatus())) {
      const result = mapped.getResponse();
      const code =
        typeof result === 'object' && result && 'code' in result ? String(result.code) : 'REJECTED';
      try {
        await rejection(db, identity, command.commandId, action, code);
      } catch {
        /* คง mutation error เดิม; ไม่เปลี่ยน DB failure เป็น success */
      }
    }
    throw mapped;
  }
}
export function catalogCommand(db: PrismaClient, identity: VoiceActor, commandId: string) {
  const id = voiceUuid(commandId, 'commandId');
  return withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
    await catalogActor(tx, identity, true);
    const rows = await tx.$queryRaw<
      { result: unknown }[]
    >`SELECT r.result_summary AS result FROM voice_config_commands c JOIN voice_config_command_receipts r USING(tenant_id,command_id) WHERE c.tenant_id=${identity.tenantId}::uuid AND c.command_id=${id}::uuid AND c.actor_user_id=${identity.userId}::uuid`;
    if (!rows[0]) voiceFail('RESOURCE_NOT_FOUND', 404);
    return { state: 'SUCCEEDED', result: rows[0].result };
  });
}
