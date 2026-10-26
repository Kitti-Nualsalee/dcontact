import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  Prisma,
  withTenantDatabaseTransaction,
  lockTeamReferences,
  type PrismaClient,
} from '@d-contact/db';
import {
  catalogActor,
  digest,
  mapDatabaseError,
  policy,
  voiceFail,
  voiceUuid,
  type VoiceActor,
} from './tenant-voice-catalog.js';
import { configurationRead, configurationResource } from './tenant-voice-configuration-read.js';
import { managedRuntimeReady } from './tenant-voice-runtime-readiness.js';

type Tx = Prisma.TransactionClient;
export type ConfigurationKind = 'queue' | 'requirements' | 'agent-skills' | 'binding';
export interface SkillItem {
  skillId: string;
  level: number;
}
export function parseConfiguration(raw: unknown, kind: ConfigurationKind) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) voiceFail('VALIDATION_FAILED', 400);
  const body = raw as Record<string, unknown>;
  const fields = [
    'commandId',
    'expectedRevision',
    'reasonCode',
    'reason',
    ...(kind === 'queue'
      ? ['name', 'isActive']
      : kind === 'binding'
        ? ['queueId', 'isActive']
        : ['items']),
  ];
  if (Object.keys(body).some((key) => !fields.includes(key))) voiceFail('VALIDATION_FAILED', 400);
  const commandId = voiceUuid(body.commandId, 'commandId');
  if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1)
    voiceFail('VALIDATION_FAILED', 400, { field: 'expectedRevision' });
  if (typeof body.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(body.reasonCode))
    voiceFail('VALIDATION_FAILED', 400, { field: 'reasonCode' });
  if (
    typeof body.reason !== 'string' ||
    /[\p{Cc}\p{Cf}]/u.test(body.reason) ||
    !body.reason.trim() ||
    Array.from(body.reason.trim()).length > 500
  )
    voiceFail('VALIDATION_FAILED', 400, { field: 'reason' });
  let name: string | undefined;
  if (body.name !== undefined) {
    if (typeof body.name !== 'string' || /[\p{Cc}\p{Cf}]/u.test(body.name))
      voiceFail('VALIDATION_FAILED', 400, { field: 'name' });
    name = body.name.trim().replace(/\s+/gu, ' ');
    if (!name || Array.from(name).length > 120)
      voiceFail('VALIDATION_FAILED', 400, { field: 'name' });
  }
  if (body.isActive !== undefined && typeof body.isActive !== 'boolean')
    voiceFail('VALIDATION_FAILED', 400, { field: 'isActive' });
  if (kind === 'queue' && name === undefined && body.isActive === undefined)
    voiceFail('VALIDATION_FAILED', 400);
  if (kind === 'binding' && typeof body.isActive !== 'boolean')
    voiceFail('VALIDATION_FAILED', 400, { field: 'isActive' });
  const items: SkillItem[] = [];
  if (kind === 'requirements' || kind === 'agent-skills') {
    if (!Array.isArray(body.items) || body.items.length > 100)
      voiceFail('VALIDATION_FAILED', 400, { field: 'items' });
    const levelKey = kind === 'requirements' ? 'minLevel' : 'level';
    for (const value of body.items) {
      if (!value || typeof value !== 'object' || Array.isArray(value))
        voiceFail('VALIDATION_FAILED', 400, { field: 'items' });
      const item = value as Record<string, unknown>;
      if (
        Object.keys(item).some((key) => !['skillId', levelKey].includes(key)) ||
        !Number.isInteger(item[levelKey]) ||
        Number(item[levelKey]) < 1 ||
        Number(item[levelKey]) > 5
      )
        voiceFail('VALIDATION_FAILED', 400, { field: 'items' });
      const skillId = voiceUuid(item.skillId, 'skillId');
      if (items.some((item) => item.skillId === skillId))
        voiceFail('VALIDATION_FAILED', 400, { field: 'items' });
      items.push({ skillId, level: Number(item[levelKey]) });
    }
    items.sort((left, right) => left.skillId.localeCompare(right.skillId));
  }
  return {
    commandId,
    expectedRevision: Number(body.expectedRevision),
    reasonCode: body.reasonCode,
    reason: body.reason.trim(),
    name,
    isActive: body.isActive as boolean | undefined,
    queueId: kind === 'binding' ? voiceUuid(body.queueId, 'queueId') : undefined,
    items,
  };
}

