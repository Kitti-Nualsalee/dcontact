import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { digest, voiceFail, voiceUuid } from './tenant-voice-catalog.js';
import {
  normalizePeopleCreate,
  peopleCreateDigest,
  type PeopleCreateCommand,
} from './tenant-people-input.js';

export type PeopleStep =
  | 'CREATE_IDENTITY'
  | 'TENANT_ROLE'
  | 'ORG_MEMBERSHIP'
  | 'VERIFY_MAPPING'
  | 'INVITATION_INTENT'
  | 'VERIFY_PROVISIONED';
export interface PeopleWorkerClaim {
  tenantId: string;
  operationId: string;
  userId: string;
  correlationId: string;
  payloadDigest: string;
  fencingToken: string;
  owner: string;
  step: PeopleStep;
  reconcileOnly: boolean;
  command: PeopleCreateCommand;
}
export type PeopleStepOutcome =
  | { outcome: 'UNKNOWN'; reasonCode?: 'CORRELATION_CONFLICT' | 'IDENTITY_MAPPING_CONFLICT' }
  | { outcome: 'SUCCEEDED'; receiptRef: string; identityId?: string }
  | { outcome: 'REJECTED_NO_EFFECT'; receiptRef: string };

export interface TenantPeopleIdentityPort {
  mutateStep(claim: PeopleWorkerClaim): Promise<PeopleStepOutcome>;
  readOutcome(claim: PeopleWorkerClaim): Promise<PeopleStepOutcome>;
}

export async function runPeopleWorkerStep(
  database: PrismaClient,
  identity: TenantPeopleIdentityPort,
  tenantId: string,
  operationId: string,
  owner: string,
): Promise<'BUSY' | 'RECORDED' | 'STALE'> {
  const claim = await claimPeopleOperation(database, tenantId, operationId, owner);
  if (!claim) return 'BUSY';
  let result: PeopleStepOutcome;
  try {
    result =
      claim.step === 'INVITATION_INTENT'
        ? {
            outcome: 'SUCCEEDED',
            receiptRef: digest([
              'INVITATION_INTENT',
              claim.tenantId,
              claim.operationId,
              claim.payloadDigest,
            ]),
          }
        : claim.reconcileOnly
          ? await identity.readOutcome(claim)
          : await identity.mutateStep(claim);
  } catch {
    result = { outcome: 'UNKNOWN' };
  }
  return recordPeopleStep(database, claim, result);
}

function ownerId(owner: string) {
  if (typeof owner !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(owner))
    voiceFail('INVALID_WORKER_OWNER', 400);
  return owner;
}

export function claimPeopleOperation(
  database: PrismaClient,
  tenant: string,
  operation: string,
  owner: string,
  leaseSeconds = 30,
): Promise<PeopleWorkerClaim | null> {
  const tenantId = voiceUuid(tenant, 'tenantId'),
    operationId = voiceUuid(operation, 'operationId');
  ownerId(owner);
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 5 || leaseSeconds > 300)
    voiceFail('INVALID_WORKER_LEASE', 400);
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const rows = await transaction.$queryRaw<
      {
        userId: string;
        actorId: string;
        commandId: string;
        correlationId: string;
        payloadDigest: string;
        fencingToken: bigint;
        step: PeopleStep;
        state: string;
        payload: unknown;
      }[]
    >`WITH candidate AS (
      SELECT tenant_id,id FROM tenant_people_operations WHERE tenant_id=${tenantId}::uuid AND id=${operationId}::uuid
        AND state IN ('QUEUED','RUNNING','WAITING_EXTERNAL') AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
      FOR UPDATE SKIP LOCKED
    ) UPDATE tenant_people_operations o SET revision=revision+1,attempt=attempt+1,fencing_token=fencing_token+1,
      state=CASE WHEN state IN ('RUNNING','WAITING_EXTERNAL') THEN 'WAITING_EXTERNAL' ELSE 'RUNNING' END,
      step=CASE WHEN step='RESERVE' THEN 'CREATE_IDENTITY' ELSE step END,
      lease_owner=${owner},lease_expires_at=clock_timestamp()+(${leaseSeconds}::integer*interval '1 second'),updated_at=clock_timestamp()
      FROM candidate c WHERE o.tenant_id=c.tenant_id AND o.id=c.id
      RETURNING o.target_user_id AS "userId",o.actor_user_id AS "actorId",o.command_id AS "commandId",o.correlation_id AS "correlationId",
        o.payload_digest AS "payloadDigest",o.fencing_token AS "fencingToken",o.step,o.state,o.request_payload AS payload`;
    const row = rows[0];
    if (!row) return null;
    if (!row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload))
      voiceFail('PEOPLE_PAYLOAD_CORRUPTED', 409);
    const { infrastructure, ...request } = Object.fromEntries(Object.entries(row.payload));
    const command = normalizePeopleCreate({ ...request, commandId: row.commandId });
    if (digest([tenantId, row.actorId, peopleCreateDigest(command)]) !== row.payloadDigest)
      voiceFail('PEOPLE_PAYLOAD_CORRUPTED', 409);
    return {
      tenantId,
      operationId,
      userId: row.userId,
      correlationId: row.correlationId,
      payloadDigest: row.payloadDigest,
      fencingToken: row.fencingToken.toString(),
      owner,
      step: row.step,
      reconcileOnly: row.state === 'WAITING_EXTERNAL',
      command,
    };
  });
}

