import { Prisma, withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  catalogActor,
  digest,
  voiceFail,
  voiceUuid,
  type VoiceActor,
} from './tenant-voice-catalog.js';

interface DirectoryRow {
  id: string;
  displayName: string;
  email: string;
  role: string;
  extension: string | null;
  teamId: string | null;
  teamName: string | null;
  isActive: boolean;
  configRevision: number;
  createdAt: Date;
  accountState: string;
  provisioningState: string;
  activationState: string;
  deliveryState: string;
  invitationGeneration: number | null;
  statusRevision: number | null;
  operationId: string | null;
  commandId: string | null;
}

function projection(row: DirectoryRow) {
  return {
    id: row.id,
    displayName: row.displayName,
    email: row.email,
    username: row.email,
    role: row.role,
    extensionRef: row.extension,
    teamId: row.teamId,
    team: row.teamId ? { id: row.teamId, name: row.teamName } : null,
    isActive: row.isActive,
    createdAt: row.createdAt.toISOString(),
    configRevision: row.configRevision,
    accountState: row.accountState,
    provisioningState: row.provisioningState,
    activationState: row.activationState,
    deliveryState: row.deliveryState,
    invitationGeneration: row.invitationGeneration,
    invitationExpiresAt: null,
    statusRevision: row.statusRevision,
    operationId: row.operationId,
    commandId: row.commandId,
  };
}

export function readPeopleDirectory(
  database: PrismaClient,
  identity: VoiceActor,
  query: Record<string, unknown>,
  userId?: string,
) {
  return withTenantDatabaseTransaction(database, identity.tenantId, async (transaction) => {
    const actor = await catalogActor(transaction, identity, true);
    if (
      Object.keys(query).some(
        (key) => !['limit', 'cursor', 'teamId', 'role', 'state'].includes(key),
      )
    )
      voiceFail('VALIDATION_FAILED', 400);
    const rawLimit = query.limit ?? '20';
    const limit =
      typeof rawLimit === 'string' && /^[0-9]+$/.test(rawLimit) ? Number(rawLimit) : NaN;
    if (!Number.isSafeInteger(limit) || limit < 20 || limit > 100) voiceFail('INVALID_LIMIT', 400);
    const teamId = query.teamId === undefined ? null : voiceUuid(query.teamId, 'teamId');
    const role = query.role ?? null;
    if (role !== null && !['AGENT', 'SUPERVISOR', 'ADMIN'].includes(String(role)))
      voiceFail('VALIDATION_FAILED', 400, { field: 'role' });
    if (role !== null && typeof role !== 'string')
      voiceFail('VALIDATION_FAILED', 400, { field: 'role' });
    const state = query.state ?? null;
    if (
      state !== null &&
      (typeof state !== 'string' ||
        ![
          'UNKNOWN',
          'PROVISIONING',
          'PENDING_ACTIVATION',
          'ACTIVE',
          'DISABLING',
          'DISABLED',
          'ATTENTION_REQUIRED',
        ].includes(state))
    )
      voiceFail('VALIDATION_FAILED', 400, { field: 'state' });
    const id = userId === undefined ? null : voiceUuid(userId, 'id');
    const filterDigest = digest(['tenant-people-users', teamId, role, state]);
    let after: { at: Date; id: string } | undefined;
    if (query.cursor !== undefined) {
      try {
        if (
          typeof query.cursor !== 'string' ||
          query.cursor.length > 2048 ||
          !/^[A-Za-z0-9_-]+$/.test(query.cursor)
        )
          throw Error();
        const cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (
          !cursor ||
          cursor.v !== 1 ||
          cursor.tenantId !== identity.tenantId ||
          cursor.actorId !== identity.userId ||
          cursor.scopeStamp !== actor.scopeStamp ||
          cursor.filterDigest !== filterDigest ||
          typeof cursor.at !== 'string' ||
          new Date(cursor.at).toISOString() !== cursor.at
        )
          throw Error();
        after = { at: new Date(cursor.at), id: voiceUuid(cursor.id, 'cursor') };
      } catch {
        voiceFail('INVALID_CURSOR', 400);
      }
    }
    const rows = await transaction.$queryRaw<DirectoryRow[]>(Prisma.sql`
      WITH directory AS (
        SELECT u.id,u.display_name AS "displayName",u.email,u.role::text AS role,u.extension,
          u.team_id AS "teamId",t.name AS "teamName",u.is_active AS "isActive",u.created_at AS "createdAt",u.config_revision AS "configRevision",
          COALESCE(l.account_state,'UNKNOWN') AS "accountState",
          COALESCE(l.provisioning_state,'UNKNOWN') AS "provisioningState",
          COALESCE(l.activation_state,'UNKNOWN') AS "activationState",l.revision AS "statusRevision",o.id AS "operationId",o.command_id AS "commandId",
          COALESCE(i.delivery_state,CASE WHEN o.id IS NULL THEN 'UNKNOWN' ELSE 'NOT_STARTED' END) AS "deliveryState",
          i.generation AS "invitationGeneration"
        FROM users u
        LEFT JOIN teams t ON t.tenant_id=u.tenant_id AND t.id=u.team_id
        LEFT JOIN tenant_user_lifecycles l ON l.tenant_id=u.tenant_id AND l.user_id=u.id
        LEFT JOIN tenant_people_operations o ON o.tenant_id=l.tenant_id AND o.id=l.operation_id AND o.target_user_id=u.id
        LEFT JOIN LATERAL (
          SELECT delivery_state,generation FROM tenant_people_invitation_intents
          WHERE tenant_id=u.tenant_id AND user_id=u.id ORDER BY generation DESC LIMIT 1
        ) i ON true
        WHERE u.tenant_id=${identity.tenantId}::uuid AND u.role::text IN ('AGENT','SUPERVISOR','ADMIN')
          AND (o.id IS NOT NULL OR EXISTS (
            SELECT 1 FROM tenant_voice_identity_bindings b WHERE b.tenant_id=u.tenant_id AND b.user_id=u.id
              AND b.subject_id=u.keycloak_id::text AND b.identity_class='TENANT_USER' AND b.is_active
              AND b.issuer=${identity.caller!.issuer} AND b.client_id=${identity.caller!.clientId}
              AND b.tenant_slug=${identity.caller!.tenantSlug}
          ))
      ) SELECT * FROM directory WHERE true
        ${id ? Prisma.sql`AND id=${id}::uuid` : Prisma.empty}
        ${teamId ? Prisma.sql`AND "teamId"=${teamId}::uuid` : Prisma.empty}
        ${role ? Prisma.sql`AND role=${role}` : Prisma.empty}
        ${state ? Prisma.sql`AND "accountState"=${state}` : Prisma.empty}
        ${after ? Prisma.sql`AND ("createdAt",id)>(${after.at},${after.id}::uuid)` : Prisma.empty}
        ORDER BY "createdAt",id LIMIT ${id ? 1 : limit + 1}`);
    if (id) {
      if (!rows[0]) voiceFail('RESOURCE_NOT_FOUND', 404);
      return projection(rows[0]);
    }
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map(projection),
      nextCursor:
        rows.length > limit && last
          ? Buffer.from(
              JSON.stringify({
                v: 1,
                tenantId: identity.tenantId,
                actorId: identity.userId,
                scopeStamp: actor.scopeStamp,
                filterDigest,
                at: last.createdAt.toISOString(),
                id: last.id,
              }),
            ).toString('base64url')
          : null,
    };
  });
}
