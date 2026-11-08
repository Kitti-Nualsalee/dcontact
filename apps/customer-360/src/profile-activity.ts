import { Prisma } from '@d-contact/db';
import {
  c360DeferredContactSql,
  c360ReadableContactSql,
  type C360VerifiedActor,
} from './profile-authorization.js';
import {
  C360ReadError,
  c360FilterDigest,
  c360ScopeDigest,
  type C360CursorCodec,
} from './profile-read.js';
import { c360Uuid } from './profile-command.js';

const DAY = 86_400_000;
const OPERATIONS = {
  CONTACT_CREATE: 'CONTACT_CREATED',
  CONTACT_UPDATE: 'PROFILE_UPDATED',
  CONTACT_POINT_ADD: 'PROFILE_UPDATED',
  CONTACT_POINT_RETIRE: 'PROFILE_UPDATED',
  CONTACT_POINT_REPLACE: 'PROFILE_UPDATED',
  TAG_CREATE: 'TAG_CREATED',
  TAG_RENAME: 'TAG_RENAMED',
  TAG_RETIRE: 'TAG_RETIRED',
  TAG_ATTACH: 'TAG_ATTACHED',
  TAG_DETACH: 'TAG_DETACHED',
} as const;
type OwnerOperation = keyof typeof OPERATIONS;
export type C360ActivityType = (typeof OPERATIONS)[OwnerOperation];
const TYPES = [...new Set(Object.values(OPERATIONS))];
const PUBLIC_FIELDS: Readonly<Record<C360ActivityType, readonly string[]>> = {
  CONTACT_CREATED: ['displayName', 'company', 'vip', 'points'],
  PROFILE_UPDATED: ['displayName', 'company', 'vip', 'contactPoints'],
  TAG_CREATED: ['name', 'state'],
  TAG_RENAMED: ['name'],
  TAG_RETIRED: ['state'],
  TAG_ATTACHED: ['tags'],
  TAG_DETACHED: ['tags'],
};
const CATALOG_OPERATIONS = ['TAG_CREATE', 'TAG_RENAME', 'TAG_RETIRE'];
const invalid = (code = 'INVALID_REQUEST') => new C360ReadError(400, code);

function utc(value: unknown): string {
  if (typeof value !== 'string') throw invalid();
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}:\d{2})$/.exec(
    value,
  );
  if (!match) throw invalid();
  const [, wall, fraction = '', offset] = match;
  const wallClock = new Date(`${wall}Z`);
  if (!Number.isFinite(+wallClock) || wallClock.toISOString().slice(0, 19) !== wall)
    throw invalid();
  const date = new Date(`${wall}.${fraction.padEnd(3, '0').slice(0, 3)}${offset}`);
  if (!Number.isFinite(+date) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999)
    throw invalid();
  return `${date.toISOString().slice(0, -1)}${fraction.padEnd(6, '0').slice(3)}Z`;
}

type Window = { from: string; to: string };
type CoverageInterval = Window & {
  types: C360ActivityType[];
  sourceVersion: string;
  evidenceRef: string;
};
type CoverageGap = Window & {
  types: C360ActivityType[];
  reasonCode: 'NO_EVIDENCE' | 'UNMAPPED_EVENT';
};
export type C360ActivityCoverage = {
  status: 'KNOWN' | 'PARTIAL' | 'UNKNOWN';
  intervals: CoverageInterval[];
  gaps: CoverageGap[];
};
export type C360ActivityEvidence = ReadonlyMap<string, readonly CoverageInterval[]>;

/** โหลด evidence ที่ผู้ดูแลส่งมากับ release ตอนเริ่มระบบเท่านั้น ไม่รับค่าจาก request */
export function parseC360ActivityEvidence(raw: string | undefined): C360ActivityEvidence {
  const evidence = new Map<string, CoverageInterval[]>();
  if (!raw) return evidence;
  try {
    const manifest = JSON.parse(raw) as { version: unknown; entries: unknown };
    if (
      manifest.version !== 'c360-activity-v1' ||
      !Array.isArray(manifest.entries) ||
      manifest.entries.length > 256
    )
      throw invalid();
    for (const entry of manifest.entries) {
      const tenantId = c360Uuid(entry.tenantId);
      const from = utc(entry.from);
      const to = utc(entry.to);
      const types = entry.types as C360ActivityType[];
      if (
        from >= to ||
        !Array.isArray(types) ||
        !types.length ||
        types.some((type) => !TYPES.includes(type)) ||
        typeof entry.evidenceRef !== 'string' ||
        !/^ev_[a-zA-Z0-9_-]{6,96}$/.test(entry.evidenceRef) ||
        typeof entry.sourceVersion !== 'string' ||
        !/^[a-zA-Z0-9_.-]{1,96}$/.test(entry.sourceVersion)
      )
        throw invalid();
      const intervals = evidence.get(tenantId) ?? [];
      intervals.push({
        from,
        to,
        types: [...new Set(types)],
        evidenceRef: entry.evidenceRef,
        sourceVersion: entry.sourceVersion,
      });
      evidence.set(tenantId, intervals);
    }
  } catch {
    // ไม่เผยค่าที่ผิดรูปและไม่รับรอง coverage จาก manifest ที่ตรวจไม่ได้
    return new Map();
  }
  return evidence;
}

