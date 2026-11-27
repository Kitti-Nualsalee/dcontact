import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import type { AccountSecretBox } from './account-identity.js';
import type { LineChatClient } from './line-chat-client.js';
import { WebchatError, webchatUuid } from './webchat-errors.js';

/**
 * #1054: the LINE Official Account settings of a tenant (Console; the Supervisor reads, the Admin saves).
 *
 * - Round one has one channel per tenant. Until the first save the API answers the defaults with
 *   `revision: 0`.
 * - The channel secret and access token are sealed with the account secret key and bound to the tenant
 *   and channel; no answer ever carries them back, only whether they are set and their last characters.
 *   Leaving them out of a save keeps the stored ones.
 * - A new access token is checked with LINE before it is stored, which also tells which bot it belongs
 *   to (a webhook names that bot as `destination`). The call is made before the transaction.
 * - A channel can be enabled only with a queue, a secret and a token; the database checks the same rule.
 */

type Tx = Prisma.TransactionClient;
type Actor = { tenantId: string; userId: string };

export const LINE_MAX_AUTO_REPLY = 500;

export interface LineChannelSettings {
  enabled: boolean;
  queueId: string | null;
  lineChannelId: string;
  autoReplyText: string;
  idleTimeoutSec: number;
}

export interface LineChannelView extends LineChannelSettings {
  /** null until the first save */
  id: string | null;
  revision: number;
  hasChannelSecret: boolean;
  hasAccessToken: boolean;
  channelSecretHint: string | null;
  accessTokenHint: string | null;
  botName: string;
  credentialsVerifiedAt: string | null;
  /** the path LINE must call; the client puts its own public origin in front of it */
  webhookPath: string | null;
}

export const LINE_CHANNEL_DEFAULTS: LineChannelSettings = Object.freeze({
  enabled: false,
  queueId: null,
  lineChannelId: '',
  autoReplyText: '',
  idleTimeoutSec: 1800,
});

const invalid = (field: string) => new WebchatError('VALIDATION_FAILED', { field });

/** the context a sealed value is bound to: moved to another row or tenant it cannot be opened */
export function lineSealContext(tenantId: string, channelId: string, kind: 'secret' | 'token') {
  return `line-channel:v1:${tenantId}:${channelId}:${kind}`;
}

export const lineWebhookPath = (tenantId: string, channelId: string) =>
  `/api/v1/line/webhook/${tenantId}/${channelId}`;

const hint = (value: string) => value.slice(-4);

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') throw invalid(field);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  if (
    [...normalized].length > max ||
    // eslint-disable-next-line no-control-regex
    /[\u0000-\u0008\u000b-\u001f\u007f]/.test(normalized)
  )
    throw invalid(field);
  return normalized;
}

function integer(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max)
    throw invalid(field);
  return value;
}

const KEYS = [
  'expectedRevision',
  'enabled',
  'queueId',
  'lineChannelId',
  'channelSecret',
  'accessToken',
  'autoReplyText',
  'idleTimeoutSec',
];

export interface LineChannelInput {
  expectedRevision: number;
  settings: LineChannelSettings;
  /** undefined = keep the stored one */
  channelSecret?: string;
  accessToken?: string;
}

export function parseLineChannelInput(body: unknown): LineChannelInput {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new WebchatError('VALIDATION_FAILED');
  const input = body as Record<string, unknown>;
  const unknownKey = Object.keys(input).find((key) => !KEYS.includes(key));
  if (unknownKey) throw invalid(unknownKey);
  if (typeof input.enabled !== 'boolean') throw invalid('enabled');
  const queueId = input.queueId === null ? null : webchatUuid(input.queueId, 'VALIDATION_FAILED');
  const lineChannelId = text(input.lineChannelId ?? '', 'lineChannelId', 32);
  if (lineChannelId && !/^\d{6,20}$/.test(lineChannelId)) throw invalid('lineChannelId');
  const idleTimeoutSec = integer(input.idleTimeoutSec, 'idleTimeoutSec', 60, 86_400);
  if (idleTimeoutSec % 60 !== 0) throw invalid('idleTimeoutSec');
  let channelSecret: string | undefined;
  if (input.channelSecret !== undefined) {
    // LINE shows the channel secret as 32 hexadecimal characters
    if (
      typeof input.channelSecret !== 'string' ||
      !/^[0-9a-f]{32}$/i.test(input.channelSecret.trim())
    )
      throw invalid('channelSecret');
    channelSecret = input.channelSecret.trim();
  }
  let accessToken: string | undefined;
  if (input.accessToken !== undefined) {
    if (
      typeof input.accessToken !== 'string' ||
      !/^[A-Za-z0-9+/=._-]{20,512}$/.test(input.accessToken.trim())
    )
      throw invalid('accessToken');
    accessToken = input.accessToken.trim();
  }
  if (input.enabled && !queueId) throw invalid('queueId');
  return {
    expectedRevision: integer(input.expectedRevision, 'expectedRevision', 0, 2_147_483_647),
    settings: {
      enabled: input.enabled,
      queueId,
      lineChannelId,
      autoReplyText: text(input.autoReplyText ?? '', 'autoReplyText', LINE_MAX_AUTO_REPLY),
      idleTimeoutSec,
    },
    ...(channelSecret ? { channelSecret } : {}),
    ...(accessToken ? { accessToken } : {}),
  };
}

