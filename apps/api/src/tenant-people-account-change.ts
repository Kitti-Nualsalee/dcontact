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
import type {
  PeopleAccountAttempt,
  PeopleAccountOutcome,
  PeopleAccountStep,
  TenantPeopleAccountPort,
} from './tenant-people-account-keycloak.js';

/** #998 1B/2: the snapshot of dc_people_account_snapshot (a positive proof including accounts that were successfully disabled) */
export interface AccountSnapshot {
  id: string;
  keycloak_id: string;
  role: 'AGENT' | 'SUPERVISOR' | 'ADMIN';
  team_id: string | null;
  is_active: boolean;
  config_revision: number;
  display_name: string;
  extension: string | null;
  status_revision: number | null;
  account_state: string | null;
  activation_state: string | null;
  binding_revision: number | null;
  disable_operation_id: string | null;
}

export interface AccountChangeAccepted {
  operationId: string;
  userId: string;
  kind: PeopleAccountStep;
  status: 'ACCEPTED';
  location: string;
}

interface AccountChangeCommand {
  commandId: string;
  expectedRevision: number;
  reason: string;
  displayName: string | null;
}

function text(value: unknown, field: string, maximum: number) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value))
    voiceFail('VALIDATION_FAILED', 400, { field });
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if ([...normalized].length < 1 || [...normalized].length > maximum)
    voiceFail('VALIDATION_FAILED', 400, { field });
  return normalized;
}

/** the body of PATCH .../profile (has displayName) and POST .../enable (does not) — accepts no role/team/email/extension */
export function normalizeAccountChangeCommand(
  kind: PeopleAccountStep,
  raw: unknown,
): AccountChangeCommand {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) voiceFail('VALIDATION_FAILED', 400);
  const fields: Record<string, unknown> = Object.fromEntries(Object.entries(raw));
  const allowed = ['commandId', 'expectedRevision', 'reason'];
  if (kind === 'UPDATE_PROFILE') allowed.push('displayName');
  if (Object.keys(fields).some((key) => !allowed.includes(key)))
    voiceFail('VALIDATION_FAILED', 400);
  const commandId = voiceUuid(fields.commandId, 'commandId');
  if (
    typeof fields.expectedRevision !== 'number' ||
    !Number.isInteger(fields.expectedRevision) ||
    fields.expectedRevision < 1 ||
    fields.expectedRevision > 2147483647
  )
    voiceFail('VALIDATION_FAILED', 400, { field: 'expectedRevision' });
  return {
    commandId,
    expectedRevision: fields.expectedRevision,
    reason: text(fields.reason, 'reason', 500),
    displayName: kind === 'UPDATE_PROFILE' ? text(fields.displayName, 'displayName', 120) : null,
  };
}

const domainCodes: readonly [string, number][] = [
  ['PEOPLE_ACCOUNT_CHANGE_SCOPE_DENIED', 403],
  ['ACCOUNT_STATE_CONFLICT', 409],
  ['EXTENSION_CONFLICT', 409],
  ['RESOURCE_LIMIT_REACHED', 429],
  ['tenant_people_account_change_pending', 409],
  ['VALIDATION_FAILED', 400],
];

/** a code from the definer that the central mapDatabaseError does not know, separated out before falling into CONFIG_BUSY/IDENTITY_CONFLICT */
function mapAccountChangeError(error: unknown): never {
  if (!(error instanceof HttpException)) {
    const message = error instanceof Error ? error.message : '';
    for (const [code, status] of domainCodes)
      if (message.includes(code)) {
        if (status === 403) voiceFail('FORBIDDEN', 403);
        if (code === 'tenant_people_account_change_pending') voiceFail('CONFIG_BUSY', 409);
        if (code === 'VALIDATION_FAILED')
          voiceFail('VALIDATION_FAILED', 400, { field: 'displayName' });
        voiceFail(code, status);
      }
  }
  return mapDatabaseError(error);
}