export function c360ActivityCoverage(
  window: Window,
  types: C360ActivityType[],
  evidence: readonly CoverageInterval[],
  unmapped: boolean,
): C360ActivityCoverage {
  if (unmapped)
    return {
      status: 'UNKNOWN',
      intervals: [],
      gaps: [{ ...window, types, reasonCode: 'UNMAPPED_EVENT' }],
    };
  const intervals = evidence
    .flatMap((interval) => {
      const from = interval.from > window.from ? interval.from : window.from;
      const to = interval.to < window.to ? interval.to : window.to;
      const coveredTypes = interval.types.filter((type) => types.includes(type));
      return from < to && coveredTypes.length
        ? [{ ...interval, from, to, types: coveredTypes }]
        : [];
    })
    .sort((a, b) => a.from.localeCompare(b.from));
  const gaps: CoverageGap[] = [];
  for (const type of types) {
    let at = window.from;
    for (const interval of intervals.filter((entry) => entry.types.includes(type))) {
      if (interval.from > at)
        gaps.push({ from: at, to: interval.from, types: [type], reasonCode: 'NO_EVIDENCE' });
      if (interval.to > at) at = interval.to;
    }
    if (at < window.to)
      gaps.push({ from: at, to: window.to, types: [type], reasonCode: 'NO_EVIDENCE' });
  }
  return {
    status: !intervals.length ? 'UNKNOWN' : gaps.length ? 'PARTIAL' : 'KNOWN',
    intervals,
    gaps,
  };
}

type AuditRow = {
  id: string;
  operation: OwnerOperation;
  resource_type: 'CONTACT' | 'TAG';
  resource_id: string;
  changed_fields: string[];
  occurred_at: string;
};

