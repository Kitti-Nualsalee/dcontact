import { randomUUID } from 'node:crypto';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  catalogActor,
  digest,
  mapDatabaseError,
  policy,
  voiceFail,
  voiceUuid,
  type VoiceActor,
} from './tenant-voice-catalog.js';
import { normalizePeopleCreate, peopleCreateDigest } from './tenant-people-input.js';
import {
  extensionPermit,
  type PeopleTelephonyNode,
  type PeopleExtensionPermit,
} from './tenant-people-infrastructure.js';

export interface PeopleAccepted {
  operationId: string;
  userId: string;
  status: 'ACCEPTED';
  location: string;
}

export function acceptPeopleCreate(
  db: PrismaClient,
  identity: VoiceActor,
  raw: unknown,
  nodes: readonly PeopleTelephonyNode[] = [],
) {
  const command = normalizePeopleCreate(raw);
  const payloadDigest = digest([identity.tenantId, identity.userId, peopleCreateDigest(command)]);
  return withTenantDatabaseTransaction(db, identity.tenantId, async (transaction) => {
    await transaction.$executeRawUnsafe("SET LOCAL lock_timeout='250ms'");
    await transaction.$executeRawUnsafe("SET LOCAL statement_timeout='2s'");
    await catalogActor(transaction, identity, true);
    await transaction.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:voice-command:${identity.tenantId}:${command.commandId}`},0))`;
    const previous = await transaction.$queryRaw<
      {
        payloadDigest: string;
        result: PeopleAccepted;
      }[]
    >`SELECT c.payload_digest AS "payloadDigest",r.result_summary AS result FROM voice_config_commands c JOIN voice_config_command_receipts r USING(tenant_id,command_id) WHERE c.tenant_id=${identity.tenantId}::uuid AND c.command_id=${command.commandId}::uuid`;
    if (previous[0]) {
      if (previous[0].payloadDigest !== payloadDigest) voiceFail('COMMAND_PAYLOAD_MISMATCH', 409);
      return previous[0].result;
    }
    const fence = await transaction.$queryRaw<
      { ok: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`dc:v1:voice-config:${identity.tenantId}`},0)) AS ok`;
    if (!fence[0]?.ok) voiceFail('CONFIG_BUSY', 409);
    const accountFence = await transaction.$queryRaw<
      { ok: boolean }[]
    >`SELECT pg_try_advisory_xact_lock(hashtextextended(${`dc:v1:tenant-people:${identity.tenantId}`},0)) AS ok`;
    if (!accountFence[0]?.ok) voiceFail('CONFIG_BUSY', 409);
    const references = [
      { table: 'users', id: identity.userId },
      { table: 'teams', id: command.teamId },
      { table: 'tenants', id: identity.tenantId },
    ].sort(
      (left, right) => left.id.localeCompare(right.id) || left.table.localeCompare(right.table),
    );
    for (const reference of references) {
      if (reference.table === 'tenants') {
        await transaction.$queryRaw`SELECT id FROM tenants WHERE id=${reference.id}::uuid FOR UPDATE NOWAIT`;
      } else {
        await transaction.$queryRawUnsafe(
          `SELECT id FROM ${reference.table} WHERE id=$1::uuid AND tenant_id=$2::uuid FOR UPDATE NOWAIT`,
          reference.id,
          identity.tenantId,
        );
      }
    }
    await transaction.$executeRaw`SELECT dc_voice_lock_policy_refs(${identity.tenantId}::uuid)`;
    await catalogActor(transaction, identity, true);
    const team = await transaction.team.findFirst({
      where: { id: command.teamId, tenantId: identity.tenantId, isActive: true },
    });
    if (!team) voiceFail('REFERENCE_SCOPE_MISMATCH', 409);
    const resourcePolicy = await policy(transaction, identity.tenantId);
    if (resourcePolicy.reason)
      voiceFail(
        resourcePolicy.reason,
        resourcePolicy.reason === 'RESOURCE_POLICY_STALE' ? 409 : 503,
      );
    const usage = await transaction.user.count({ where: { tenantId: identity.tenantId } });
    if (usage >= resourcePolicy.policy!.accountsLimit) voiceFail('RESOURCE_LIMIT_REACHED', 429);
    let infrastructure: PeopleExtensionPermit | null = null;
    if (command.role === 'AGENT') {
      const agents = await transaction.user.count({
        where: { tenantId: identity.tenantId, role: 'AGENT' },
      });
      if (agents >= resourcePolicy.policy!.agentsLimit) voiceFail('RESOURCE_LIMIT_REACHED', 429);
      const pools = await transaction.$queryRaw<
        { extensionPool: unknown }[]
      >`SELECT extension_pool AS "extensionPool" FROM tenant_voice_provisioning_policies WHERE tenant_id=${identity.tenantId}::uuid`;
      infrastructure = extensionPermit(
        pools[0]?.extensionPool,
        resourcePolicy.policy!.revision,
        command.extension!,
        nodes,
      );
      if (!infrastructure) voiceFail('EXTENSION_NOT_RESERVED', 409);
    }
    const userId = randomUUID(),
      operationId = randomUUID(),
      correlationId = randomUUID();
    await transaction.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,command_kind) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,'CREATE_TENANT_USER',${userId}::uuid,${payloadDigest},'PEOPLE_CREATE')`;
    await transaction.user.create({
      data: {
        id: userId,
        tenantId: identity.tenantId,
        teamId: command.teamId,
        email: command.email,
        displayName: command.displayName,
        role: command.role,
        extension: command.extension,
        passwordHash: '!keycloak-managed',
        isActive: false,
      },
    });
    const requestPayload = {
      infrastructure,
      displayName: command.displayName,
      email: command.email,
      role: command.role,
      teamId: command.teamId,
      extension: command.extension,
    };
    await transaction.$executeRaw`INSERT INTO tenant_people_operations(tenant_id,id,command_id,actor_user_id,target_user_id,action,payload_digest,request_payload,correlation_id) VALUES(${identity.tenantId}::uuid,${operationId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${userId}::uuid,'CREATE_TENANT_USER',${payloadDigest},${JSON.stringify(requestPayload)}::jsonb,${correlationId}::uuid)`;
    const reservations = [
      { kind: 'EMAIL', value: command.email },
      ...(command.extension ? [{ kind: 'EXTENSION', value: command.extension }] : []),
    ];
    for (const reservation of reservations) {
      await transaction.$executeRaw`INSERT INTO tenant_identity_reservations(tenant_id,identity_kind,identity_hash,operation_id,target_user_id) VALUES(${identity.tenantId}::uuid,${reservation.kind},${digest([reservation.kind, reservation.value])},${operationId}::uuid,${userId}::uuid)`;
    }
    await transaction.$executeRaw`INSERT INTO tenant_user_lifecycles(tenant_id,user_id,operation_id,creation_role,creation_team_id) VALUES(${identity.tenantId}::uuid,${userId}::uuid,${operationId}::uuid,${command.role},${command.teamId}::uuid)`;
    const result: PeopleAccepted = {
      operationId,
      userId,
      status: 'ACCEPTED',
      location: `/api/v1/tenant-voice/operations/${operationId}`,
    };
    await transaction.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${JSON.stringify(result)}::jsonb)`;
    await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,after_revision,changed_keys,reason_code,correlation_id) VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,'CREATE_TENANT_USER','ACCEPTED',1,ARRAY['reservation','operation','lifecycle'],'PEOPLE_CREATE',${identity.correlationId ?? correlationId})`;
    await transaction.$executeRawUnsafe('SET CONSTRAINTS voice_receipt_required IMMEDIATE');
    return result;
  }).catch(mapDatabaseError);
}