/** The role is read from the database on every request; the token alone is not trusted. */
async function roleOf(tx: Tx, actor: Actor): Promise<'ADMIN' | 'SUPERVISOR'> {
  const user = await tx.user.findFirst({
    where: { id: actor.userId, tenantId: actor.tenantId, isActive: true },
    select: { role: true },
  });
  if (user?.role !== 'ADMIN' && user?.role !== 'SUPERVISOR') throw new WebchatError('FORBIDDEN');
  return user.role;
}

type LineChannelRow = NonNullable<Awaited<ReturnType<Tx['lineChannel']['findFirst']>>>;

function view(tenantId: string, row: LineChannelRow | null): LineChannelView {
  if (!row)
    return {
      id: null,
      revision: 0,
      ...LINE_CHANNEL_DEFAULTS,
      hasChannelSecret: false,
      hasAccessToken: false,
      channelSecretHint: null,
      accessTokenHint: null,
      botName: '',
      credentialsVerifiedAt: null,
      webhookPath: null,
    };
  return {
    id: row.id,
    revision: row.revision,
    enabled: row.enabled,
    queueId: row.queueId,
    lineChannelId: row.lineChannelId,
    autoReplyText: row.autoReplyText,
    idleTimeoutSec: row.idleTimeoutSec,
    hasChannelSecret: row.channelSecretSealed !== null,
    hasAccessToken: row.accessTokenSealed !== null,
    channelSecretHint: row.channelSecretHint,
    accessTokenHint: row.accessTokenHint,
    botName: row.botName,
    credentialsVerifiedAt: row.credentialsVerifiedAt?.toISOString() ?? null,
    webhookPath: lineWebhookPath(tenantId, row.id),
  };
}

async function lastSaved(
  tx: Tx,
  tenantId: string,
  row: { updatedAt: Date; updatedByUserId: string | null } | null,
): Promise<{ at: string; byName: string | null } | null> {
  if (!row) return null;
  const user = row.updatedByUserId
    ? await tx.user.findFirst({
        where: { tenantId, id: row.updatedByUserId },
        select: { displayName: true },
      })
    : null;
  return { at: row.updatedAt.toISOString(), byName: user?.displayName ?? null };
}

async function queueOptions(tx: Tx, tenantId: string) {
  const queues = await tx.queue.findMany({
    where: { tenantId, isActive: true },
    select: { id: true, name: true, team: { select: { name: true } } },
    orderBy: [{ name: 'asc' }, { id: 'asc' }],
  });
  return queues.map((queue) => ({
    id: queue.id,
    name: queue.name,
    teamName: queue.team?.name ?? null,
  }));
}

export async function readLineChannel(database: PrismaClient, actor: Actor) {
  return withTenantDatabaseTransaction(database, actor.tenantId, async (tx) => {
    const role = await roleOf(tx, actor);
    const row = await tx.lineChannel.findFirst({ where: { tenantId: actor.tenantId } });
    return {
      tenantId: actor.tenantId,
      canEdit: role === 'ADMIN',
      channel: view(actor.tenantId, row),
      lastSaved: await lastSaved(tx, actor.tenantId, row),
      queues: await queueOptions(tx, actor.tenantId),
    };
  });
}

/** what the audit keeps of a channel: never a secret, only whether it is set and its hint */
function auditView(value: LineChannelView) {
  const { webhookPath: _path, ...rest } = value;
  return rest;
}