export async function readC360Activity(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  actorIdentityKey: string,
  query: Record<string, unknown>,
  codec: C360CursorCodec,
  evidence: C360ActivityEvidence,
  now: Date,
) {
  if (actor.role !== 'ADMIN') throw new C360ReadError(403, 'CUSTOMER_ACCESS_DENIED');
  if (Object.keys(query).some((key) => !['type', 'limit', 'from', 'to', 'cursor'].includes(key)))
    throw invalid();
  const { type = 'ALL', limit = '50', from, to, cursor } = query;
  if (
    (type !== 'ALL' && !TYPES.includes(type as C360ActivityType)) ||
    typeof limit !== 'string' ||
    !/^(?:[1-9]|[1-9]\d|100)$/.test(limit) ||
    (from === undefined) !== (to === undefined) ||
    (cursor !== undefined && (typeof cursor !== 'string' || !cursor))
  )
    throw invalid();
  const asOf = utc(now.toISOString());
  const explicit = from !== undefined ? { from: utc(from), to: utc(to) } : null;
  const window = explicit ?? { from: utc(new Date(+now - 30 * DAY).toISOString()), to: asOf };
  const duration = Date.parse(window.to) - Date.parse(window.from);
  if (
    window.from >= window.to ||
    window.to > asOf ||
    duration > 90 * DAY ||
    (duration === 90 * DAY && window.to.slice(23, 26) > window.from.slice(23, 26))
  )
    throw invalid();

  const readable = c360ReadableContactSql(actor);
  const context = {
    kind: 'activity-v1',
    tenantId: actor.tenantId,
    userId: actorIdentityKey,
    filter: c360FilterDigest([
      String(type),
      limit,
      explicit?.from ?? 'default',
      explicit?.to ?? 'default',
    ]),
    scope: c360ScopeDigest(actor),
  };
  // Cursor เก็บ fingerprint ของ VIEW เพื่อให้ตรวจ scope หลังประเมิน DEFER ในช่วงที่ cursor ตรึงไว้
  const viewFingerprint = async () => {
    const [scope] = await tx.$queryRaw<{ fingerprint: string }[]>(Prisma.sql`
      SELECT concat(count(*), ':',
        coalesce(bit_xor(('x' || substr(md5(c.id::text), 1, 16))::bit(64)::bigint), 0), ':',
        coalesce(bit_xor(('x' || substr(md5(c.id::text), 17, 16))::bit(64)::bigint), 0)
      ) AS fingerprint FROM contacts c WHERE ${readable}`);
    return c360FilterDigest([scope!.fingerprint]);
  };
  let previousView: string | undefined;
  let after = Prisma.empty;
  if (typeof cursor === 'string') {
    let position: readonly string[];
    try {
      position = codec.open(cursor, context, { distinguishScopeChange: true });
    } catch (error) {
      if (error instanceof C360ReadError)
        throw new C360ReadError(
          error.code === 'CURSOR_INVALID' ? 400 : 409,
          error.code === 'CURSOR_INVALID' ? 'INVALID_CURSOR' : error.code,
        );
      throw error;
    }
    if (position.length !== 5 || !/^[a-f0-9]{64}$/.test(position[4] ?? ''))
      throw invalid('INVALID_CURSOR');
    previousView = position[4];
    try {
      const [start, end, timestamp, id] = position as [string, string, string, string];
      window.from = utc(start);
      window.to = utc(end);
      after = Prisma.sql`AND (a.created_at, a.id) < (${utc(timestamp)}::timestamptz, ${c360Uuid(id)}::uuid)`;
    } catch {
      throw invalid('INVALID_CURSOR');
    }
  }
  const operations = Object.entries(OPERATIONS)
    .filter(([, label]) => type === 'ALL' || type === label)
    .map(([operation]) => operation);
  const catalog = Prisma.sql`a.resource_type = 'TAG' AND EXISTS (
    SELECT 1 FROM c360_tags t WHERE t.tenant_id = a.tenant_id AND t.id = a.resource_id)`;
  const contact = Prisma.sql`a.resource_type = 'CONTACT' AND EXISTS (
    SELECT 1 FROM contacts c WHERE c.tenant_id = a.tenant_id AND c.id = a.resource_id AND ${readable})`;
  const eligible = Prisma.sql`a.tenant_id = ${actor.tenantId}::uuid AND
    a.created_at >= ${window.from}::timestamptz AND a.created_at < ${window.to}::timestamptz`;
  const mapped = Prisma.sql`a.operation IN (${Prisma.join(operations)}) AND
    ((a.resource_type = 'TAG' AND a.operation IN (${Prisma.join(CATALOG_OPERATIONS)})) OR
     (a.resource_type = 'CONTACT' AND a.operation NOT IN (${Prisma.join(CATALOG_OPERATIONS)})))`;
  const [status] = await tx.$queryRaw<{ deferred: boolean; unmapped: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM c360_profile_audits a JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.resource_id
      WHERE ${eligible} AND ${mapped} AND a.resource_type = 'CONTACT' AND ${c360DeferredContactSql(actor)}
    ) AS deferred, EXISTS (
      SELECT 1 FROM c360_profile_audits a WHERE ${eligible} AND (${catalog} OR ${contact})
        AND NOT (a.operation IN (${Prisma.join(Object.keys(OPERATIONS))}) AND
          (a.resource_type = 'TAG') = (a.operation IN (${Prisma.join(CATALOG_OPERATIONS)})))
    ) AS unmapped`);
  if (status?.deferred) throw new C360ReadError(503, 'SCOPE_UNAVAILABLE', true);
  const currentView = previousView ? await viewFingerprint() : undefined;
  if (previousView && currentView !== previousView)
    throw new C360ReadError(409, 'CURSOR_CONTEXT_CHANGED');
  const size = Number(limit);
  const rows = await tx.$queryRaw<AuditRow[]>(Prisma.sql`
    SELECT a.id, a.operation, a.resource_type, a.resource_id, a.changed_fields,
      to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at
    FROM c360_profile_audits a WHERE ${eligible} AND ${mapped}
      AND (${catalog} OR ${contact}) ${after}
    ORDER BY a.created_at DESC, a.id DESC LIMIT ${size + 1}`);
  const page = rows.slice(0, size);
  const last = page.at(-1);
  return {
    items: page.map((row) => {
      const operation = OPERATIONS[row.operation];
      return {
        id: row.id,
        occurredAt: row.occurred_at,
        actorDisplay: null,
        operation,
        resourceType: row.resource_type,
        resourceRef: row.resource_id,
        changedFields: [
          ...new Set(
            row.changed_fields.filter((field) => PUBLIC_FIELDS[operation].includes(field)),
          ),
        ],
      };
    }),
    nextCursor:
      rows.length > size && last
        ? codec.seal({
            ...context,
            position: [
              window.from,
              window.to,
              last.occurred_at,
              last.id,
              currentView ?? (await viewFingerprint()),
            ],
          })
        : null,
    coverage: c360ActivityCoverage(
      window,
      type === 'ALL' ? TYPES : [type as C360ActivityType],
      evidence.get(actor.tenantId) ?? [],
      status?.unmapped === true,
    ),
    asOf,
  };
}