const nextStep: Partial<Record<PeopleStep, PeopleStep>> = {
  CREATE_IDENTITY: 'TENANT_ROLE',
  TENANT_ROLE: 'ORG_MEMBERSHIP',
  ORG_MEMBERSHIP: 'VERIFY_MAPPING',
  VERIFY_MAPPING: 'INVITATION_INTENT',
  INVITATION_INTENT: 'VERIFY_PROVISIONED',
};

export function recordPeopleStep(
  database: PrismaClient,
  claim: PeopleWorkerClaim,
  result: PeopleStepOutcome,
): Promise<'RECORDED' | 'STALE'> {
  voiceUuid(claim.tenantId, 'tenantId');
  voiceUuid(claim.operationId, 'operationId');
  ownerId(claim.owner);
  if (
    !/^[1-9][0-9]{0,18}$/.test(claim.fencingToken) ||
    BigInt(claim.fencingToken) > 9223372036854775807n
  )
    voiceFail('INVALID_WORKER_FENCE', 400);
  if (!['SUCCEEDED', 'REJECTED_NO_EFFECT', 'UNKNOWN'].includes(result.outcome))
    voiceFail('INVALID_WORKER_OUTCOME', 400);
  const receiptRef = result.outcome === 'UNKNOWN' ? null : result.receiptRef;
  const reasonCode = result.outcome === 'UNKNOWN' ? (result.reasonCode ?? null) : null;
  if (
    reasonCode !== null &&
    !['CORRELATION_CONFLICT', 'IDENTITY_MAPPING_CONFLICT'].includes(reasonCode)
  )
    voiceFail('INVALID_WORKER_OUTCOME', 400);
  const identityId = result.outcome === 'SUCCEEDED' ? (result.identityId ?? null) : null;
  if (identityId !== null) voiceUuid(identityId, 'identityId');
  if (
    receiptRef !== null &&
    (typeof receiptRef !== 'string' || !/^[A-Za-z0-9_.:-]{1,200}$/.test(receiptRef))
  )
    voiceFail('INVALID_PROVIDER_RECEIPT', 400);
  return withTenantDatabaseTransaction(database, claim.tenantId, async (transaction) => {
    if (
      result.outcome === 'SUCCEEDED' &&
      ['VERIFY_MAPPING', 'VERIFY_PROVISIONED'].includes(claim.step) &&
      identityId !== claim.userId
    )
      voiceFail('PEOPLE_IDENTITY_NOT_VERIFIED', 409);
    const rows = await transaction.$queryRaw<
      {
        step: string;
        fencingToken: bigint;
        owner: string | null;
        valid: boolean;
        payloadDigest: string;
        userId: string;
      }[]
    >`
      SELECT step,fencing_token AS "fencingToken",lease_owner AS owner,(lease_expires_at>clock_timestamp() AND state IN ('RUNNING','WAITING_EXTERNAL')) AS valid,
        payload_digest AS "payloadDigest",target_user_id AS "userId" FROM tenant_people_operations WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.operationId}::uuid FOR UPDATE`;
    const row = rows[0];
    if (!row) return 'STALE';
    const receipts = await transaction.$queryRaw<
      {
        outcome: string;
        providerRef: string | null;
        payloadDigest: string;
        identityId: string | null;
        reasonCode: string | null;
      }[]
    >`
      SELECT outcome,provider_receipt_ref AS "providerRef",payload_digest AS "payloadDigest",verified_identity_id AS "identityId",reason_code AS "reasonCode" FROM tenant_people_step_receipts
      WHERE tenant_id=${claim.tenantId}::uuid AND operation_id=${claim.operationId}::uuid AND step=${claim.step} AND fencing_token=${claim.fencingToken}::bigint`;
    if (receipts[0]) {
      if (
        receipts[0].outcome !== result.outcome ||
        receipts[0].providerRef !== receiptRef ||
        receipts[0].payloadDigest !== claim.payloadDigest ||
        receipts[0].identityId !== identityId ||
        receipts[0].reasonCode !== reasonCode
      )
        voiceFail('PEOPLE_RECEIPT_MISMATCH', 409);
      return 'RECORDED';
    }
    if (
      row.fencingToken.toString() !== claim.fencingToken ||
      row.owner !== claim.owner ||
      !row.valid ||
      row.step !== claim.step ||
      row.payloadDigest !== claim.payloadDigest ||
      row.userId !== claim.userId
    )
      return 'STALE';
    await transaction.$executeRaw`INSERT INTO tenant_people_step_receipts(tenant_id,operation_id,step,fencing_token,payload_digest,outcome,provider_receipt_ref,verified_identity_id,reason_code)
      VALUES(${claim.tenantId}::uuid,${claim.operationId}::uuid,${claim.step},${claim.fencingToken}::bigint,${claim.payloadDigest},${result.outcome},${receiptRef},${identityId}::uuid,${reasonCode})`;
    if (
      result.outcome === 'SUCCEEDED' &&
      ['VERIFY_MAPPING', 'VERIFY_PROVISIONED'].includes(claim.step)
    ) {
      await transaction.$executeRaw`SELECT dc_tenant_people_apply_identity_proof(${claim.tenantId}::uuid,${claim.operationId}::uuid,${claim.fencingToken}::bigint,${identityId}::uuid)`;
    }
    if (result.outcome === 'SUCCEEDED' && claim.step === 'INVITATION_INTENT') {
      await transaction.$executeRaw`INSERT INTO tenant_people_invitation_intents(tenant_id,operation_id,user_id) VALUES(${claim.tenantId}::uuid,${claim.operationId}::uuid,${claim.userId}::uuid) ON CONFLICT(tenant_id,operation_id,generation) DO NOTHING`;
    }
    const state =
      result.outcome === 'UNKNOWN'
        ? reasonCode
          ? 'ACTION_REQUIRED'
          : 'WAITING_EXTERNAL'
        : result.outcome === 'REJECTED_NO_EFFECT'
          ? 'REJECTED'
          : claim.step === 'VERIFY_PROVISIONED'
            ? 'SUCCEEDED'
            : 'QUEUED';
    const step = result.outcome === 'SUCCEEDED' ? (nextStep[claim.step] ?? claim.step) : claim.step;
    await transaction.$executeRaw`UPDATE tenant_people_operations SET revision=revision+1,state=${state},step=${step},lease_owner=NULL,lease_expires_at=NULL,
      error_code=CASE WHEN ${state}='ACTION_REQUIRED' THEN ${reasonCode} WHEN ${state}='WAITING_EXTERNAL' THEN 'IDENTITY_OUTCOME_UNKNOWN' WHEN ${state}='REJECTED' THEN 'IDENTITY_REJECTED_NO_EFFECT' ELSE NULL END,updated_at=clock_timestamp()
      WHERE tenant_id=${claim.tenantId}::uuid AND id=${claim.operationId}::uuid`;
    if (result.outcome === 'SUCCEEDED' && claim.step !== 'VERIFY_PROVISIONED') {
      await transaction.$executeRaw`UPDATE tenant_user_lifecycles SET revision=revision+1,provisioning_state='PENDING'
        WHERE tenant_id=${claim.tenantId}::uuid AND user_id=${claim.userId}::uuid AND provisioning_state='UNKNOWN'`;
    }
    if (result.outcome !== 'SUCCEEDED') {
      await transaction.$executeRaw`UPDATE tenant_user_lifecycles SET revision=revision+1,
        account_state=CASE WHEN ${state} IN ('REJECTED','ACTION_REQUIRED') THEN 'ATTENTION_REQUIRED' ELSE account_state END,
        provisioning_state=CASE WHEN ${state}='REJECTED' THEN 'REJECTED' ELSE 'UNKNOWN' END
        WHERE tenant_id=${claim.tenantId}::uuid AND user_id=${claim.userId}::uuid`;
    }
    return 'RECORDED';
  });
}
