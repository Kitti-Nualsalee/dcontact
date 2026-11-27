import { Prisma, type PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import { WebchatError, webchatUuid } from './webchat-errors.js';

/**
 * #1044: the web chat widget settings of a tenant (Console, Admin only).
 *
 * - Round one has one widget per tenant. Until the Admin saves it the API answers the defaults with
 *   `revision: 0`, and the first save creates the row.
 * - A widget can be enabled only with a queue and at least one allowed origin; the database checks the
 *   same rule, so an enabled widget is never left unable to take work.
 * - Every save is compared with `expectedRevision` and recorded in the audit with the changed keys.
 */

type Tx = Prisma.TransactionClient;
type Actor = { tenantId: string; userId: string };

export const WEBCHAT_MAX_ORIGINS = 10;
export const WEBCHAT_MAX_GREETING = 500;

export interface WebchatWidgetSettings {
  enabled: boolean;
  queueId: string | null;
  allowedOrigins: string[];
  greetingTh: string;
  greetingEn: string;
  maxChatsPerAgent: number;
  idleTimeoutSec: number;
}

export interface WebchatWidgetView extends WebchatWidgetSettings {
  /** null until the first save */
  id: string | null;
  revision: number;
}

export const WEBCHAT_WIDGET_DEFAULTS: WebchatWidgetSettings = Object.freeze({
  enabled: false,
  queueId: null,
  allowedOrigins: [] as string[],
  greetingTh: '',
  greetingEn: '',
  maxChatsPerAgent: 3,
  idleTimeoutSec: 600,
});

const invalid = (field: string) => new WebchatError('VALIDATION_FAILED', { field });

/**
 * An origin exactly as a browser sends it: scheme, host and a non-default port. https only, except
 * http for a loopback host so a developer can try the widget on their own machine.
 */
export function normalizeWebchatOrigin(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255) throw invalid('allowedOrigins');
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw invalid('allowedOrigins');
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  // The origin goes into `Content-Security-Policy: frame-ancestors`, so it must be one exact host:
  // no wildcard and nothing a CSP parser would read as another source or directive.
  if (
    !loopback &&
    !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(url.hostname)
  )
    throw invalid('allowedOrigins');
  if (
    (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) ||
    url.username ||
    url.password ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search ||
    url.hash ||
    !url.hostname
  )
    throw invalid('allowedOrigins');
  return url.origin;
}

