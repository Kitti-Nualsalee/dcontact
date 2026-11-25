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
  invitationExpiresAt: Date | null;
  statusRevision: number | null;
  operationId: string | null;
  commandId: string | null;
  disableOperationId: string | null;
  disableCommandId: string | null;
  accountChangeOperationId: string | null;
  accountChangeCommandId: string | null;
  accountChangeKind: string | null;
  accountChangeState: string | null;
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
    invitationExpiresAt: row.invitationExpiresAt?.toISOString() ?? null,
    statusRevision: row.statusRevision,
    operationId: row.operationId,
    commandId: row.commandId,
    disableOperationId: row.disableOperationId,
    disableCommandId: row.disableCommandId,
    // #998 1B/2: the latest rename/re-enable command so the Console can recover the result after a reload
    accountChange: row.accountChangeOperationId
      ? {
          operationId: row.accountChangeOperationId,
          commandId: row.accountChangeCommandId,
          kind: row.accountChangeKind,
          state: row.accountChangeState,
        }
      : null,
  };
}

/**
 * the single status the Console shows per account (the same order as `accountStatus()` in the Console — the first match wins)
 * search filters by this value so results match the chip the user sees; GET `state` still filters by the raw accountState as before
 */
export const DISPLAY_STATUSES = [
  'ATTENTION_REQUIRED',
  'REJECTED',
  'DISABLED',
  'DISABLING',
  'PROVISIONING',
  'ACTIVE',
  'PENDING_ACTIVATION',
  'UNKNOWN',
] as const;
const DISPLAY_STATUS_SQL = Prisma.sql`(CASE
  WHEN "accountState"='ATTENTION_REQUIRED' THEN 'ATTENTION_REQUIRED'
  WHEN "provisioningState"='REJECTED' THEN 'REJECTED'
  WHEN "accountState"='DISABLED' THEN 'DISABLED'
  WHEN "accountState"='DISABLING' THEN 'DISABLING'
  WHEN "accountState"='PROVISIONING' OR "provisioningState"='PENDING' THEN 'PROVISIONING'
  WHEN "accountState"='ACTIVE' AND "activationState"='ACTIVATED' AND "isActive" THEN 'ACTIVE'
  WHEN "accountState"='PENDING_ACTIVATION' AND "provisioningState"='PROVISIONED'
    AND "activationState"='PENDING' THEN 'PENDING_ACTIVATION'
  ELSE 'UNKNOWN' END)`;