export function readPeopleExtensionPool(
  db: PrismaClient,
  identity: VoiceActor,
  nodes: readonly PeopleTelephonyNode[],
) {
  return withTenantDatabaseTransaction(db, identity.tenantId, async (transaction) => {
    await catalogActor(transaction, identity, true);
    const effective = await policy(transaction, identity.tenantId);
    if (effective.reason) voiceFail(effective.reason, 503);
    const rows = await transaction.$queryRaw<
      { pool: unknown; revision: number }[]
    >`SELECT extension_pool AS pool,revision FROM tenant_voice_provisioning_policies WHERE tenant_id=${identity.tenantId}::uuid`;
    const row = rows[0];
    if (!row || !Array.isArray(row.pool)) voiceFail('RESOURCE_POLICY_NOT_READY', 503);
    const occupied = await transaction.user.findMany({
      where: { tenantId: identity.tenantId, extension: { not: null } },
      select: { extension: true },
    });
    const used = new Set(occupied.map((user) => user.extension));
    const refs = row.pool.flatMap((value) =>
      value && typeof value === 'object' && 'ref' in value && typeof value.ref === 'string'
        ? [value.ref]
        : [],
    );
    return {
      poolRevision: row.revision,
      items: [...new Set(refs)]
        .filter((ref) => !used.has(ref) && extensionPermit(row.pool, row.revision, ref, nodes))
        .map((ref) => ({ ref })),
    };
  });
}

