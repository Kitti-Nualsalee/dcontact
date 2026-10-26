import { randomUUID } from 'node:crypto';
import { HttpException } from '@nestjs/common';
import {
  withTenantDatabaseTransaction,
  lockTeamReferences,
  type PrismaClient,
  type Prisma,
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
import { normalizePeopleInvitationCommand } from './tenant-people-invitation-reconcile.js';
import { lockConfigurationClosure } from './tenant-voice-configuration.js';
import type {
  PeopleDisableAttempt,
  TenantPeopleDisablePort,
} from './tenant-people-disable-keycloak.js';

export interface DisablePersonSnapshot {
  id: string;
  keycloak_id: string;
  role: 'AGENT' | 'SUPERVISOR' | 'ADMIN';
  team_id: string | null;
  is_active: boolean;
  config_revision: number;
  status_revision: number | null;
  binding_revision: number | null;
  account_state: string | null;
}

export interface DisableSnapshot {
  target: DisablePersonSnapshot;
  admins: DisablePersonSnapshot[];
}

export interface DisableAccepted {
  operationId: string;
  userId: string;
  status: 'ACCEPTED';
  accountState: 'DISABLING';
  location: string;
}

async function acceptPeopleDisableCommand(
  database: PrismaClient,
  identity: VoiceActor,
  target: string,
  raw: unknown,
  provider: TenantPeopleDisablePort,
): Promise<DisableAccepted> {
  const userId = voiceUuid(target, 'userId');
  const command = normalizePeopleInvitationCommand(raw);
  const intentDigest = digest([
    identity.tenantId,
    identity.userId,
    'DISABLE_TENANT_USER',
    userId,
    command,
  ]);
  const replay = async (transaction: Prisma.TransactionClient) => {
    const [previous] = await transaction.$queryRaw<
      { payloadDigest: string; kind: string; result: DisableAccepted }[]
    >`
      SELECT c.payload_digest AS "payloadDigest",c.command_kind AS kind,r.result_summary AS result
      FROM voice_config_commands c JOIN voice_config_command_receipts r USING(tenant_id,command_id)
      WHERE c.tenant_id=${identity.tenantId}::uuid AND c.command_id=${command.commandId}::uuid`;
    if (!previous) return null;
    if (previous.kind !== 'PEOPLE_DISABLE') voiceFail('COMMAND_ID_REUSED', 409);
    if (previous.payloadDigest !== intentDigest) voiceFail('COMMAND_PAYLOAD_MISMATCH', 409);
    return previous.result;
  };
  const initial = await withTenantDatabaseTransaction(
    database,
    identity.tenantId,
    async (transaction) => {
      await catalogActor(transaction, identity, true);
      const previous = await replay(transaction);
      if (previous) return { previous, snapshot: null };
      const [row] = await transaction.$queryRaw<{ snapshot: DisableSnapshot | null }[]>`
      SELECT dc_people_disable_snapshot(${identity.tenantId}::uuid,${userId}::uuid,${identity.caller!.issuer},${identity.caller!.clientId},${identity.caller!.tenantSlug}) AS snapshot`;
      if (!row?.snapshot) voiceFail('RESOURCE_NOT_FOUND', 404);
      if (row.snapshot.target.config_revision !== command.expectedRevision)
        voiceFail('REVISION_CONFLICT', 409, {
          currentRevision: row.snapshot.target.config_revision,
        });
      return { previous: null, snapshot: row.snapshot };
    },
  );
  if (initial.previous) return initial.previous;
  const snapshot = initial.snapshot!;
  const operationId = randomUUID();
  const payloadDigest = digest([intentDigest, snapshot, operationId]);
  const attempt: PeopleDisableAttempt = {
    tenantId: identity.tenantId,
    operationId,
    userId,
    identityId: snapshot.target.keycloak_id,
    role: snapshot.target.role,
    payloadDigest,
    fencingToken: '1',
    reconcileOnly: false,
    adminCandidates: snapshot.admins.map((admin) => ({
      userId: admin.id,
      identityId: admin.keycloak_id,
    })),
  };
  const proof = await provider.probe(attempt).catch(() => ({ outcome: 'UNKNOWN' as const }));
  if (proof.outcome === 'UNKNOWN') voiceFail('IDENTITY_UNAVAILABLE', 503);
  if (proof.outcome === 'REJECTED') voiceFail(proof.reasonCode, 409);
  return withTenantDatabaseTransaction(database, identity.tenantId, async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
    await catalogActor(transaction, identity, true);
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-command:${identity.tenantId}:${command.commandId}`},0))`;
    const previous = await replay(transaction);
    if (previous) return previous;
    const teams = await transaction.team.findMany({
      where: { tenantId: identity.tenantId },
      select: { id: true },
    });
    await lockTeamReferences(
      transaction,
      identity.tenantId,
      teams.map((team) => team.id),
    );
    const [fences] = await transaction.$queryRaw<{ config: boolean; account: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`dc:v1:voice-config:${identity.tenantId}`},0)) AS config,
        pg_try_advisory_xact_lock(hashtextextended(${`dc:v1:tenant-account:${identity.tenantId}`},0)) AS account`;
    if (!fences?.config || !fences.account) voiceFail('CONFIG_BUSY', 409);
    for (const reference of [
      ...new Set([identity.userId, userId, ...snapshot.admins.map((admin) => admin.id)]),
    ].sort()) {
      await transaction.$queryRaw`SELECT id FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${reference}::uuid FOR UPDATE NOWAIT`;
    }
    const skills = await transaction.agentSkill.findMany({
      where: { tenantId: identity.tenantId, userId },
      select: { skillId: true },
    });
    await lockConfigurationClosure(
      transaction,
      identity,
      [],
      snapshot.target.role === 'AGENT' ? [userId] : [],
      snapshot.target.role === 'AGENT' ? skills.map((skill) => skill.skillId) : [],
      teams.map((team) => team.id),
    );
    const [idle] = await transaction.$queryRaw<{ idle: boolean }[]>`
      SELECT dc_people_disable_idle(${identity.tenantId}::uuid,${userId}::uuid) AS idle`;
    if (!idle?.idle) voiceFail('CONFIG_BUSY', 409);
    const resourcePolicy = await policy(transaction, identity.tenantId);
    if (resourcePolicy.reason)
      voiceFail(
        resourcePolicy.reason,
        resourcePolicy.reason === 'RESOURCE_POLICY_STALE' ? 409 : 503,
      );
    const [current] = await transaction.$queryRaw<{ snapshot: DisableSnapshot | null }[]>`
      SELECT dc_people_disable_snapshot(${identity.tenantId}::uuid,${userId}::uuid,${identity.caller!.issuer},${identity.caller!.clientId},${identity.caller!.tenantSlug}) AS snapshot`;
    if (digest(current?.snapshot) !== digest(snapshot)) voiceFail('REVISION_CONFLICT', 409);
    const [pending] = await transaction.$queryRaw<{ id: string }[]>`
      SELECT id FROM tenant_people_disables WHERE tenant_id=${identity.tenantId}::uuid AND state IN ('QUEUED','WAITING_EXTERNAL','ACTION_REQUIRED')
        AND (user_id=${userId}::uuid OR (${snapshot.target.role === 'ADMIN'} AND role='ADMIN')) LIMIT 1`;
    if (pending) voiceFail('CONFIG_BUSY', 409);
    const [closure] = await transaction.$queryRaw<{ queue_ids: string[]; user_ids: string[] }[]>`
      SELECT * FROM dc_people_disable_closure(${identity.tenantId}::uuid,${userId}::uuid)`;
    await transaction.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind)
      VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,'DISABLE_TENANT_USER',${userId}::uuid,${intentDigest},${command.expectedRevision},'PEOPLE_DISABLE')`;
    await transaction.$executeRaw`INSERT INTO tenant_people_disables(tenant_id,id,command_id,actor_user_id,user_id,identity_id,role,expected_revision,snapshot,payload_digest,issuer,client_id,tenant_slug,affected_queues,affected_users,reason_code,reason)
      VALUES(${identity.tenantId}::uuid,${operationId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${userId}::uuid,${attempt.identityId}::uuid,${attempt.role},${command.expectedRevision},${JSON.stringify(snapshot)}::jsonb,${payloadDigest},${identity.caller!.issuer},${identity.caller!.clientId},${identity.caller!.tenantSlug},${closure.queue_ids}::uuid[],${closure.user_ids}::uuid[],${command.reasonCode},${command.reason})`;
    await transaction.$executeRaw`SELECT dc_people_accept_disable(${identity.tenantId}::uuid,${operationId}::uuid)`;
    const result: DisableAccepted = {
      operationId,
      userId,
      status: 'ACCEPTED',
      accountState: 'DISABLING',
      location: `/api/v1/tenant-voice/operations/${operationId}`,
    };
    await transaction.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${JSON.stringify(result)}::jsonb)`;
    await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id)
      VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,'DISABLE_TENANT_USER','ACCEPTED',${command.expectedRevision},${command.expectedRevision + 1},ARRAY['isActive','accountState','disableOperation'],${command.reasonCode},${identity.correlationId ?? operationId})`;
    return result;
  }).catch(mapDatabaseError);
}