async function readSnapshot(
  transaction: Prisma.TransactionClient,
  identity: VoiceActor,
  userId: string,
) {
  const [row] = await transaction.$queryRaw<{ snapshot: AccountSnapshot | null }[]>`
    SELECT dc_people_account_snapshot(${identity.tenantId}::uuid,${userId}::uuid,${identity.caller!.issuer},${identity.caller!.clientId},${identity.caller!.tenantSlug}) AS snapshot`;
  return row?.snapshot ?? null;
}

async function blocker(
  transaction: Prisma.TransactionClient,
  identity: VoiceActor,
  kind: PeopleAccountStep,
  snapshot: AccountSnapshot,
) {
  const [row] = await transaction.$queryRaw<{ blocker: string | null; pending: boolean }[]>`
    SELECT dc_people_account_change_blocker(${identity.tenantId}::uuid,${kind},${JSON.stringify(snapshot)}::jsonb) AS blocker,
      dc_people_account_change_pending(${identity.tenantId}::uuid,${snapshot.id}::uuid) AS pending`;
  if (row?.pending) voiceFail('CONFIG_BUSY', 409);
  if (row?.blocker === 'RESOURCE_NOT_FOUND') voiceFail('RESOURCE_NOT_FOUND', 404);
  if (row?.blocker) voiceFail(row.blocker, 409);
}