export function readPeopleOperation(db: PrismaClient, identity: VoiceActor, operationId: string) {
  const id = voiceUuid(operationId, 'operationId');
  return withTenantDatabaseTransaction(db, identity.tenantId, async (transaction) => {
    await catalogActor(transaction, identity, true);
    const rows = await transaction.$queryRaw<
      {
        operationId: string;
        userId: string;
        state: string;
        step: string;
        revision: number;
        accountState: string;
        activationState: string;
        provisioningState: string;
        errorCode: string | null;
        createdAt: Date;
        updatedAt: Date;
      }[]
    >`SELECT o.id AS "operationId",o.target_user_id AS "userId",o.state,o.step,o.revision,l.account_state AS "accountState",l.activation_state AS "activationState",l.provisioning_state AS "provisioningState",o.error_code AS "errorCode",o.created_at AS "createdAt",o.updated_at AS "updatedAt" FROM tenant_people_operations o JOIN tenant_user_lifecycles l ON l.tenant_id=o.tenant_id AND l.user_id=o.target_user_id WHERE o.tenant_id=${identity.tenantId}::uuid AND o.id=${id}::uuid`;
    if (rows[0]) return rows[0];
    const reconciles = await transaction.$queryRaw<typeof rows>`
      SELECT operation.id AS "operationId",operation.user_id AS "userId",operation.state,'RECONCILE_INVITATION' AS step,operation.revision,
        lifecycle.account_state AS "accountState",lifecycle.activation_state AS "activationState",lifecycle.provisioning_state AS "provisioningState",
        operation.error_code AS "errorCode",operation.created_at AS "createdAt",operation.updated_at AS "updatedAt"
      FROM tenant_people_invitation_reconciles operation JOIN tenant_user_lifecycles lifecycle ON lifecycle.tenant_id=operation.tenant_id AND lifecycle.user_id=operation.user_id
      WHERE operation.tenant_id=${identity.tenantId}::uuid AND operation.id=${id}::uuid
      UNION ALL
      SELECT operation.id AS "operationId",operation.user_id AS "userId",
        CASE WHEN preparation.resend_id IS NULL THEN 'QUEUED' ELSE 'WAITING_EXTERNAL' END AS state,
        CASE WHEN proof.provider_attempt_ref IS NOT NULL THEN 'DISPATCH_INVITATION' WHEN preparation.resend_id IS NOT NULL THEN 'READ_INVITATION_FENCE' ELSE 'PREPARE_INVITATION' END AS step,
        CASE WHEN proof.provider_attempt_ref IS NOT NULL THEN 3 WHEN preparation.resend_id IS NOT NULL THEN 2 ELSE 1 END AS revision,
        lifecycle.account_state AS "accountState",lifecycle.activation_state AS "activationState",lifecycle.provisioning_state AS "provisioningState",
        NULL AS "errorCode",operation.created_at AS "createdAt",COALESCE(proof.recorded_at,preparation.created_at,operation.created_at) AS "updatedAt"
      FROM tenant_people_invitation_resends operation JOIN tenant_user_lifecycles lifecycle ON lifecycle.tenant_id=operation.tenant_id AND lifecycle.user_id=operation.user_id
      LEFT JOIN tenant_people_invitation_preparations preparation ON preparation.tenant_id=operation.tenant_id AND preparation.resend_id=operation.id
      LEFT JOIN tenant_people_invitation_preparation_proofs proof ON proof.tenant_id=preparation.tenant_id AND proof.provider_attempt_ref=preparation.provider_attempt_ref
      WHERE operation.tenant_id=${identity.tenantId}::uuid AND operation.id=${id}::uuid`;
    if (!reconciles[0]) voiceFail('RESOURCE_NOT_FOUND', 404);
    return reconciles[0];
  });
}