export async function saveLineChannel(
  database: PrismaClient,
  dependencies: { box: AccountSecretBox | null; client: LineChatClient },
  actor: Actor,
  body: unknown,
  correlationId: string,
) {
  const input = parseLineChannelInput(body);
  const { settings } = input;
  if ((input.channelSecret || input.accessToken) && !dependencies.box)
    throw new WebchatError('SECRET_STORE_UNAVAILABLE');
  // Check a new token with LINE first; nothing is held open while LINE answers.
  const bot = input.accessToken ? await dependencies.client.botInfo(input.accessToken) : undefined;
  if (bot === 'UNAVAILABLE') throw new WebchatError('LINE_UNAVAILABLE');
  if (bot === null) throw new WebchatError('LINE_TOKEN_REJECTED', { field: 'accessToken' });
  return withTenantDatabaseTransaction(database, actor.tenantId, async (tx) => {
    if ((await roleOf(tx, actor)) !== 'ADMIN') throw new WebchatError('FORBIDDEN');
    // One writer per tenant at a time, so two Admins saving together cannot both pass the revision check.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:line-channel:${actor.tenantId}`}, 0))`,
    );
    const current = await tx.lineChannel.findFirst({ where: { tenantId: actor.tenantId } });
    if ((current?.revision ?? 0) !== input.expectedRevision)
      throw new WebchatError('REVISION_CONFLICT');
    if (settings.queueId) {
      const queue = await tx.queue.findFirst({
        where: { tenantId: actor.tenantId, id: settings.queueId, isActive: true },
        select: { id: true },
      });
      if (!queue) throw invalid('queueId');
    }
    const channelId = current?.id ?? randomUUID();
    const box = dependencies.box;
    const secrets: Prisma.LineChannelUncheckedUpdateInput = {
      ...(input.channelSecret && box
        ? {
            channelSecretSealed: box.seal(
              input.channelSecret,
              lineSealContext(actor.tenantId, channelId, 'secret'),
            ),
            channelSecretHint: hint(input.channelSecret),
          }
        : {}),
      ...(input.accessToken && box && bot
        ? {
            accessTokenSealed: box.seal(
              input.accessToken,
              lineSealContext(actor.tenantId, channelId, 'token'),
            ),
            accessTokenHint: hint(input.accessToken),
            botUserId: bot.userId,
            botName: bot.displayName,
            credentialsVerifiedAt: new Date(),
          }
        : {}),
    };
    const hasSecret = Boolean(input.channelSecret || current?.channelSecretSealed);
    const hasToken = Boolean(input.accessToken || current?.accessTokenSealed);
    if (settings.enabled && !hasSecret) throw invalid('channelSecret');
    if (settings.enabled && !hasToken) throw invalid('accessToken');
    const before = current ? view(actor.tenantId, current) : null;
    const saved = current
      ? await tx.lineChannel.update({
          where: { tenantId_id: { tenantId: actor.tenantId, id: current.id } },
          data: {
            ...settings,
            ...secrets,
            revision: current.revision + 1,
            updatedByUserId: actor.userId,
            updatedAt: new Date(),
          },
        })
      : await tx.lineChannel.create({
          data: {
            ...(secrets as Omit<Prisma.LineChannelUncheckedCreateInput, 'tenantId'>),
            ...settings,
            tenantId: actor.tenantId,
            id: channelId,
            updatedByUserId: actor.userId,
          },
        });
    const after = view(actor.tenantId, saved);
    const compared = [
      ...(Object.keys(LINE_CHANNEL_DEFAULTS) as (keyof LineChannelSettings)[]),
      'channelSecretHint',
      'accessTokenHint',
    ] as const;
    const baseline = before ?? {
      ...LINE_CHANNEL_DEFAULTS,
      channelSecretHint: null,
      accessTokenHint: null,
    };
    const changedKeys = compared
      .filter((key) => JSON.stringify(baseline[key]) !== JSON.stringify(after[key]))
      .map((key) =>
        key === 'channelSecretHint'
          ? 'channelSecret'
          : key === 'accessTokenHint'
            ? 'accessToken'
            : key,
      )
      .sort();
    await tx.lineChannelAuditEvent.create({
      data: {
        tenantId: actor.tenantId,
        channelId: saved.id,
        actorUserId: actor.userId,
        action: current ? 'UPDATED' : 'CREATED',
        changedKeys,
        ...(before ? { before: auditView(before) as unknown as Prisma.InputJsonObject } : {}),
        after: auditView(after) as unknown as Prisma.InputJsonObject,
        correlationId,
      },
    });
    return {
      tenantId: actor.tenantId,
      canEdit: true,
      channel: after,
      lastSaved: await lastSaved(tx, actor.tenantId, saved),
      queues: await queueOptions(tx, actor.tenantId),
    };
  });
}