export async function lockConfigurationClosure(
  tx: Tx,
  identity: VoiceActor,
  queueIds: string[],
  userIds: string[],
  skillIds: string[],
  teamIds: string[],
  bindingId?: string,
) {
  const tenantId = identity.tenantId;
  const agents = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM users WHERE tenant_id=${tenantId}::uuid AND role='AGENT' AND (id=ANY(${userIds}::uuid[]) OR team_id IN (SELECT team_id FROM queues WHERE tenant_id=${tenantId}::uuid AND id=ANY(${queueIds}::uuid[])) OR id IN (SELECT user_id FROM agent_skills WHERE tenant_id=${tenantId}::uuid AND skill_id=ANY(${skillIds}::uuid[])) OR id IN (SELECT agent_id FROM interactions WHERE tenant_id=${tenantId}::uuid AND queue_id=ANY(${queueIds}::uuid[]) AND agent_id IS NOT NULL))`;
  const affectedUsers = [...new Set([...userIds, ...agents.map((row) => row.id)])];
  const relatedQueues = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM queues WHERE tenant_id=${tenantId}::uuid AND (id=ANY(${queueIds}::uuid[]) OR id IN (SELECT queue_id FROM queue_skills WHERE tenant_id=${tenantId}::uuid AND skill_id=ANY(${skillIds}::uuid[])) OR (${userIds.length > 0} AND NOT EXISTS(SELECT 1 FROM queue_skills WHERE tenant_id=${tenantId}::uuid AND queue_id=queues.id)))`;
  const affectedQueues = [...new Set([...queueIds, ...relatedQueues.map((row) => row.id)])];
  const queueAgents = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM users WHERE tenant_id=${tenantId}::uuid AND role='AGENT' AND (team_id IN (SELECT team_id FROM queues WHERE tenant_id=${tenantId}::uuid AND id=ANY(${affectedQueues}::uuid[])) OR id IN (SELECT agent_id FROM interactions WHERE tenant_id=${tenantId}::uuid AND queue_id=ANY(${affectedQueues}::uuid[])))`;
  affectedUsers.push(...queueAgents.map((row) => row.id));
  const references = [
    { table: 'tenants', id: tenantId },
    ...[identity.userId, ...affectedUsers].map((id) => ({ table: 'users', id })),
    ...affectedQueues.map((id) => ({ table: 'queues', id })),
    ...skillIds.map((id) => ({ table: 'skills', id })),
    ...teamIds.map((id) => ({ table: 'teams', id })),
    ...(bindingId ? [{ table: 'voice_destinations', id: bindingId }] : []),
  ].sort((left, right) => left.id.localeCompare(right.id) || left.table.localeCompare(right.table));
  const seen = new Set<string>();
  for (const reference of references) {
    const key = `${reference.table}:${reference.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await tx.$queryRawUnsafe(
      `SELECT id FROM ${reference.table} WHERE id=$1::uuid${reference.table === 'tenants' ? '' : ' AND tenant_id=$2::uuid'} FOR UPDATE NOWAIT`,
      ...(reference.table === 'tenants' ? [reference.id] : [reference.id, tenantId]),
    );
  }
  await tx.$executeRaw`SELECT dc_voice_lock_policy_refs(${tenantId}::uuid)`;
  await tx.$executeRaw`SELECT dc_voice_lock_config_refs(${tenantId}::uuid,${affectedQueues}::uuid[],${[...affectedUsers, identity.userId]}::uuid[])`;
  const busy = await tx.$queryRaw<
    { id: string }[]
  >`SELECT id FROM interactions WHERE tenant_id=${tenantId}::uuid AND state IN ('QUEUED','ASSIGNED','ACTIVE','WRAPUP') AND (queue_id=ANY(${affectedQueues}::uuid[]) OR agent_id=ANY(${affectedUsers}::uuid[]) OR metadata->>'targetAgentId'=ANY(${affectedUsers}::text[]) OR metadata->>'target_agent_id'=ANY(${affectedUsers}::text[])) LIMIT 1`;
  if (busy.length) voiceFail('CONFIG_BUSY', 409);
  const cleanup = await tx.$queryRaw<
    { id: string }[]
  >`SELECT command.id FROM voice_managed_commands command JOIN interactions interaction ON interaction.tenant_id=command.tenant_id AND interaction.id=command.interaction_id LEFT JOIN voice_managed_offers offer ON offer.tenant_id=command.tenant_id AND offer.id=command.offer_id WHERE command.tenant_id=${tenantId}::uuid AND command.status='PENDING' AND command.command_type IN ('offer.cancel','call.hangup') AND (interaction.queue_id=ANY(${affectedQueues}::uuid[]) OR interaction.agent_id=ANY(${affectedUsers}::uuid[]) OR offer.agent_id=ANY(${affectedUsers}::uuid[])) LIMIT 1`;
  if (cleanup.length) voiceFail('CONFIG_BUSY', 409);
}

