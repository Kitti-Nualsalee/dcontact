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
import {
  reconcilePeopleInvitationAttempt,
  type TenantPeopleInvitationPort,
} from './tenant-people-invitation-worker.js';

const action = 'RECONCILE_TENANT_INVITATION';

export function normalizePeopleInvitationCommand(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) voiceFail('VALIDATION_FAILED', 400);
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  if (
    Object.keys(fields).some(
      (key) => !['commandId', 'expectedRevision', 'reasonCode', 'reason'].includes(key),
    )
  )
    voiceFail('VALIDATION_FAILED', 400);
  const commandId = voiceUuid(fields.commandId, 'commandId');
  if (
    typeof fields.expectedRevision !== 'number' ||
    !Number.isInteger(fields.expectedRevision) ||
    fields.expectedRevision < 1 ||
    fields.expectedRevision > 2147483647
  )
    voiceFail('VALIDATION_FAILED', 400, { field: 'expectedRevision' });
  if (typeof fields.reasonCode !== 'string' || !/^[A-Z][A-Z0-9_]{2,63}$/.test(fields.reasonCode))
    voiceFail('VALIDATION_FAILED', 400, { field: 'reasonCode' });
  if (typeof fields.reason !== 'string' || /[\p{Cc}\p{Cf}]/u.test(fields.reason))
    voiceFail('VALIDATION_FAILED', 400, { field: 'reason' });
  const reason = fields.reason.trim().replace(/\s+/gu, ' ');
  if ([...reason].length < 1 || [...reason].length > 500)
    voiceFail('VALIDATION_FAILED', 400, { field: 'reason' });
  return {
    commandId,
    expectedRevision: fields.expectedRevision,
    reasonCode: fields.reasonCode,
    reason,
  };
}

export async function acceptPeopleInvitationReconcile(
  database: PrismaClient,
  identity: VoiceActor,
  target: string,
  raw: unknown,
) {
  const userId = voiceUuid(target, 'userId');
  const command = normalizePeopleInvitationCommand(raw);
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
        SELECT c.payload_digest AS "payloadDigest",c.command_kind AS kind,r.result_summary AS result
        FROM voice_config_commands c JOIN voice_config_command_receipts r USING(tenant_id,command_id)
        WHERE c.tenant_id=${identity.tenantId}::uuid AND c.command_id=${command.commandId}::uuid`;
      if (previous[0]) {
        if (previous[0].kind !== 'PEOPLE_INVITATION_RECONCILE') voiceFail('COMMAND_ID_REUSED', 409);
        if (previous[0].payloadDigest !== payloadDigest) voiceFail('COMMAND_PAYLOAD_MISMATCH', 409);
        return previous[0].result;
      }
      for (const reference of [...new Set([identity.userId, userId])].sort()) {
        await transaction.$queryRaw`SELECT id FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${reference}::uuid FOR UPDATE NOWAIT`;
      }
      await transaction.$executeRaw`SELECT dc_people_invitation_lock_status(${identity.tenantId}::uuid,${userId}::uuid)`;
      const targets = await transaction.$queryRaw<
        {
          revision: number;
          isActive: boolean;
          statusRevision: number;
          account: string;
          activation: string;
          operationId: string;
          generation: number;
          attempt: string;
        }[]
      >`
        SELECT u.config_revision AS revision,u.is_active AS "isActive",l.revision AS "statusRevision",l.account_state AS account,l.activation_state AS activation,
          i.operation_id AS "operationId",i.generation,i.provider_attempt_ref AS attempt
        FROM users u JOIN tenant_user_lifecycles l ON l.tenant_id=u.tenant_id AND l.user_id=u.id
        JOIN LATERAL(SELECT * FROM tenant_people_invitation_intents intent WHERE intent.tenant_id=u.tenant_id AND intent.user_id=u.id ORDER BY generation DESC LIMIT 1) i ON true
        WHERE u.tenant_id=${identity.tenantId}::uuid AND u.id=${userId}::uuid
          AND l.provisioning_state='PROVISIONED' AND u.keycloak_id=l.verified_identity_id
        `;
      const current = targets[0];
      if (!current) voiceFail('RESOURCE_NOT_FOUND', 404);
      await catalogActor(transaction, identity, true);
      if (current.revision !== command.expectedRevision)
        voiceFail('REVISION_CONFLICT', 409, { currentRevision: current.revision });
      if (current.isActive || current.activation === 'ACTIVATED' || current.account === 'ACTIVE')
        voiceFail('ALREADY_ACTIVATED', 409);
      if (current.account !== 'PENDING_ACTIVATION' || current.activation !== 'PENDING')
        voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
      const operationId = randomUUID();
      const result = {
        operationId,
        userId,
        generation: current.generation,
        status: 'ACCEPTED' as const,
        location: `/api/v1/tenant-voice/operations/${operationId}`,
      };
      await transaction.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind)
        VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${action},${userId}::uuid,${payloadDigest},${command.expectedRevision},'PEOPLE_INVITATION_RECONCILE')`;
      await transaction.$executeRaw`INSERT INTO tenant_people_invitation_reconciles(tenant_id,id,command_id,actor_user_id,user_id,source_operation_id,generation,provider_attempt_ref,expected_revision,status_revision,reason_code,reason)
        VALUES(${identity.tenantId}::uuid,${operationId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${userId}::uuid,${current.operationId}::uuid,${current.generation},${current.attempt}::uuid,${command.expectedRevision},${current.statusRevision},${command.reasonCode},${command.reason})`;
      await transaction.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${JSON.stringify(result)}::jsonb)`;
      await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id)
        VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,${action},'ACCEPTED',${current.revision},${current.revision},ARRAY['invitationReconcile'],${command.reasonCode},${identity.correlationId ?? randomUUID()})`;
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