function text(value: unknown, field: string): string {
  if (typeof value !== 'string') throw invalid(field);
  const normalized = value.replace(/\r\n?/g, '\n').trim();
  // eslint-disable-next-line no-control-regex
  if (
    [...normalized].length > WEBCHAT_MAX_GREETING ||
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
  'allowedOrigins',
  'greetingTh',
  'greetingEn',
  'maxChatsPerAgent',
  'idleTimeoutSec',
];

export function parseWebchatWidgetInput(body: unknown): {
  expectedRevision: number;
  settings: WebchatWidgetSettings;
} {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new WebchatError('VALIDATION_FAILED');
  const input = body as Record<string, unknown>;
  const unknownKey = Object.keys(input).find((key) => !KEYS.includes(key));
  if (unknownKey) throw invalid(unknownKey);
  if (typeof input.enabled !== 'boolean') throw invalid('enabled');
  if (!Array.isArray(input.allowedOrigins) || input.allowedOrigins.length > WEBCHAT_MAX_ORIGINS)
    throw invalid('allowedOrigins');
  const allowedOrigins = [...new Set(input.allowedOrigins.map(normalizeWebchatOrigin))];
  const queueId = input.queueId === null ? null : webchatUuid(input.queueId, 'VALIDATION_FAILED');
  const idleTimeoutSec = integer(input.idleTimeoutSec, 'idleTimeoutSec', 60, 3600);
  if (idleTimeoutSec % 60 !== 0) throw invalid('idleTimeoutSec');
  const settings: WebchatWidgetSettings = {
    enabled: input.enabled,
    queueId,
    allowedOrigins,
    greetingTh: text(input.greetingTh, 'greetingTh'),
    greetingEn: text(input.greetingEn, 'greetingEn'),
    maxChatsPerAgent: integer(input.maxChatsPerAgent, 'maxChatsPerAgent', 1, 10),
    idleTimeoutSec,
  };
  if (settings.enabled && !settings.queueId) throw invalid('queueId');
  if (settings.enabled && settings.allowedOrigins.length === 0) throw invalid('allowedOrigins');
  return {
    expectedRevision: integer(input.expectedRevision, 'expectedRevision', 0, 2_147_483_647),
    settings,
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

async function requireAdmin(tx: Tx, actor: Actor) {
  if ((await roleOf(tx, actor)) !== 'ADMIN') throw new WebchatError('FORBIDDEN');
}

function view(row: (WebchatWidgetSettings & { id: string; revision: number }) | null) {
  if (!row) return { id: null, revision: 0, ...WEBCHAT_WIDGET_DEFAULTS, allowedOrigins: [] };
  return {
    id: row.id,
    revision: row.revision,
    enabled: row.enabled,
    queueId: row.queueId,
    allowedOrigins: [...row.allowedOrigins],
    greetingTh: row.greetingTh,
    greetingEn: row.greetingEn,
    maxChatsPerAgent: row.maxChatsPerAgent,
    idleTimeoutSec: row.idleTimeoutSec,
  } satisfies WebchatWidgetView;
}

/** When the settings were last saved and by whom; null until the first save. */
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

export async function readWebchatWidget(database: PrismaClient, actor: Actor) {
  return withTenantDatabaseTransaction(database, actor.tenantId, async (tx) => {
    // the Supervisor reads the settings; only the Admin saves them
    const role = await roleOf(tx, actor);
    const row = await tx.webchatWidget.findFirst({ where: { tenantId: actor.tenantId } });
    return {
      tenantId: actor.tenantId,
      canEdit: role === 'ADMIN',
      widget: view(row),
      lastSaved: await lastSaved(tx, actor.tenantId, row),
      queues: await queueOptions(tx, actor.tenantId),
    };
  });
}

export async function saveWebchatWidget(
  database: PrismaClient,
  actor: Actor,
  body: unknown,
  correlationId: string,
) {
  const { expectedRevision, settings } = parseWebchatWidgetInput(body);
  return withTenantDatabaseTransaction(database, actor.tenantId, async (tx) => {
    await requireAdmin(tx, actor);
    // One writer per tenant at a time, so two Admins saving together cannot both pass the revision check.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`dc:v1:webchat-widget:${actor.tenantId}`}, 0))`,
    );
    const current = await tx.webchatWidget.findFirst({ where: { tenantId: actor.tenantId } });
    if ((current?.revision ?? 0) !== expectedRevision) throw new WebchatError('REVISION_CONFLICT');
    if (settings.queueId) {
      const queue = await tx.queue.findFirst({
        where: { tenantId: actor.tenantId, id: settings.queueId, isActive: true },
        select: { id: true },
      });
      if (!queue) throw invalid('queueId');
    }
    const before = current ? view(current) : null;
    const saved = current
      ? await tx.webchatWidget.update({
          where: { tenantId_id: { tenantId: actor.tenantId, id: current.id } },
          data: {
            ...settings,
            revision: current.revision + 1,
            updatedByUserId: actor.userId,
            updatedAt: new Date(),
          },
        })
      : await tx.webchatWidget.create({
          data: { tenantId: actor.tenantId, ...settings, updatedByUserId: actor.userId },
        });
    const after = view(saved);
    const changedKeys = (Object.keys(WEBCHAT_WIDGET_DEFAULTS) as (keyof WebchatWidgetSettings)[])
      // a new widget is compared with the defaults, so the audit names what the Admin actually set
      .filter(
        (key) =>
          JSON.stringify((before ?? WEBCHAT_WIDGET_DEFAULTS)[key]) !== JSON.stringify(after[key]),
      )
      .sort();
    await tx.webchatWidgetAuditEvent.create({
      data: {
        tenantId: actor.tenantId,
        widgetId: saved.id,
        actorUserId: actor.userId,
        action: current ? 'UPDATED' : 'CREATED',
        changedKeys,
        ...(before ? { before: before as unknown as Prisma.InputJsonObject } : {}),
        after: after as unknown as Prisma.InputJsonObject,
        correlationId,
      },
    });
    return {
      tenantId: actor.tenantId,
      canEdit: true,
      widget: after,
      lastSaved: await lastSaved(tx, actor.tenantId, saved),
      queues: await queueOptions(tx, actor.tenantId),
    };
  });
}
