import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  catalogActor,
  digest,
  mapDatabaseError,
  voiceFail,
  voiceUuid,
  type VoiceActor,
} from './tenant-voice-catalog.js';
import { normalizePeopleInvitationCommand } from './tenant-people-invitation-reconcile.js';

export async function acceptPeopleInvitationResend(
  database: PrismaClient,
  identity: VoiceActor,
  target: string,
  raw: unknown,
) {
  const userId = voiceUuid(target, 'userId');
  const command = normalizePeopleInvitationCommand(raw);
  const action = 'RESEND_TENANT_INVITATION';
  const payloadDigest = digest([
    identity.tenantId,
    identity.userId,
    action,
    userId,
    command.expectedRevision,
    command.reasonCode,
    command.reason,
  ]);
  try {
    return await withTenantDatabaseTransaction(database, identity.tenantId, async (transaction) => {
      await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
      await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
      await catalogActor(transaction, identity, true);
      await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-command:${identity.tenantId}:${command.commandId}`},0))`;
      const previous = await transaction.$queryRaw<
        {
          payloadDigest: string;
          kind: string;
          result: {
            operationId: string;
            userId: string;
            generation: number;
            status: 'ACCEPTED';
            location: string;
          };
        }[]
      >`
        SELECT c.payload_digest AS "payloadDigest",c.command_kind AS kind,r.result_summary AS result FROM voice_config_commands c JOIN voice_config_command_receipts r USING(tenant_id,command_id)
        WHERE c.tenant_id=${identity.tenantId}::uuid AND c.command_id=${command.commandId}::uuid`;
      if (previous[0]) {
        if (previous[0].kind !== 'PEOPLE_INVITATION_RESEND') voiceFail('COMMAND_ID_REUSED', 409);
        if (previous[0].payloadDigest !== payloadDigest) voiceFail('COMMAND_PAYLOAD_MISMATCH', 409);
        return previous[0].result;
      }
      for (const reference of [...new Set([identity.userId, userId])].sort()) {
        await transaction.$queryRaw`SELECT id FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${reference}::uuid FOR UPDATE NOWAIT`;
      }
      await transaction.$executeRaw`SELECT dc_people_invitation_lock_status(${identity.tenantId}::uuid,${userId}::uuid)`;
      const rows = await transaction.$queryRaw<
        {
          revision: number;
          statusRevision: number;
          isActive: boolean;
          account: string;
          activation: string;
          operationId: string;
          generation: number;
          attempt: string;
          finished: boolean;
        }[]
      >`
        SELECT u.config_revision AS revision,l.revision AS "statusRevision",u.is_active AS "isActive",l.account_state AS account,l.activation_state AS activation,
          i.operation_id AS "operationId",i.generation,i.provider_attempt_ref AS attempt,
          EXISTS(SELECT 1 FROM tenant_people_invitation_receipts r WHERE r.tenant_id=i.tenant_id AND r.provider_attempt_ref=i.provider_attempt_ref AND r.outcome='SENT' AND r.quiescent) AS finished
        FROM users u JOIN tenant_user_lifecycles l ON l.tenant_id=u.tenant_id AND l.user_id=u.id
        JOIN LATERAL(SELECT * FROM tenant_people_invitation_intents intent WHERE intent.tenant_id=u.tenant_id AND intent.user_id=u.id ORDER BY generation DESC LIMIT 1) i ON true
        WHERE u.tenant_id=${identity.tenantId}::uuid AND u.id=${userId}::uuid AND l.provisioning_state='PROVISIONED' AND u.keycloak_id=l.verified_identity_id`;
      const current = rows[0];
      if (!current) voiceFail('RESOURCE_NOT_FOUND', 404);
      await catalogActor(transaction, identity, true);
      if (current.revision !== command.expectedRevision)
        voiceFail('REVISION_CONFLICT', 409, { currentRevision: current.revision });
      if (current.isActive || current.activation === 'ACTIVATED' || current.account === 'ACTIVE')
        voiceFail('ALREADY_ACTIVATED', 409);
      if (current.account !== 'PENDING_ACTIVATION' || current.activation !== 'PENDING')
        voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
      if (!current.finished) voiceFail('INVITATION_DELIVERY_NOT_QUIESCENT', 409);
      if (current.generation >= 2147483647) voiceFail('INVITATION_GENERATION_EXHAUSTED', 409);
      const counts = await transaction.$queryRaw<
        { used: number }[]
      >`SELECT count(*)::integer AS used FROM tenant_people_invitation_resends WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${userId}::uuid AND created_at>clock_timestamp()-interval '60 minutes'`;
      if (counts[0].used >= 3) voiceFail('INVITATION_RESEND_LIMIT', 429);
      const pending = await transaction.$queryRaw<
        { id: string }[]
      >`SELECT id FROM tenant_people_invitation_resends WHERE tenant_id=${identity.tenantId}::uuid AND user_id=${userId}::uuid AND generation=${current.generation + 1}`;
      if (pending[0]) voiceFail('INVITATION_RESEND_IN_PROGRESS', 409);
      const operationId = randomUUID();
      const result = {
        operationId,
        userId,
        generation: current.generation + 1,
        status: 'ACCEPTED' as const,
        location: `/api/v1/tenant-voice/operations/${operationId}`,
      };
      await transaction.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind)
        VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${action},${userId}::uuid,${payloadDigest},${command.expectedRevision},'PEOPLE_INVITATION_RESEND')`;
      await transaction.$executeRaw`INSERT INTO tenant_people_invitation_resends(tenant_id,id,command_id,actor_user_id,user_id,source_operation_id,previous_generation,previous_attempt_ref,generation,provider_attempt_ref,expected_revision,status_revision,reason_code,reason)
        VALUES(${identity.tenantId}::uuid,${operationId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${userId}::uuid,${current.operationId}::uuid,${current.generation},${current.attempt}::uuid,${result.generation},${randomUUID()}::uuid,${command.expectedRevision},${current.statusRevision},${command.reasonCode},${command.reason})`;
      await transaction.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${JSON.stringify(result)}::jsonb)`;
      await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id)
        VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,${action},'ACCEPTED',${current.revision},${current.revision},ARRAY['invitationResend'],${command.reasonCode},${identity.correlationId ?? randomUUID()})`;
      await transaction.$executeRawUnsafe('SET CONSTRAINTS voice_receipt_required IMMEDIATE');
      return result;
    });
  } catch (error) {
    try {
      mapDatabaseError(error);
    } catch (mapped) {
      if (mapped instanceof HttpException && [409, 429, 503].includes(mapped.getStatus())) {
        const response = mapped.getResponse();
        const code =
          typeof response === 'object' && 'code' in response && typeof response.code === 'string'
            ? response.code
            : 'CONFIG_BUSY';
        await withTenantDatabaseTransaction(database, identity.tenantId, async (transaction) => {
          await catalogActor(transaction, identity, true);
          await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,reason_code,correlation_id)
            VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,${action},'REJECTED',${code},${identity.correlationId ?? randomUUID()})`;
        });
      }
      throw mapped;
    }
  }
}