export async function runNextPeopleInvitationReconcile(
  database: PrismaClient,
  provider: Pick<TenantPeopleInvitationPort, 'readOutcome'>,
  tenant: string,
): Promise<boolean> {
  const tenantId = voiceUuid(tenant, 'tenantId');
  const leaseToken = randomUUID();
  const claim = await withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const rows = await transaction.$queryRaw<
      { id: string; sourceOperationId: string; generation: number; attempt: string }[]
    >`
      UPDATE tenant_people_invitation_reconciles SET state='RUNNING',revision=revision+1,lease_token=${leaseToken}::uuid,lease_expires_at=clock_timestamp()+interval '30 seconds',updated_at=clock_timestamp()
      WHERE tenant_id=${tenantId}::uuid AND id=(SELECT id FROM tenant_people_invitation_reconciles WHERE tenant_id=${tenantId}::uuid
        AND (state='QUEUED' OR (state='RUNNING' AND lease_expires_at<=clock_timestamp())) ORDER BY created_at,id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id,source_operation_id AS "sourceOperationId",generation,provider_attempt_ref AS attempt`;
    return rows[0];
  });
  if (!claim) return false;
  let result: 'RECORDED' | 'AMBIGUOUS' | 'NOT_ELIGIBLE' = 'NOT_ELIGIBLE';
  let failed = false;
  try {
    result = await reconcilePeopleInvitationAttempt(
      database,
      provider,
      tenantId,
      claim.sourceOperationId,
      { generation: claim.generation, providerAttemptRef: claim.attempt },
    );
  } catch {
    failed = true;
  }
  const errorCode = failed
    ? 'INVITATION_RECONCILE_UNAVAILABLE'
    : result === 'RECORDED'
      ? null
      : result === 'AMBIGUOUS'
        ? 'INVITATION_DELIVERY_AMBIGUOUS'
        : 'INVITATION_DISPATCH_NOT_STARTED';
  await withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    await transaction.$executeRaw`UPDATE tenant_people_invitation_reconciles SET state=${!failed && result === 'RECORDED' ? 'SUCCEEDED' : 'ACTION_REQUIRED'},revision=revision+1,error_code=${errorCode},lease_token=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
      WHERE tenant_id=${tenantId}::uuid AND id=${claim.id}::uuid AND state='RUNNING' AND lease_token=${leaseToken}::uuid`;
  });
  return true;
}
