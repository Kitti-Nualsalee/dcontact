import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
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
import { lockConfigurationClosure } from './tenant-voice-configuration.js';
import type { DisableSnapshot } from './tenant-people-disable.js';

export interface TeamChangeResult {
  userId: string;
  fromTeamId: string | null;
  teamId: string;
  configRevision: number;
  removedSkills: number;
}

/** the body of PATCH /people/users/:id/team — accepts no role/extension/email (#998: 1A is team only) */
export function normalizeTeamChangeCommand(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) voiceFail('VALIDATION_FAILED', 400);
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  if (
    Object.keys(fields).some(
      (key) => !['commandId', 'expectedRevision', 'teamId', 'reason'].includes(key),
    )
  )
    voiceFail('VALIDATION_FAILED', 400);
  const commandId = voiceUuid(fields.commandId, 'commandId');
  const teamId = voiceUuid(fields.teamId, 'teamId');
  if (
    typeof fields.expectedRevision !== 'number' ||
    !Number.isInteger(fields.expectedRevision) ||
    fields.expectedRevision < 1 ||
    fields.expectedRevision > 2147483647
  )
    voiceFail('VALIDATION_FAILED', 400, { field: 'expectedRevision' });
  if (typeof fields.reason !== 'string' || /[\p{Cc}\p{Cf}]/u.test(fields.reason))
    voiceFail('VALIDATION_FAILED', 400, { field: 'reason' });
  const reason = fields.reason.trim().replace(/\s+/gu, ' ');
  if ([...reason].length < 1 || [...reason].length > 500)
    voiceFail('VALIDATION_FAILED', 400, { field: 'reason' });
  return { commandId, expectedRevision: fields.expectedRevision, teamId, reason };
}