/** converts LIKE wildcards in the query to ordinary characters */
function likePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, (character) => `\\${character}`).toLowerCase()}%`;
}

/**
 * the query `q` is accepted only in the body of POST search so names or emails are not in the URL/access log
 * a value that passes must be text of 1–100 characters after trim with no control characters
 */
function searchText(value: unknown) {
  if (value === undefined) return null;
  if (typeof value !== 'string') voiceFail('VALIDATION_FAILED', 400, { field: 'q' });
  const text = value.trim().normalize('NFC');
  const length = [...text].length;
  if (length === 0) return null;
  if (length > 100 || /\p{Cc}/u.test(text)) voiceFail('VALIDATION_FAILED', 400, { field: 'q' });
  return text;
}

/** POST /people/users/search: the same filters as GET list plus the query `q` in the body */
export function searchPeopleDirectory(database: PrismaClient, identity: VoiceActor, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) voiceFail('VALIDATION_FAILED', 400);
  const input: Record<string, unknown> = { ...body };
  if (typeof input.limit === 'number') input.limit = String(input.limit);
  if (input.cursor === null) delete input.cursor;
  return readPeopleDirectory(database, identity, input, undefined, true);
}

export function readPeopleDirectory(
  database: PrismaClient,
  identity: VoiceActor,
  query: Record<string, unknown>,
  userId?: string,
  searchable = false,
) {
  return withTenantDatabaseTransaction(database, identity.tenantId, async (transaction) => {
    const actor = await catalogActor(transaction, identity, true);
    if (
      Object.keys(query).some(
        (key) =>
          ![
            'limit',
            'cursor',
            'teamId',
            'role',
            'state',
            ...(searchable ? ['q', 'status'] : []),
          ].includes(key),
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
    const q = searchable ? searchText(query.q) : null;
    const status = searchable ? (query.status ?? null) : null;
    if (
      status !== null &&
      (typeof status !== 'string' || !(DISPLAY_STATUSES as readonly string[]).includes(status))
    )
      voiceFail('VALIDATION_FAILED', 400, { field: 'status' });
    const filterDigest = digest(['tenant-people-users', teamId, role, state, q, status]);
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
          CASE WHEN change.kind='ENABLE_ACCOUNT' AND change.state='ACTION_REQUIRED' THEN 'ATTENTION_REQUIRED'
            WHEN disable.state='SUCCEEDED' AND NOT u.is_active THEN 'DISABLED' WHEN disable.state='ACTION_REQUIRED' THEN 'ATTENTION_REQUIRED'
            WHEN disable.state IN ('QUEUED','WAITING_EXTERNAL') THEN 'DISABLING' ELSE COALESCE(l.account_state,'UNKNOWN') END AS "accountState",
          disable.id AS "disableOperationId",disable.command_id AS "disableCommandId",
          change.id AS "accountChangeOperationId",change.command_id AS "accountChangeCommandId",change.kind AS "accountChangeKind",change.state AS "accountChangeState",
          COALESCE(l.provisioning_state,'UNKNOWN') AS "provisioningState",
          COALESCE(l.activation_state,'UNKNOWN') AS "activationState",l.revision AS "statusRevision",o.id AS "operationId",o.command_id AS "commandId",
          COALESCE(i.delivery_state,CASE WHEN o.id IS NULL THEN 'UNKNOWN' ELSE 'NOT_STARTED' END) AS "deliveryState",
          i.generation AS "invitationGeneration",i.expires_at AS "invitationExpiresAt"
        FROM users u
        LEFT JOIN teams t ON t.tenant_id=u.tenant_id AND t.id=u.team_id
        LEFT JOIN tenant_user_lifecycles l ON l.tenant_id=u.tenant_id AND l.user_id=u.id
        LEFT JOIN tenant_people_operations o ON o.tenant_id=l.tenant_id AND o.id=l.operation_id AND o.target_user_id=u.id
        LEFT JOIN LATERAL (
          SELECT id,command_id,state FROM tenant_people_disables d WHERE d.tenant_id=u.tenant_id AND d.user_id=u.id
          ORDER BY d.created_at DESC,d.id DESC LIMIT 1
        ) disable ON true
        LEFT JOIN LATERAL (
          SELECT id,command_id,kind,state FROM tenant_people_account_changes c WHERE c.tenant_id=u.tenant_id AND c.user_id=u.id
          ORDER BY c.created_at DESC,c.id DESC LIMIT 1
        ) change ON true
        LEFT JOIN LATERAL (
          SELECT CASE WHEN r.outcome='SENT' AND to_timestamp(r.expires_at_epoch)<=clock_timestamp() THEN 'EXPIRED'
            WHEN r.outcome IS NOT NULL THEN r.outcome WHEN a.provider_attempt_ref IS NOT NULL THEN 'AMBIGUOUS'
            WHEN d.provider_attempt_ref IS NOT NULL THEN 'DISPATCHING' ELSE intent.delivery_state END AS delivery_state,
            intent.generation,to_timestamp(r.expires_at_epoch) AS expires_at FROM tenant_people_invitation_intents intent
          LEFT JOIN tenant_people_invitation_dispatches d ON d.tenant_id=intent.tenant_id AND d.provider_attempt_ref=intent.provider_attempt_ref
          LEFT JOIN tenant_people_invitation_ambiguities a ON a.tenant_id=intent.tenant_id AND a.provider_attempt_ref=intent.provider_attempt_ref
          LEFT JOIN tenant_people_invitation_receipts r ON r.tenant_id=intent.tenant_id AND r.provider_attempt_ref=intent.provider_attempt_ref
          WHERE intent.tenant_id=u.tenant_id AND intent.user_id=u.id ORDER BY intent.generation DESC LIMIT 1
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
        ${status ? Prisma.sql`AND ${DISPLAY_STATUS_SQL}=${status}` : Prisma.empty}
        ${
          q
            ? Prisma.sql`AND (lower("displayName") LIKE ${likePattern(q)} ESCAPE '\\'
                OR lower(email) LIKE ${likePattern(q)} ESCAPE '\\'
                OR lower(COALESCE(extension,'')) LIKE ${likePattern(q)} ESCAPE '\\')`
            : Prisma.empty
        }
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
