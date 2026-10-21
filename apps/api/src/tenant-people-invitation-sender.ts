import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { digest, voiceFail, voiceUuid } from './tenant-voice-catalog.js';
import { normalizePeopleCreate, peopleCreateDigest } from './tenant-people-input.js';
import {
  reconcilePeopleInvitationAttempt,
  type PeopleInvitationAttempt,
  type PeopleInvitationOutcome,
  type TenantPeopleInvitationResendPort,
} from './tenant-people-invitation-worker.js';

export async function runPeopleInvitationResend(
  database: PrismaClient,
  provider: TenantPeopleInvitationResendPort,
  tenant: string,
  resend: string,
): Promise<'NOT_ELIGIBLE' | 'AMBIGUOUS' | 'RECORDED'> {
  const tenantId = voiceUuid(tenant, 'tenantId');
  const resendId = voiceUuid(resend, 'operationId');
  const claim = await withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
    const targets = await transaction.$queryRaw<
      { userId: string }[]
    >`SELECT user_id AS "userId" FROM tenant_people_invitation_resends WHERE tenant_id=${tenantId}::uuid AND id=${resendId}::uuid`;
    if (!targets[0]) return null;
    await transaction.$executeRaw`SELECT dc_people_invitation_lock_preparation(${tenantId}::uuid,${targets[0].userId}::uuid)`;
    const admitted = await transaction.$queryRaw<{ attempt: string }[]>`
      INSERT INTO tenant_people_invitation_dispatches(tenant_id,operation_id,user_id,generation,provider_attempt_ref,fencing_token,lease_owner)
      SELECT p.tenant_id,p.operation_id,p.user_id,p.generation,p.provider_attempt_ref,p.fencing_token,p.lease_owner
      FROM tenant_people_invitation_preparations p
      JOIN tenant_people_invitation_preparation_proofs proof ON proof.tenant_id=p.tenant_id AND proof.provider_attempt_ref=p.provider_attempt_ref
      JOIN tenant_people_invitation_resends r ON r.tenant_id=p.tenant_id AND r.id=p.resend_id
      JOIN users u ON u.tenant_id=p.tenant_id AND u.id=p.user_id
      JOIN tenant_user_lifecycles l ON l.tenant_id=p.tenant_id AND l.user_id=p.user_id
      JOIN tenant_people_invitation_intents i ON i.tenant_id=p.tenant_id AND i.operation_id=p.operation_id AND i.user_id=p.user_id AND i.generation=p.generation AND i.provider_attempt_ref=p.provider_attempt_ref
      WHERE p.tenant_id=${tenantId}::uuid AND p.resend_id=${resendId}::uuid
        AND NOT u.is_active AND u.keycloak_id=l.verified_identity_id AND u.config_revision=r.expected_revision AND l.revision=r.status_revision
        AND l.account_state='PENDING_ACTIVATION' AND l.activation_state='PENDING' AND l.provisioning_state='PROVISIONED'
        AND NOT EXISTS(SELECT 1 FROM tenant_people_invitation_intents newer WHERE newer.tenant_id=p.tenant_id AND newer.user_id=p.user_id AND newer.generation>p.generation)
      ON CONFLICT(tenant_id,provider_attempt_ref) DO NOTHING RETURNING provider_attempt_ref AS attempt`;
    const rows = await transaction.$queryRaw<
      (Omit<PeopleInvitationAttempt, 'command'> & {
        intentRef: string;
        notBeforeEpoch: bigint;
        finished: boolean;
        payload: unknown;
        actorId: string;
        commandId: string;
      })[]
    >`
      SELECT d.tenant_id AS "tenantId",d.operation_id AS "operationId",d.user_id AS "userId",d.generation,d.provider_attempt_ref AS "providerAttemptRef",
        d.fencing_token::text AS "fencingToken",d.lease_owner AS "leaseOwner",d.lease_expires_at AS "leaseExpiresAt",o.payload_digest AS "payloadDigest",
        proof.intent_ref AS "intentRef",proof.not_before_epoch AS "notBeforeEpoch",o.request_payload AS payload,o.actor_user_id AS "actorId",o.command_id AS "commandId",
        EXISTS(SELECT 1 FROM tenant_people_invitation_receipts receipt WHERE receipt.tenant_id=d.tenant_id AND receipt.provider_attempt_ref=d.provider_attempt_ref) AS finished
      FROM tenant_people_invitation_preparations p
      JOIN tenant_people_invitation_preparation_proofs proof ON proof.tenant_id=p.tenant_id AND proof.provider_attempt_ref=p.provider_attempt_ref
      JOIN tenant_people_invitation_dispatches d ON d.tenant_id=p.tenant_id AND d.provider_attempt_ref=p.provider_attempt_ref AND d.operation_id=p.operation_id AND d.user_id=p.user_id AND d.generation=p.generation AND d.fencing_token=p.fencing_token AND d.lease_owner=p.lease_owner
      JOIN tenant_people_operations o ON o.tenant_id=p.tenant_id AND o.id=p.operation_id AND o.target_user_id=p.user_id
      WHERE p.tenant_id=${tenantId}::uuid AND p.resend_id=${resendId}::uuid`;
    if (!rows[0]) return null;
    const { payload, actorId, commandId, intentRef, notBeforeEpoch, finished, ...attempt } =
      rows[0];
    if (!payload || typeof payload !== 'object' || Array.isArray(payload))
      voiceFail('PEOPLE_PAYLOAD_CORRUPTED', 409);
    const { infrastructure, ...request } = Object.fromEntries(Object.entries(payload));
    const command = normalizePeopleCreate({ ...request, commandId });
    if (digest([tenantId, actorId, peopleCreateDigest(command)]) !== attempt.payloadDigest)
      voiceFail('PEOPLE_PAYLOAD_CORRUPTED', 409);
    return {
      attempt: { ...attempt, command },
      proof: { intentRef, notBeforeEpoch: Number(notBeforeEpoch) },
      finished,
      admitted: admitted.length === 1,
    };
  });
  if (!claim) return 'NOT_ELIGIBLE';
  if (claim.finished) return 'RECORDED';
  let result: PeopleInvitationOutcome = { outcome: 'UNKNOWN' };
  try {
    result = claim.admitted
      ? await provider.dispatchPrepared(claim.attempt, claim.proof)
      : await provider.readOutcome(claim.attempt);
  } catch {}
  if (result.outcome === 'SENT' && result.notBeforeEpoch !== claim.proof.notBeforeEpoch)
    result = { outcome: 'UNKNOWN' };
  const outcome = result;
  return reconcilePeopleInvitationAttempt(
    database,
    { readOutcome: async () => outcome },
    tenantId,
    claim.attempt.operationId,
    { generation: claim.attempt.generation, providerAttemptRef: claim.attempt.providerAttemptRef },
  );
}