async function applyTeamChange(
  database: PrismaClient,
  identity: VoiceActor,
  userId: string,
  command: ReturnType<typeof normalizeTeamChangeCommand>,
): Promise<TeamChangeResult> {
  const payloadDigest = digest([
    identity.tenantId,
    identity.userId,
    'PEOPLE_TEAM_CHANGE',
    userId,
    command,
  ]);
  return withTenantDatabaseTransaction(database, identity.tenantId, async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
    await catalogActor(transaction, identity, true);
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-command:${identity.tenantId}:${command.commandId}`},0))`;
    const [previous] = await transaction.$queryRaw<
      { payloadDigest: string; kind: string; action: string; result: TeamChangeResult }[]
    >`
      SELECT c.payload_digest AS "payloadDigest",c.command_kind AS kind,c.action,r.result_summary AS result
      FROM voice_config_commands c JOIN voice_config_command_receipts r USING(tenant_id,command_id)
      WHERE c.tenant_id=${identity.tenantId}::uuid AND c.command_id=${command.commandId}::uuid`;
    if (previous) {
      if (previous.kind !== 'PEOPLE_UPDATE' || previous.action !== 'PEOPLE_TEAM_CHANGE')
        voiceFail('COMMAND_ID_REUSED', 409);
      if (previous.payloadDigest !== payloadDigest) voiceFail('COMMAND_PAYLOAD_MISMATCH', 409);
      return previous.result;
    }
    // the target must have a positive proof the same way as directory/disable (not a platform/foreign identity)
    const [row] = await transaction.$queryRaw<{ snapshot: DisableSnapshot | null }[]>`
      SELECT dc_people_disable_snapshot(${identity.tenantId}::uuid,${userId}::uuid,${identity.caller!.issuer},${identity.caller!.clientId},${identity.caller!.tenantSlug}) AS snapshot`;
    const target = row?.snapshot?.target;
    if (!target) voiceFail('RESOURCE_NOT_FOUND', 404);
    if (target.config_revision !== command.expectedRevision)
      voiceFail('REVISION_CONFLICT', 409, { currentRevision: target.config_revision });
    if (target.team_id === command.teamId) voiceFail('VALIDATION_FAILED', 400, { field: 'teamId' });
    const resourcePolicy = await policy(transaction, identity.tenantId);
    if (resourcePolicy.reason)
      voiceFail(
        resourcePolicy.reason,
        resourcePolicy.reason === 'RESOURCE_POLICY_STALE' ? 409 : 503,
      );
    const teams = [
      ...new Set([command.teamId, ...(target.team_id ? [target.team_id] : [])]),
    ].sort();
    await lockTeamReferences(transaction, identity.tenantId, teams);
    const skills = await transaction.agentSkill.findMany({
      where: { tenantId: identity.tenantId, userId },
      select: { skillId: true },
    });
    await lockConfigurationClosure(
      transaction,
      identity,
      [],
      target.role === 'AGENT' ? [userId] : [],
      target.role === 'AGENT' ? skills.map((skill) => skill.skillId) : [],
      teams,
    );
    const team = await transaction.team.findFirst({
      where: { tenantId: identity.tenantId, id: command.teamId, isActive: true },
      select: { id: true },
    });
    if (!team) voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
    const [{ removed }] = await transaction.$queryRaw<{ removed: number }[]>`
      SELECT count(*)::int AS removed FROM agent_skills a JOIN skills s ON s.tenant_id=a.tenant_id AND s.id=a.skill_id
      WHERE a.tenant_id=${identity.tenantId}::uuid AND a.user_id=${userId}::uuid AND s.voice_config_version=1
        AND s.team_id IS DISTINCT FROM ${command.teamId}::uuid`;
    await transaction.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind)
      VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,'PEOPLE_TEAM_CHANGE',${userId}::uuid,${payloadDigest},${command.expectedRevision},'PEOPLE_UPDATE')`;
    const [applied] = await transaction.$queryRaw<{ revision: number }[]>`
      SELECT dc_people_apply_team_change(${identity.tenantId}::uuid,${command.commandId}::uuid,${command.teamId}::uuid,
        ${command.reason},${identity.caller!.issuer},${identity.caller!.clientId},${identity.caller!.tenantSlug}) AS revision`;
    const result: TeamChangeResult = {
      userId,
      fromTeamId: target.team_id,
      teamId: command.teamId,
      configRevision: applied.revision,
      removedSkills: removed,
    };
    await transaction.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${JSON.stringify(result)}::jsonb)`;
    await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id)
      VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,'PEOPLE_TEAM_CHANGE','SUCCEEDED',${command.expectedRevision},${applied.revision},${removed ? ['teamId', 'agentSkills'] : ['teamId']},'OPERATOR_REQUEST',${identity.correlationId ?? command.commandId})`;
    return result;
  }).catch(mapTeamChangeError);
}

/** a definer code that is not in the central mapDatabaseError: separates the account and session states from CONFIG_BUSY */
function mapTeamChangeError(error: unknown): never {
  if (!(error instanceof HttpException)) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('PEOPLE_UPDATE_SCOPE_DENIED')) voiceFail('FORBIDDEN', 403);
    if (message.includes('ACCOUNT_STATE_CONFLICT')) voiceFail('ACCOUNT_STATE_CONFLICT', 409);
    if (message.includes('AGENT_SESSION_ACTIVE')) voiceFail('AGENT_SESSION_ACTIVE', 409);
  }
  return mapDatabaseError(error);
}

export async function acceptPeopleTeamChange(
  database: PrismaClient,
  identity: VoiceActor,
  target: string,
  raw: unknown,
): Promise<TeamChangeResult> {
  const userId = voiceUuid(target, 'userId');
  const command = normalizeTeamChangeCommand(raw);
  try {
    return await applyTeamChange(database, identity, userId, command);
  } catch (error) {
    // record the rejection in a separate transaction after the rollback, without keeping the payload or reason that was entered
    if (error instanceof HttpException && [409, 429, 503].includes(error.getStatus())) {
      const response = error.getResponse();
      const code =
        typeof response === 'object' && 'code' in response && typeof response.code === 'string'
          ? response.code
          : 'CONFIG_BUSY';
      if (code !== 'COMMAND_ID_REUSED' && code !== 'COMMAND_PAYLOAD_MISMATCH')
        await withTenantDatabaseTransaction(database, identity.tenantId, async (transaction) => {
          await catalogActor(transaction, identity, true);
          await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,reason_code,correlation_id)
            VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,'PEOPLE_TEAM_CHANGE','REJECTED',${code},${identity.correlationId ?? randomUUID()})`;
        });
    }
    throw error;
  }
}