async function acceptCommand(
  database: PrismaClient,
  identity: VoiceActor,
  kind: PeopleAccountStep,
  userId: string,
  command: AccountChangeCommand,
  provider: TenantPeopleAccountPort,
): Promise<AccountChangeAccepted> {
  const intentDigest = digest([identity.tenantId, identity.userId, kind, userId, command]);
  const replay = async (transaction: Prisma.TransactionClient) => {
    const [previous] = await transaction.$queryRaw<
      { payloadDigest: string; kind: string; action: string; result: AccountChangeAccepted }[]
    >`
      SELECT c.payload_digest AS "payloadDigest",c.command_kind AS kind,c.action,r.result_summary AS result
      FROM voice_config_commands c JOIN voice_config_command_receipts r USING(tenant_id,command_id)
      WHERE c.tenant_id=${identity.tenantId}::uuid AND c.command_id=${command.commandId}::uuid`;
    if (!previous) return null;
    if (previous.kind !== 'PEOPLE_ACCOUNT_CHANGE' || previous.action !== kind)
      voiceFail('COMMAND_ID_REUSED', 409);
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
      const snapshot = await readSnapshot(transaction, identity, userId);
      if (!snapshot) voiceFail('RESOURCE_NOT_FOUND', 404);
      if (snapshot.config_revision !== command.expectedRevision)
        voiceFail('REVISION_CONFLICT', 409, { currentRevision: snapshot.config_revision });
      if (kind === 'UPDATE_PROFILE' && snapshot.display_name === command.displayName)
        voiceFail('VALIDATION_FAILED', 400, { field: 'displayName' });
      await blocker(transaction, identity, kind, snapshot);
      return { previous: null, snapshot };
    },
  );
  if (initial.previous) return initial.previous;
  const snapshot = initial.snapshot!;
  const operationId = randomUUID();
  const payloadDigest = digest([intentDigest, snapshot, operationId]);
  const attempt: PeopleAccountAttempt = {
    step: kind,
    tenantId: identity.tenantId,
    operationId,
    userId,
    identityId: snapshot.keycloak_id,
    role: snapshot.role,
    payloadDigest,
    fencingToken: '1',
    displayName: command.displayName,
    reconcileOnly: false,
  };
  // check the live identity before accepting the command: reject on a certain outcome (no password/TOTP, identity mismatch) and create no pending command
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
    if (snapshot.team_id)
      await lockTeamReferences(transaction, identity.tenantId, [snapshot.team_id]);
    const [fences] = await transaction.$queryRaw<{ config: boolean; account: boolean }[]>`
      SELECT pg_try_advisory_xact_lock(hashtextextended(${`dc:v1:voice-config:${identity.tenantId}`},0)) AS config,
        pg_try_advisory_xact_lock(hashtextextended(${`dc:v1:tenant-account:${identity.tenantId}`},0)) AS account`;
    if (!fences?.config || !fences.account) voiceFail('CONFIG_BUSY', 409);
    for (const reference of [...new Set([identity.userId, userId])].sort())
      await transaction.$queryRaw`SELECT id FROM users WHERE tenant_id=${identity.tenantId}::uuid AND id=${reference}::uuid FOR UPDATE NOWAIT`;
    const current = await readSnapshot(transaction, identity, userId);
    if (digest(current) !== digest(snapshot)) voiceFail('REVISION_CONFLICT', 409);
    await blocker(transaction, identity, kind, snapshot);
    if (kind === 'ENABLE_ACCOUNT') {
      const resourcePolicy = await policy(transaction, identity.tenantId);
      if (resourcePolicy.reason)
        voiceFail(
          resourcePolicy.reason,
          resourcePolicy.reason === 'RESOURCE_POLICY_STALE' ? 409 : 503,
        );
      const [usage] = await transaction.$queryRaw<{ accounts: number; agents: number }[]>`
        SELECT dc_people_reserved_accounts(${identity.tenantId}::uuid,false)::integer AS accounts,
          dc_people_reserved_accounts(${identity.tenantId}::uuid,true)::integer AS agents`;
      if (
        usage.accounts >= resourcePolicy.policy!.accountsLimit ||
        (snapshot.role === 'AGENT' && usage.agents >= resourcePolicy.policy!.agentsLimit)
      )
        voiceFail('RESOURCE_LIMIT_REACHED', 429);
      const [idle] = await transaction.$queryRaw<{ idle: boolean }[]>`
        SELECT dc_people_disable_idle(${identity.tenantId}::uuid,${userId}::uuid) AS idle`;
      if (!idle?.idle) voiceFail('CONFIG_BUSY', 409);
    }
    await transaction.$executeRaw`INSERT INTO voice_config_commands(tenant_id,command_id,actor_user_id,action,resource_id,payload_digest,expected_revision,command_kind)
      VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${identity.userId}::uuid,${kind},${userId}::uuid,${intentDigest},${command.expectedRevision},'PEOPLE_ACCOUNT_CHANGE')`;
    await transaction.$executeRaw`INSERT INTO tenant_people_account_changes(tenant_id,id,kind,command_id,actor_user_id,user_id,identity_id,role,expected_revision,snapshot,display_name,payload_digest,issuer,client_id,tenant_slug,reason)
      VALUES(${identity.tenantId}::uuid,${operationId}::uuid,${kind},${command.commandId}::uuid,${identity.userId}::uuid,${userId}::uuid,${attempt.identityId}::uuid,${attempt.role},${command.expectedRevision},
        ${JSON.stringify(snapshot)}::jsonb,${command.displayName},${payloadDigest},${identity.caller!.issuer},${identity.caller!.clientId},${identity.caller!.tenantSlug},${command.reason})`;
    await transaction.$executeRaw`SELECT dc_people_accept_account_change(${identity.tenantId}::uuid,${operationId}::uuid)`;
    const result: AccountChangeAccepted = {
      operationId,
      userId,
      kind,
      status: 'ACCEPTED',
      location: `/api/v1/tenant-voice/operations/${operationId}`,
    };
    await transaction.$executeRaw`INSERT INTO voice_config_command_receipts(tenant_id,command_id,result_summary) VALUES(${identity.tenantId}::uuid,${command.commandId}::uuid,${JSON.stringify(result)}::jsonb)`;
    await transaction.$executeRaw`INSERT INTO voice_config_audit(id,tenant_id,actor_user_id,resource_id,command_id,action,outcome,before_revision,after_revision,changed_keys,reason_code,correlation_id)
      VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,${kind},'ACCEPTED',${command.expectedRevision},${command.expectedRevision},
        ${kind === 'UPDATE_PROFILE' ? ['displayName', 'accountChangeOperation'] : ['isActive', 'accountState', 'accountChangeOperation']},'OPERATOR_REQUEST',${identity.correlationId ?? operationId})`;
    return result;
  }).catch(mapAccountChangeError);
}

