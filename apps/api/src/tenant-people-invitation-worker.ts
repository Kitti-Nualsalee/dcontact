import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { voiceFail, voiceUuid } from './tenant-voice-catalog.js';

export interface PeopleInvitationAttempt {
  tenantId: string;
  operationId: string;
  userId: string;
  generation: number;
  providerAttemptRef: string;
  payloadDigest: string;
  fencingToken: string;
  leaseOwner: string;
  leaseExpiresAt: Date;
}

export type PeopleInvitationOutcome =
  | { outcome: 'UNKNOWN' }
  | {
      outcome: 'SENT' | 'FAILED';
      tenantId: string;
      operationId: string;
      userId: string;
      generation: number;
      providerAttemptRef: string;
      payloadDigest: string;
      fencingToken: string;
      leaseOwner: string;
      receiptRef: string;
      quiescent: boolean;
      notBeforeEpoch: number | null;
      issuedAtEpoch: number | null;
    };

export interface TenantPeopleInvitationPort {
  dispatch(attempt: PeopleInvitationAttempt): Promise<PeopleInvitationOutcome>;
  readOutcome(attempt: PeopleInvitationAttempt): Promise<PeopleInvitationOutcome>;
}

async function admitAttempt(
  database: PrismaClient,
  tenantId: string,
  operationId: string,
  owner: string,
) {
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const admitted = await transaction.$queryRaw<{ providerAttemptRef: string }[]>`
      INSERT INTO tenant_people_invitation_dispatches
        (tenant_id,operation_id,user_id,generation,provider_attempt_ref,lease_owner)
      SELECT i.tenant_id,i.operation_id,i.user_id,i.generation,i.provider_attempt_ref,${owner}
      FROM tenant_people_invitation_intents i
      JOIN tenant_people_operations o ON o.tenant_id=i.tenant_id AND o.id=i.operation_id AND o.target_user_id=i.user_id
      JOIN tenant_user_lifecycles l ON l.tenant_id=i.tenant_id AND l.user_id=i.user_id AND l.operation_id=i.operation_id
      JOIN users u ON u.tenant_id=i.tenant_id AND u.id=i.user_id
      WHERE i.tenant_id=${tenantId}::uuid AND i.operation_id=${operationId}::uuid
        AND o.state='SUCCEEDED' AND l.account_state='PENDING_ACTIVATION'
        AND l.provisioning_state='PROVISIONED' AND l.activation_state='PENDING'
        AND NOT u.is_active AND u.keycloak_id=l.verified_identity_id
      ON CONFLICT(tenant_id,provider_attempt_ref) DO NOTHING
      RETURNING provider_attempt_ref AS "providerAttemptRef"`;
    const claims = await transaction.$queryRaw<(PeopleInvitationAttempt & { finished: boolean })[]>`
      SELECT d.tenant_id AS "tenantId",d.operation_id AS "operationId",d.user_id AS "userId",
        d.generation,d.provider_attempt_ref AS "providerAttemptRef",o.payload_digest AS "payloadDigest",
        d.fencing_token::text AS "fencingToken",d.lease_owner AS "leaseOwner",d.lease_expires_at AS "leaseExpiresAt",
        EXISTS(SELECT 1 FROM tenant_people_invitation_receipts r WHERE r.tenant_id=d.tenant_id AND r.provider_attempt_ref=d.provider_attempt_ref) AS finished
      FROM tenant_people_invitation_dispatches d
      JOIN tenant_people_operations o ON o.tenant_id=d.tenant_id AND o.id=d.operation_id AND o.target_user_id=d.user_id
      WHERE d.tenant_id=${tenantId}::uuid AND d.operation_id=${operationId}::uuid`;
    if (!claims[0]) return null;
    const { finished, ...attempt } = claims[0];
    return { attempt, dispatch: admitted.length === 1, finished };
  });
}