export async function acceptPeopleDisable(
  database: PrismaClient,
  identity: VoiceActor,
  target: string,
  raw: unknown,
  provider: TenantPeopleDisablePort,
): Promise<DisableAccepted> {
  const userId = voiceUuid(target, 'userId');
  const command = normalizePeopleInvitationCommand(raw);
  try {
    return await acceptPeopleDisableCommand(database, identity, userId, command, provider);
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
            VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,'DISABLE_TENANT_USER','REJECTED',${code},${identity.correlationId ?? randomUUID()})`;
        });
      }
      throw mapped;
    }
    throw error;
  }
}

export interface PeopleDisableFlushPort {
  flush(input: {
    tenantId: string;
    extension: string;
    sipDomain: string;
    telephonyNodeId: string;
    workSessionLeaseId: string;
  }): Promise<void>;
}

export async function runPeopleDisable(
  database: PrismaClient,
  provider: TenantPeopleDisablePort,
  flush: PeopleDisableFlushPort,
  tenant: string,
  operation: string,
) {
  const tenantId = voiceUuid(tenant, 'tenantId'),
    operationId = voiceUuid(operation, 'operationId'),
    ownerId = randomUUID();
  const [claim] = await withTenantDatabaseTransaction(
    database,
    tenantId,
    (transaction) =>
      transaction.$queryRaw<
        {
          descriptor: {
            user_id: string;
            identity_id: string;
            role: PeopleDisableAttempt['role'];
            payload_digest: string;
            fencing_token: string;
            snapshot: DisableSnapshot;
          };
          reconcile_only: boolean;
        }[]
      >`SELECT * FROM dc_people_claim_disable(${tenantId}::uuid,${operationId}::uuid,${ownerId}::uuid)`,
  );
  if (!claim) return 'NOT_ELIGIBLE';
  const descriptor = claim.descriptor;
  const attempt: PeopleDisableAttempt = {
    tenantId,
    operationId,
    userId: descriptor.user_id,
    identityId: descriptor.identity_id,
    role: descriptor.role,
    payloadDigest: descriptor.payload_digest,
    fencingToken: String(descriptor.fencing_token),
    reconcileOnly: claim.reconcile_only,
    adminCandidates: descriptor.snapshot.admins.map((admin) => ({
      userId: admin.id,
      identityId: admin.keycloak_id,
    })),
  };
  const pendingFlushes = () =>
    withTenantDatabaseTransaction(
      database,
      tenantId,
      (transaction) =>
        transaction.$queryRaw<
          {
            work_session_lease_id: string;
            extension: string;
            sip_domain: string;
            telephony_node_id: string;
            confirmed: boolean;
          }[]
        >`SELECT * FROM dc_people_disable_flush_status(${tenantId}::uuid,${operationId}::uuid)`,
    );
  for (const registration of await pendingFlushes()) {
    if (registration.confirmed) continue;
    await flush
      .flush({
        tenantId,
        extension: registration.extension,
        sipDomain: registration.sip_domain,
        telephonyNodeId: registration.telephony_node_id,
        workSessionLeaseId: registration.work_session_lease_id,
      })
      .catch(() => undefined);
  }
  let outcome = await (
    claim.reconcile_only ? provider.readOutcome(attempt) : provider.disable(attempt)
  ).catch(() => ({ outcome: 'UNKNOWN' as const }));
  if (outcome.outcome === 'UNKNOWN')
    outcome = await provider
      .readOutcome({ ...attempt, reconcileOnly: true })
      .catch(() => ({ outcome: 'UNKNOWN' as const }));
  if (outcome.outcome !== 'UNKNOWN' && outcome.identityId !== attempt.identityId)
    outcome = { outcome: 'UNKNOWN' };
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const [result] = await transaction.$queryRaw<{ state: string }[]>`
      SELECT dc_people_record_disable(${tenantId}::uuid,${operationId}::uuid,${ownerId}::uuid,${attempt.fencingToken}::bigint,${attempt.payloadDigest},${attempt.identityId}::uuid,
        ${outcome.outcome},${outcome.outcome === 'UNKNOWN' ? null : outcome.receiptRef},${outcome.outcome === 'UNKNOWN' ? 'IDENTITY_OUTCOME_UNKNOWN' : outcome.reasonCode}) AS state`;
    return result.state;
  });
}