export async function acceptPeopleAccountChange(
  database: PrismaClient,
  identity: VoiceActor,
  kind: PeopleAccountStep,
  target: string,
  raw: unknown,
  provider: TenantPeopleAccountPort,
): Promise<AccountChangeAccepted> {
  const userId = voiceUuid(target, 'userId');
  const command = normalizeAccountChangeCommand(kind, raw);
  try {
    return await acceptCommand(database, identity, kind, userId, command, provider).catch(
      mapAccountChangeError,
    );
  } catch (error) {
    // record the rejection in a separate transaction after the rollback, without keeping the name or reason that was entered
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
            VALUES(${randomUUID()}::uuid,${identity.tenantId}::uuid,${identity.userId}::uuid,${userId}::uuid,${command.commandId}::uuid,${kind},'REJECTED',${code},${identity.correlationId ?? randomUUID()})`;
        }).catch(() => undefined);
    }
    throw error;
  }
}

/**
 * worker: claim with a fenced lease → Keycloak → record in a single transaction
 * once attempted it only reads the receipt (GET) and never resends the mutation; an unclear outcome keeps the original state as ACTION_REQUIRED
 */
export async function runPeopleAccountChange(
  database: PrismaClient,
  provider: TenantPeopleAccountPort,
  tenant: string,
  operation: string,
): Promise<string> {
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
            kind: PeopleAccountStep;
            user_id: string;
            identity_id: string;
            role: PeopleAccountAttempt['role'];
            payload_digest: string;
            fencing_token: string;
            display_name: string | null;
          };
          reconcile_only: boolean;
        }[]
      >`SELECT * FROM dc_people_claim_account_change(${tenantId}::uuid,${operationId}::uuid,${ownerId}::uuid)`,
  );
  if (!claim) return 'NOT_ELIGIBLE';
  const descriptor = claim.descriptor;
  const attempt: PeopleAccountAttempt = {
    step: descriptor.kind,
    tenantId,
    operationId,
    userId: descriptor.user_id,
    identityId: descriptor.identity_id,
    role: descriptor.role,
    payloadDigest: descriptor.payload_digest,
    fencingToken: String(descriptor.fencing_token),
    displayName: descriptor.display_name,
    reconcileOnly: claim.reconcile_only,
  };
  let outcome: PeopleAccountOutcome = await (
    claim.reconcile_only ? provider.readOutcome(attempt) : provider.mutate(attempt)
  ).catch(() => ({ outcome: 'UNKNOWN' as const }));
  if (outcome.outcome === 'UNKNOWN')
    outcome = await provider
      .readOutcome({ ...attempt, reconcileOnly: true })
      .catch(() => ({ outcome: 'UNKNOWN' as const }));
  if (outcome.outcome !== 'UNKNOWN' && outcome.identityId !== attempt.identityId)
    outcome = { outcome: 'UNKNOWN' };
  const recorded = outcome;
  return withTenantDatabaseTransaction(database, tenantId, async (transaction) => {
    const [result] = await transaction.$queryRaw<{ state: string }[]>`
      SELECT dc_people_record_account_change(${tenantId}::uuid,${operationId}::uuid,${ownerId}::uuid,${attempt.fencingToken}::bigint,${attempt.payloadDigest},${attempt.identityId}::uuid,
        ${recorded.outcome},${recorded.outcome === 'UNKNOWN' ? null : recorded.receiptRef},${recorded.outcome === 'UNKNOWN' ? 'IDENTITY_OUTCOME_UNKNOWN' : recorded.reasonCode}) AS state`;
    return result.state;
  });
}