function matchesAttempt(
  attempt: PeopleInvitationAttempt,
  result: PeopleInvitationOutcome,
): result is Exclude<PeopleInvitationOutcome, { outcome: 'UNKNOWN' }> {
  if (!result || !['SENT', 'FAILED'].includes(result.outcome) || result.outcome === 'UNKNOWN')
    return false;
  if (
    result.tenantId !== attempt.tenantId ||
    result.operationId !== attempt.operationId ||
    result.userId !== attempt.userId ||
    result.generation !== attempt.generation ||
    result.providerAttemptRef !== attempt.providerAttemptRef ||
    result.payloadDigest !== attempt.payloadDigest ||
    result.fencingToken !== attempt.fencingToken ||
    result.leaseOwner !== attempt.leaseOwner ||
    result.quiescent !== true ||
    typeof result.receiptRef !== 'string' ||
    !/^[a-f0-9]{64}$/.test(result.receiptRef)
  )
    return false;
  if (result.outcome === 'FAILED')
    return result.notBeforeEpoch === null && result.issuedAtEpoch === null;
  return (
    typeof result.notBeforeEpoch === 'number' &&
    Number.isSafeInteger(result.notBeforeEpoch) &&
    result.notBeforeEpoch > 0 &&
    typeof result.issuedAtEpoch === 'number' &&
    Number.isSafeInteger(result.issuedAtEpoch) &&
    result.issuedAtEpoch >= result.notBeforeEpoch &&
    result.issuedAtEpoch <= 253402041599
  );
}

export async function runPeopleInvitationAttempt(
  database: PrismaClient,
  provider: TenantPeopleInvitationPort,
  tenant: string,
  operation: string,
  owner: string,
): Promise<'NOT_ELIGIBLE' | 'AMBIGUOUS' | 'RECORDED'> {
  const tenantId = voiceUuid(tenant, 'tenantId');
  const operationId = voiceUuid(operation, 'operationId');
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(owner))
    voiceFail('INVALID_WORKER_OWNER', 400);
  const claim = await admitAttempt(database, tenantId, operationId, owner);
  if (!claim) return 'NOT_ELIGIBLE';
  if (claim.finished) return 'RECORDED';
  let result: PeopleInvitationOutcome = { outcome: 'UNKNOWN' };
  try {
    result = claim.dispatch
      ? await provider.dispatch(claim.attempt)
      : await provider.readOutcome(claim.attempt);
  } catch {}
  if (matchesAttempt(claim.attempt, result)) {
    const proof = result;
    await withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
      await transaction.$executeRaw`INSERT INTO tenant_people_invitation_receipts
        (tenant_id,provider_attempt_ref,outcome,receipt_ref,quiescent,not_before_epoch,issued_at_epoch)
        VALUES(${tenantId}::uuid,${claim.attempt.providerAttemptRef}::uuid,${proof.outcome},${proof.receiptRef},true,${proof.notBeforeEpoch}::bigint,${proof.issuedAtEpoch}::bigint)
        ON CONFLICT DO NOTHING`;
      const receipts = await transaction.$queryRaw<{ matches: boolean }[]>`
        SELECT outcome=${proof.outcome} AND receipt_ref=${proof.receiptRef}
          AND not_before_epoch IS NOT DISTINCT FROM ${proof.notBeforeEpoch}::bigint
          AND issued_at_epoch IS NOT DISTINCT FROM ${proof.issuedAtEpoch}::bigint AS matches
        FROM tenant_people_invitation_receipts
        WHERE tenant_id=${tenantId}::uuid AND provider_attempt_ref=${claim.attempt.providerAttemptRef}::uuid`;
      if (!receipts[0]?.matches) voiceFail('INVITATION_RECEIPT_MISMATCH', 409);
    });
    return 'RECORDED';
  }
  await withTenantDatabaseTransaction(
    database,
    tenantId,
    (transaction) =>
      transaction.$executeRaw`INSERT INTO tenant_people_invitation_ambiguities(tenant_id,provider_attempt_ref)
      VALUES(${tenantId}::uuid,${claim.attempt.providerAttemptRef}::uuid) ON CONFLICT DO NOTHING`,
  );
  return 'AMBIGUOUS';
}
