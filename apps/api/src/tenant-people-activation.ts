import { randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import type { PeopleWorkerClaim } from './tenant-people-worker.js';
import { normalizePeopleCreate, peopleCreateDigest } from './tenant-people-input.js';
import { digest, voiceUuid } from './tenant-voice-catalog.js';

export type PeopleActivationClaim = Pick<
  PeopleWorkerClaim,
  'tenantId' | 'operationId' | 'userId' | 'payloadDigest' | 'command'
>;

export type PeopleActivationOutcome =
  | { outcome: 'UNKNOWN' }
  | {
      outcome: 'PENDING' | 'VERIFIED';
      tenantId: string;
      operationId: string;
      userId: string;
      payloadDigest: string;
      probeRef: string;
      serverEpoch: number;
    };

export interface TenantPeopleActivationPort {
  readActivation(claim: PeopleActivationClaim): Promise<PeopleActivationOutcome>;
}

export async function runPeopleActivation(
  database: PrismaClient,
  provider: TenantPeopleActivationPort,
  tenant: string,
  operation: string,
): Promise<'NOT_ELIGIBLE' | 'PENDING' | 'UNKNOWN' | 'STALE' | 'ACTIVATED'> {
  const tenantId = voiceUuid(tenant, 'tenantId');
  const operationId = voiceUuid(operation, 'operationId');
  const attemptId = randomUUID();
  const claim = await withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
    const attempts = await transaction.$queryRaw<
      { user_id: string; payload_digest: string }[]
    >`SELECT user_id,payload_digest FROM dc_people_claim_activation(${tenantId}::uuid,${operationId}::uuid,${attemptId}::uuid)`;
    if (!attempts[0]) return null;
    const rows = await transaction.$queryRaw<
      { payload: unknown; actorId: string; commandId: string }[]
    >`SELECT request_payload AS payload,actor_user_id AS "actorId",command_id AS "commandId" FROM tenant_people_operations WHERE tenant_id=${tenantId}::uuid AND id=${operationId}::uuid`;
    const row = rows[0];
    if (!row || !row.payload || typeof row.payload !== 'object' || Array.isArray(row.payload))
      throw new Error('PEOPLE_ACTIVATION_PAYLOAD_CORRUPTED');
    const { infrastructure, ...request } = Object.fromEntries(Object.entries(row.payload));
    const command = normalizePeopleCreate({ ...request, commandId: row.commandId });
    if (digest([tenantId, row.actorId, peopleCreateDigest(command)]) !== attempts[0].payload_digest)
      throw new Error('PEOPLE_ACTIVATION_PAYLOAD_CORRUPTED');
    return {
      tenantId,
      operationId,
      userId: attempts[0].user_id,
      payloadDigest: attempts[0].payload_digest,
      command,
    };
  });
  if (!claim) return 'NOT_ELIGIBLE';
  let proof: PeopleActivationOutcome;
  try {
    proof = await provider.readActivation(claim);
  } catch {
    return 'UNKNOWN';
  }
  if (proof.outcome === 'UNKNOWN') return 'UNKNOWN';
  if (
    proof.tenantId !== claim.tenantId ||
    proof.operationId !== claim.operationId ||
    proof.userId !== claim.userId ||
    proof.payloadDigest !== claim.payloadDigest ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(proof.probeRef) ||
    !Number.isSafeInteger(proof.serverEpoch) ||
    proof.serverEpoch <= 0 ||
    proof.serverEpoch > 253402041599
  )
    return 'UNKNOWN';
  if (proof.outcome === 'PENDING') return 'PENDING';
  if (proof.outcome !== 'VERIFIED') return 'UNKNOWN';
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
    const rows = await transaction.$queryRaw<
      { applied: boolean }[]
    >`SELECT dc_people_apply_activation(${tenantId}::uuid,${attemptId}::uuid,${proof.probeRef}::uuid,${proof.serverEpoch}::bigint) AS applied`;
    return rows[0]?.applied ? 'ACTIVATED' : 'STALE';
  });
}