export async function mutateConfiguration(
  db: PrismaClient,
  identity: VoiceActor,
  kind: ConfigurationKind,
  rawId: string,
  raw: unknown,
) {
  const id = voiceUuid(rawId, 'id');
  const command = parseConfiguration(raw, kind);
  const action = {
    queue: 'QUEUE_UPDATE',
    requirements: 'QUEUE_REQUIRED_SKILLS_REPLACE',
    'agent-skills': 'AGENT_SKILLS_REPLACE',
    binding: 'DESTINATION_BINDING_UPDATE',
  }[kind];
  const payloadDigest = digest([identity.tenantId, identity.userId, action, id, command]);
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
        if (previous[0].payloadDigest !== payloadDigest) voiceFail('COMMAND_PAYLOAD_MISMATCH', 409);
        return previous[0].result;
      }
      const resource = await configurationResource(tx, identity, kind, id, true);
      const targetQueue = command.queueId
        ? await configurationResource(tx, identity, 'queue', command.queueId, true)
        : undefined;
      const referenceTeams = [resource.teamId, targetQueue?.teamId].filter(
        (value): value is string => !!value,
      );
      const closureTeamRefs = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM teams WHERE tenant_id=${identity.tenantId}::uuid ORDER BY id`;
      referenceTeams.push(...closureTeamRefs.map((row) => row.id));
      await lockTeamReferences(tx, identity.tenantId, referenceTeams);
      const fence = await tx.$queryRaw<
        { ok: boolean }[]
      >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`dc:v1:voice-config:${identity.tenantId}`},0)) AS ok`;
      if (!fence[0]?.ok) voiceFail('CONFIG_BUSY', 409);
      const oldSkills =
        kind === 'agent-skills'
          ? await tx.$queryRaw<
              { skillId: string }[]
            >`SELECT skill_id AS "skillId" FROM agent_skills WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${id}::uuid`
          : await tx.$queryRaw<
              { skillId: string }[]
            >`SELECT skill_id AS "skillId" FROM queue_skills WHERE tenant_id=${identity.tenantId}::uuid AND queue_id=ANY(${kind === 'binding' ? [resource.queueId!, command.queueId!] : [id]}::uuid[])`;
      const skillIds = [
        ...new Set([
          ...oldSkills.map((row) => row.skillId),
          ...command.items.map((item) => item.skillId),
        ]),
      ];
      const queues =
        kind === 'agent-skills'
          ? []
          : [
              ...new Set([
                kind === 'binding' ? resource.queueId! : id,
                ...(command.queueId ? [command.queueId] : []),
              ]),
            ];
      const teams = [
        ...new Set(
          [resource.teamId, targetQueue?.teamId].filter((value): value is string => !!value),
        ),
      ];
      await lockConfigurationClosure(
        tx,
        identity,
        queues,
        kind === 'agent-skills' ? [id] : [],
        skillIds,
        teams,
        kind === 'binding' ? id : undefined,
      );
      await catalogActor(tx, identity, true);
      const current = await configurationResource(tx, identity, kind, id, true);
      const newQueue = command.queueId
        ? await configurationResource(tx, identity, 'queue', command.queueId, true)
        : undefined;
      if (
        newQueue &&
        (newQueue.teamId !== targetQueue?.teamId ||
          newQueue.configRevision !== targetQueue?.configRevision)
      )
        voiceFail('REVISION_CONFLICT', 409, { currentRevision: newQueue.configRevision });
      if (current.teamId !== resource.teamId || current.queueId !== resource.queueId)
        voiceFail('REVISION_CONFLICT', 409, { currentRevision: current.configRevision });
      if (current.configRevision !== command.expectedRevision)
        voiceFail('REVISION_CONFLICT', 409, { currentRevision: current.configRevision });
      const readiness = await policy(tx, identity.tenantId);
      if (readiness.reason)
        voiceFail(readiness.reason, readiness.reason === 'RESOURCE_POLICY_STALE' ? 409 : 503);
      if (command.isActive === true) {
        let nodeId: string | null = null;
        if (kind === 'binding') {
          const reserved = await tx.$queryRaw<
            { nodeId: string | null }[]
          >`SELECT item->>'telephonyNodeId' AS "nodeId" FROM tenant_voice_provisioning_policies p CROSS JOIN LATERAL jsonb_array_elements(p.destination_pool) item WHERE p.tenant_id=${identity.tenantId}::uuid AND item->>'destinationId'=${id}`;
          nodeId = reserved[0]?.nodeId ?? null;
          if (!nodeId || !newQueue?.isActive) voiceFail('CAPABILITY_NOT_READY', 503);
        }
        if (!(await managedRuntimeReady(tx, identity.tenantId, nodeId)))
          voiceFail('CAPABILITY_NOT_READY', 503);
        const queueId = kind === 'binding' ? command.queueId! : id;
        const required = await tx.queueSkill.count({
          where: { tenantId: identity.tenantId, queueId },
        });
        if (!required) voiceFail('VALIDATION_FAILED', 400, { field: 'requiredSkills' });
      }
      if (kind === 'requirements' && current.isActive && !command.items.length)
        voiceFail('VALIDATION_FAILED', 400, { field: 'requiredSkills' });
      if (kind === 'requirements' || kind === 'agent-skills') {
        const skills = await tx.skill.findMany({
          where: {
            tenantId: identity.tenantId,
            id: { in: command.items.map((item) => item.skillId) },
            teamId: current.teamId,
            voiceConfigVersion: 1,
          },
          select: { id: true },
        });
        if (skills.length !== command.items.length) voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
        if (
          !current.teamId ||
          !(await tx.team.findFirst({
            where: { tenantId: identity.tenantId, id: current.teamId, isActive: true },
          }))
        )
          voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
      }
      if (
        kind === 'binding' &&
        (!newQueue?.teamId ||
          !(await tx.team.findFirst({
            where: { tenantId: identity.tenantId, id: newQueue.teamId, isActive: true },
          })))
      )
        voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
      await tx.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${action},${id}::uuid,${payloadDigest},${command.expectedRevision},'CONFIG_UPDATE')`;
      await tx.$executeRaw`SELECT set_config('app.voice_config_command',${command.commandId},true)`;
      if (kind === 'requirements' || kind === 'agent-skills') {
        if (kind === 'requirements') {
          await tx.$executeRaw`DELETE FROM queue_skills WHERE tenant_id=${identity.tenantId}::uuid AND queue_id=${id}::uuid`;
          for (const item of command.items)
            await tx.$executeRaw`INSERT INTO queue_skills(tenant_id,queue_id,skill_id,min_level) VALUES(${identity.tenantId}::uuid,${id}::uuid,${item.skillId}::uuid,${item.level})`;
        } else {
          await tx.$executeRaw`DELETE FROM agent_skills WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${id}::uuid`;
          for (const item of command.items)
            await tx.$executeRaw`INSERT INTO agent_skills(tenant_id,user_id,skill_id,level) VALUES(${identity.tenantId}::uuid,${id}::uuid,${item.skillId}::uuid,${item.level})`;
        }
      }
      if (kind === 'queue' || kind === 'requirements')
        await tx.queue.update({
          where: { id },
          data: {
            ...(command.name !== undefined ? { name: command.name } : {}),
            ...(command.isActive !== undefined ? { isActive: command.isActive } : {}),
            configRevision: { increment: 1 },
          },
        });
      if (kind === 'agent-skills')
        await tx.user.update({ where: { id }, data: { configRevision: { increment: 1 } } });
      if (kind === 'binding')
        await tx.$executeRaw`UPDATE voice_destinations SET queue_id=${command.queueId!}::uuid,entry_mode='DIRECT_QUEUE',is_active=${command.isActive!},config_revision=config_revision+1,updated_at=now() WHERE tenant_id=${identity.tenantId}::uuid AND id=${id}::uuid`;
      const result = await configurationRead(tx, identity, kind, id);
      const changedKeys =
        kind === 'queue'
          ? [
              ...(command.name !== undefined ? ['name'] : []),
              ...(command.isActive !== undefined ? ['isActive'] : []),
            ]
          : kind === 'binding'
            ? ['queueId', 'isActive']
            : ['items'];
      await tx.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id) VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${id}::uuid,${command.commandId}::uuid,${action},'SUCCEEDED',${command.expectedRevision},${command.expectedRevision + 1},${changedKeys}::text[],${command.reasonCode},${identity.correlationId ?? randomUUID()})`;
      await tx.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${JSON.stringify(result)}::jsonb)`;
      await tx.$executeRawUnsafe('SET CONSTRAINTS voice_receipt_required IMMEDIATE');
      return result;
    });
  } catch (error) {
    let mapped: unknown;
    try {
      mapDatabaseError(error);
    } catch (failure) {
      mapped = failure;
    }
    if (mapped instanceof HttpException && ![401, 403, 404].includes(mapped.getStatus())) {
      const response = mapped.getResponse();
      const code =
        typeof response === 'object' && 'code' in response ? String(response.code) : 'REJECTED';
      try {
        await withTenantDatabaseTransaction(db, identity.tenantId, async (tx) => {
          await catalogActor(tx, identity, true);
          await tx.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,command_id,action,outcome,reason_code,correlation_id) VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${command.commandId}::uuid,${action},'REJECTED',${code},${identity.correlationId ?? randomUUID()})`;
        });
      } catch {}
    }
    throw mapped;
  }
}
