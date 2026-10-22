import { randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { digest, voiceFail, voiceUuid } from './tenant-voice-catalog.js';
import { normalizePeopleCreate, peopleCreateDigest } from './tenant-people-input.js';
import type {
  PeopleInvitationAttempt,
  PeopleInvitationPreparation,
  TenantPeopleInvitationPreparePort,
} from './tenant-people-invitation-worker.js';

export async function runPeopleInvitationPreparation(
  database: PrismaClient,
  provider: TenantPeopleInvitationPreparePort,
  tenant: string,
  resend: string,
): Promise<'NOT_ELIGIBLE' | 'WAITING_READBACK' | 'READY'> {
  const tenantId = voiceUuid(tenant, 'tenantId');
  const resendId = voiceUuid(resend, 'operationId');
  const claim = await withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
    const reservations = await transaction.$queryRaw<
      { userId: string }[]
    >`SELECT user_id AS "userId" FROM tenant_people_invitation_resends WHERE tenant_id=${tenantId}::uuid AND id=${resendId}::uuid`;
    if (!reservations[0]) return null;
    await transaction.$executeRaw`SELECT dc_people_invitation_lock_preparation(${tenantId}::uuid,${reservations[0].userId}::uuid)`;
    const admitted = await transaction.$queryRaw<{ resendId: string }[]>`
      INSERT INTO tenant_people_invitation_preparations(tenant_id,resend_id,operation_id,user_id,generation,provider_attempt_ref,fencing_token,lease_owner)
      SELECT r.tenant_id,r.id,r.source_operation_id,r.user_id,r.generation,r.provider_attempt_ref,GREATEST(r.generation,d.fencing_token+1),${randomUUID()}
      FROM tenant_people_invitation_resends r
      JOIN users u ON u.tenant_id=r.tenant_id AND u.id=r.user_id
      JOIN tenant_user_lifecycles l ON l.tenant_id=r.tenant_id AND l.user_id=r.user_id
      JOIN tenant_people_invitation_receipts proof ON proof.tenant_id=r.tenant_id AND proof.provider_attempt_ref=r.previous_attempt_ref AND proof.outcome='SENT' AND proof.quiescent
      JOIN tenant_people_invitation_dispatches d ON d.tenant_id=r.tenant_id AND d.provider_attempt_ref=r.previous_attempt_ref
      WHERE r.tenant_id=${tenantId}::uuid AND r.id=${resendId}::uuid
        AND NOT u.is_active AND u.keycloak_id=l.verified_identity_id AND u.config_revision=r.expected_revision AND l.revision=r.status_revision
        AND l.account_state='PENDING_ACTIVATION' AND l.activation_state='PENDING' AND l.provisioning_state='PROVISIONED'
        AND NOT EXISTS(SELECT 1 FROM tenant_people_invitation_intents i WHERE i.tenant_id=r.tenant_id AND i.user_id=r.user_id AND i.generation>r.previous_generation)
      ON CONFLICT(tenant_id,resend_id) DO NOTHING RETURNING resend_id AS "resendId"`;
    if (admitted.length === 1) {
      await transaction.$executeRaw`INSERT INTO tenant_people_invitation_intents(tenant_id,operation_id,user_id,generation,provider_attempt_ref)
        SELECT tenant_id,operation_id,user_id,generation,provider_attempt_ref FROM tenant_people_invitation_preparations WHERE tenant_id=${tenantId}::uuid AND resend_id=${resendId}::uuid`;
    }
    const rows = await transaction.$queryRaw<
      (Omit<PeopleInvitationAttempt, 'command'> & {
        payload: unknown;
        actorId: string;
        commandId: string;
        ready: boolean;
        previousEpoch: bigint;
      })[]
    >`
      SELECT p.tenant_id AS "tenantId",p.operation_id AS "operationId",p.user_id AS "userId",p.generation,p.provider_attempt_ref AS "providerAttemptRef",
        p.fencing_token::text AS "fencingToken",p.lease_owner AS "leaseOwner",p.lease_expires_at AS "leaseExpiresAt",o.payload_digest AS "payloadDigest",
        o.request_payload AS payload,o.actor_user_id AS "actorId",o.command_id AS "commandId",
        EXISTS(SELECT 1 FROM tenant_people_invitation_preparation_proofs proof WHERE proof.tenant_id=p.tenant_id AND proof.provider_attempt_ref=p.provider_attempt_ref) AS ready,
        GREATEST(previous.issued_at_epoch,previous.not_before_epoch) AS "previousEpoch"
      FROM tenant_people_invitation_preparations p
      JOIN tenant_people_operations o ON o.tenant_id=p.tenant_id AND o.id=p.operation_id AND o.target_user_id=p.user_id
      JOIN tenant_people_invitation_resends r ON r.tenant_id=p.tenant_id AND r.id=p.resend_id
      JOIN tenant_people_invitation_receipts previous ON previous.tenant_id=r.tenant_id AND previous.provider_attempt_ref=r.previous_attempt_ref
      WHERE p.tenant_id=${tenantId}::uuid AND p.resend_id=${resendId}::uuid`;
    if (!rows[0]) return null;
    const { payload, actorId, commandId, ready, previousEpoch, ...attempt } = rows[0];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      voiceFail('PEOPLE_PAYLOAD_CORRUPTED', 409);
    const { infrastructure, ...request } = Object.fromEntries(Object.entries(payload));
    const command = normalizePeopleCreate({ ...request, commandId });
    if (digest([tenantId, actorId, peopleCreateDigest(command)]) !== attempt.payloadDigest)
      voiceFail('PEOPLE_PAYLOAD_CORRUPTED', 409);
    return {
      attempt: { ...attempt, command },
      admitted: admitted.length === 1,
      ready,
      previousEpoch,
    };
  });
  if (!claim) return 'NOT_ELIGIBLE';
  if (claim.ready) return 'READY';
  if (claim.admitted) {
    try {
      await provider.prepare(claim.attempt);
    } catch {}
  }
  let proof: PeopleInvitationPreparation = { outcome: 'UNKNOWN' };
  try {
    proof = await provider.readPreparation(claim.attempt);
  } catch {}
  if (
    proof.outcome !== 'INTENT' ||
    proof.clockReached !== true ||
    typeof proof.intentRef !== 'string' ||
    !/^[a-f0-9]{64}$/.test(proof.intentRef) ||
    !Number.isSafeInteger(proof.notBeforeEpoch) ||
    !Number.isSafeInteger(proof.serverEpoch) ||
    proof.notBeforeEpoch <= Number(claim.previousEpoch) ||
    proof.serverEpoch < proof.notBeforeEpoch ||
    proof.serverEpoch > 253402041599
  )
    return 'WAITING_READBACK';
  const verified = proof;
  await withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    await transaction.$executeRaw`INSERT INTO tenant_people_invitation_preparation_proofs(tenant_id,provider_attempt_ref,intent_ref,not_before_epoch,server_epoch)
      VALUES(${tenantId}::uuid,${claim.attempt.providerAttemptRef}::uuid,${verified.intentRef},${verified.notBeforeEpoch}::bigint,${verified.serverEpoch}::bigint)
      ON CONFLICT DO NOTHING`;
    const stored = await transaction.$queryRaw<
      { matches: boolean }[]
    >`SELECT intent_ref=${verified.intentRef} AND not_before_epoch=${verified.notBeforeEpoch}::bigint AS matches
      FROM tenant_people_invitation_preparation_proofs WHERE tenant_id=${tenantId}::uuid AND provider_attempt_ref=${claim.attempt.providerAttemptRef}::uuid`;
    if (!stored[0]?.matches) voiceFail('INVITATION_PREPARATION_MISMATCH', 409);
  });
  return 'READY';
}
