import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { Prisma } from '@d-contact/db';
import {
  C360ContactPointError,
  normalizeC360Email,
  normalizeC360Phone,
} from '@d-contact/contact-points';
import {
  authorizeC360ContactAccess,
  c360DeferredContactSql,
  c360ReadableContactSql,
  type C360ContactAccess,
  type C360IdentityView,
  type C360VerifiedActor,
} from './profile-authorization.js';

/**
 * Cus360 C2 (#792) S1: read model ของ Console (R1 D/F/G, E1 F)
 *
 * - รายการ/จำนวน/รายละเอียดประกอบจาก SQL fragment เดียวกับ C1 (`c360ReadableContactSql`) เท่านั้น;
 *   ไม่ประกอบเงื่อนไขสิทธิ์เอง ไม่นับ DEFER เป็นศูนย์ และไม่เขียนอะไรเลย (GET/search ไม่สร้าง head/หลักฐาน)
 * - Directory ไม่แสดง MERGED predecessor ซ้ำ; AMBIGUOUS แสดงเป็น review-required (อ่านอย่างเดียว)
 * - search: NAME prefix หรือ PHONE/EMAIL เต็มค่าเท่านั้น (ไม่มี wildcard/regex/substring);
 *   ตัวอักษร `%` `_` `\` เป็นตัวอักษรธรรมดา (ใช้ `starts_with` ไม่ใช่ LIKE)
 * - cursor เป็น authenticated-encrypted envelope (AES-256-GCM) ผูก tenant/actor/filter/scope และอายุ 15 นาที
 *   ไม่มี raw query; ทุกหน้า authorize ใหม่ จึงไม่คืนข้อมูลจาก snapshot สิทธิ์เก่า
 */

export const C360_SEARCH_DEFAULT_LIMIT = 20;
export const C360_SEARCH_MAX_LIMIT = 100;
export const C360_CURSOR_TTL_MS = 15 * 60_000;
const NAME_MIN = 2;
const NAME_MAX = 160;

export class C360ReadError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly retryable = false,
    readonly fieldErrors?: readonly { field: string; code: string }[],
    /** ค่าที่คำนวณจริง (เช่น จาก limiter) — filter ต้องคงไว้ ไม่ทับด้วยค่าเริ่มต้น */
    readonly retryAfterSeconds?: number,
  ) {
    super(code);
    this.name = 'C360ReadError';
  }
}

const validation = (field: string, code: string) =>
  new C360ReadError(400, 'VALIDATION_FAILED', false, [{ field, code }]);

// ---------------------------------------------------------------- cursor

export interface C360CursorKey {
  id: string;
  key: Buffer;
}

export interface C360CursorPayload {
  /** ชนิด cursor เพื่อไม่ให้ใช้ข้าม resource (directory / timeline) */
  kind: string;
  tenantId: string;
  userId: string;
  /** digest ของ filter ที่ cursor นี้ใช้ได้ (ไม่ใช่ raw query) */
  filter: string;
  /** digest ของ role/team ของ actor ตอนออก cursor */
  scope: string;
  position: readonly string[];
}

export interface C360CursorCodec {
  seal(payload: C360CursorPayload): string;
  open(
    token: string,
    expected: Omit<C360CursorPayload, 'position'>,
    options?: { distinguishScopeChange?: boolean },
  ): readonly string[];
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

export function c360ScopeDigest(actor: C360VerifiedActor): string {
  return sha256(`c360-scope-v1|${actor.role}|${actor.teamId ?? ''}`);
}

export function c360FilterDigest(parts: readonly string[]): string {
  return sha256(['c360-filter-v1', ...parts].join('\u0000'));
}

/**
 * `keys[0]` ใช้ออก cursor ใหม่; ที่เหลือใช้ถอดจนหมดอายุ (key rotation) ตาม E1 I
 * ไม่มี key ที่ตั้งไว้ = ใช้ key ชั่วคราวของ process (cursor ใช้ข้าม instance/restart ไม่ได้ → ค้นใหม่)
 */
export function createC360CursorCodec(
  keys: readonly C360CursorKey[],
  now: () => number = Date.now,
): C360CursorCodec {
  if (keys.length === 0) throw new TypeError('cursor key ring must not be empty');
  for (const entry of keys)
    if (entry.key.length !== 32 || !/^[A-Za-z0-9_-]{1,32}$/.test(entry.id))
      throw new TypeError('cursor key must be 32 bytes with a short id');
  if (new Set(keys.map((entry) => entry.id)).size !== keys.length)
    throw new TypeError('cursor key ids must be unique');
  const active = keys[0]!;
  return {
    seal(payload) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', active.key, iv);
      cipher.setAAD(Buffer.from(`c360-cursor-v1:${active.id}`));
      const body = Buffer.concat([
        cipher.update(JSON.stringify({ ...payload, exp: now() + C360_CURSOR_TTL_MS }), 'utf8'),
        cipher.final(),
      ]);
      return `v1.${active.id}.${Buffer.concat([iv, body, cipher.getAuthTag()]).toString('base64url')}`;
    },
    open(token, expected, options) {
      const invalid = () => new C360ReadError(400, 'CURSOR_INVALID');
      const [version, keyId, data, extra] = token.split('.');
      if (version !== 'v1' || !keyId || !data || extra !== undefined || token.length > 2048)
        throw invalid();
      const entry = keys.find((candidate) => candidate.id === keyId);
      if (!entry) throw invalid();
      let payload: Record<string, unknown>;
      try {
        const raw = Buffer.from(data, 'base64url');
        if (raw.length < 12 + 16 + 2) throw invalid();
        const decipher = createDecipheriv('aes-256-gcm', entry.key, raw.subarray(0, 12));
        decipher.setAAD(Buffer.from(`c360-cursor-v1:${entry.id}`));
        decipher.setAuthTag(raw.subarray(raw.length - 16));
        payload = JSON.parse(
          Buffer.concat([
            decipher.update(raw.subarray(12, raw.length - 16)),
            decipher.final(),
          ]).toString('utf8'),
        ) as Record<string, unknown>;
      } catch {
        throw invalid();
      }
      if (typeof payload.exp !== 'number' || !Array.isArray(payload.position)) throw invalid();
      if (payload.exp <= now()) throw new C360ReadError(410, 'CURSOR_EXPIRED');
      if (
        payload.kind !== expected.kind ||
        payload.tenantId !== expected.tenantId ||
        payload.userId !== expected.userId ||
        payload.filter !== expected.filter ||
        !payload.position.every((part): part is string => typeof part === 'string')
      )
        throw invalid();
      if (payload.scope !== expected.scope)
        throw options?.distinguishScopeChange
          ? new C360ReadError(409, 'CURSOR_CONTEXT_CHANGED')
          : invalid();
      return payload.position as string[];
    },
  };
}

/** `CUSTOMER_360_CURSOR_KEYS="kid1:<base64 32 bytes>,kid0:<base64 32 bytes>"` (ตัวแรก = ใช้ออก cursor) */
export function c360CursorCodecFromEnv(
  env: Record<string, string | undefined> = process.env,
): C360CursorCodec {
  const raw = env.CUSTOMER_360_CURSOR_KEYS?.trim();
  const keys = raw
    ? raw.split(',').map((entry) => {
        const [id = '', value = ''] = entry.trim().split(':');
        return { id, key: Buffer.from(value, 'base64') };
      })
    : [{ id: 'eph', key: randomBytes(32) }];
  if (!raw && env.NODE_ENV === 'production')
    // ไม่ fail closed เพราะ cursor ที่ใช้ข้าม instance ไม่ได้ทำให้ต้องค้นใหม่เท่านั้น (ไม่เปิดข้อมูล) และ
    // deployment ที่ยังไม่มี secret นี้ต้องไม่ล้ม; แจ้งเตือนชัดเจนให้ตั้งค่าก่อนใช้หลาย instance
    process.emitWarning(
      'CUSTOMER_360_CURSOR_KEYS ไม่ได้ตั้งค่า: cursor ของ Customer 360 ใช้ key ชั่วคราวต่อ process และใช้ข้าม instance/restart ไม่ได้',
      { code: 'C360_CURSOR_KEYS_MISSING' },
    );
  return createC360CursorCodec(keys);
}

// ---------------------------------------------------------------- search input

export type C360SearchType = 'DIRECTORY' | 'NAME' | 'PHONE' | 'EMAIL';

export interface C360SearchInput {
  type: C360SearchType;
  query?: string;
  limit?: number;
  cursor?: string;
}

interface NormalizedSearch {
  type: C360SearchType;
  /** NAME: prefix (NFC+trim); PHONE: `+digits`; EMAIL: local@lower(domain); DIRECTORY: null */
  key: string | null;
  limit: number;
  cursor: string | null;
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

function wellFormed(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) return false;
  }
  return true;
}

function nameKey(value: string): string {
  if (!wellFormed(value)) throw validation('query', 'NAME_INVALID');
  const normalized = value.normalize('NFC').trim();
  if (normalized.length < NAME_MIN || normalized.length > NAME_MAX || CONTROL.test(normalized))
    throw validation('query', normalized.length < NAME_MIN ? 'NAME_TOO_SHORT' : 'NAME_INVALID');
  return normalized;
}

/** ใช้ parser เดียวกับ owner โดยคงรหัส validation ที่ Console รองรับ */
function contactPointKey(kind: 'PHONE' | 'EMAIL', value: string): string {
  try {
    return (kind === 'PHONE' ? normalizeC360Phone(value) : normalizeC360Email(value))
      .normalizedValue;
  } catch (error) {
    if (!(error instanceof C360ContactPointError)) throw error;
    const code =
      kind === 'PHONE' && error.code === 'PHONE_COUNTRY_REQUIRED'
        ? 'PHONE_INTERNATIONAL_REQUIRED'
        : `${kind}_INVALID`;
    throw validation('query', code);
  }
}

const SEARCH_FIELDS = new Set(['type', 'query', 'limit', 'cursor']);

/** strict allowlist; ข้อความ error ไม่มีค่าที่ผู้ใช้กรอก */
export function parseC360SearchInput(body: unknown): NormalizedSearch {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw validation('body', 'OBJECT_REQUIRED');
  const input = body as Record<string, unknown>;
  for (const field of Object.keys(input))
    if (!SEARCH_FIELDS.has(field)) throw validation(field, 'UNKNOWN_FIELD');
  const type = input.type ?? 'DIRECTORY';
  if (type !== 'DIRECTORY' && type !== 'NAME' && type !== 'PHONE' && type !== 'EMAIL')
    throw validation('type', 'TYPE_INVALID');
  let limit = C360_SEARCH_DEFAULT_LIMIT;
  if (input.limit !== undefined) {
    if (
      typeof input.limit !== 'number' ||
      !Number.isInteger(input.limit) ||
      input.limit < 1 ||
      input.limit > C360_SEARCH_MAX_LIMIT
    )
      throw validation('limit', 'LIMIT_INVALID');
    limit = input.limit;
  }
  if (input.cursor !== undefined && (typeof input.cursor !== 'string' || input.cursor.length === 0))
    throw validation('cursor', 'CURSOR_INVALID');
  const cursor = (input.cursor as string | undefined) ?? null;
  if (type === 'DIRECTORY') {
    if (input.query !== undefined && input.query !== '')
      throw validation('query', 'QUERY_NOT_ALLOWED');
    return { type, key: null, limit, cursor };
  }
  if (typeof input.query !== 'string') throw validation('query', 'QUERY_REQUIRED');
  const key = type === 'NAME' ? nameKey(input.query) : contactPointKey(type, input.query);
  return { type, key, limit, cursor };
}

/** แสดง channel ที่ตรงแบบ mask — ไม่คืนค่าเต็มของ point ผ่านรายการค้นหา */
export function maskC360Channel(kind: 'PHONE' | 'EMAIL', key: string): string {
  if (kind === 'PHONE')
    return `${key.slice(0, 3)}${'•'.repeat(Math.max(2, key.length - 7))}${key.slice(-4)}`;
  const at = key.lastIndexOf('@');
  return `${key.slice(0, 1)}•••${key.slice(at)}`;
}

// ---------------------------------------------------------------- search

export interface C360SearchItem {
  contactId: string;
  displayName: string | null;
  company: string | null;
  vip: boolean;
  identity: 'ACTIVE' | 'AMBIGUOUS' | 'LEGACY_MISSING_HEAD';
  reviewRequired: boolean;
  matchedChannel?: { kind: 'PHONE' | 'EMAIL'; masked: string };
}

export interface C360SearchResult {
  items: C360SearchItem[];
  nextCursor: string | null;
  /** INCOMPLETE = มีรายการที่ IAM ยังตามทัน owner ไม่ทัน (DEFER) จึงยังตัดสินสิทธิ์ไม่ได้ ไม่ใช่ "ไม่มี" */
  scope: { state: 'COMPLETE' | 'INCOMPLETE' };
  /** เฉพาะ DIRECTORY หน้าแรก: predicate เดียวกับ list; INCOMPLETE → value เป็น null (ไม่เป็น 0) */
  accessibleCount?: { state: 'AVAILABLE'; value: number } | { state: 'UNAVAILABLE'; value: null };
}

function filterSql(search: NormalizedSearch): Prisma.Sql {
  switch (search.type) {
    case 'DIRECTORY':
      return Prisma.sql`true`;
    case 'NAME':
      return Prisma.sql`starts_with(lower(normalize(coalesce(c.display_name, ''), NFC)), lower(${search.key}))`;
    default:
      return Prisma.sql`EXISTS (
        SELECT 1 FROM c360_contact_points p
        WHERE p.tenant_id = c.tenant_id AND p.contact_id = c.id
          AND p.kind = ${search.type} AND p.state = 'ACTIVE' AND p.normalized_value = ${search.key}
      )`;
  }
}

const NOT_MERGED = Prisma.sql`NOT EXISTS (
  SELECT 1 FROM c360_identity_heads mh
  WHERE mh.tenant_id = c.tenant_id AND mh.contact_id = c.id AND mh.state = 'MERGED'
)`;

const SEARCH_ROLES = new Set(['ADMIN', 'SUPERVISOR']);

export async function searchC360Contacts(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  body: unknown,
  codec: C360CursorCodec,
): Promise<C360SearchResult> {
  // Agent/Compliance ไม่มี generic directory (R1 C); gateway ตัดไปแล้ว ที่นี่เป็นชั้นที่สอง
  if (!SEARCH_ROLES.has(actor.role)) throw new C360ReadError(403, 'CUSTOMER_ACCESS_DENIED');
  const search = parseC360SearchInput(body);
  const readable = Prisma.sql`${c360ReadableContactSql(actor)} AND ${NOT_MERGED}`;
  const filter = filterSql(search);
  const [authorization] = await tx.$queryRaw<{ fingerprint: string }[]>(Prisma.sql`
    SELECT concat(count(*), ':',
      coalesce(bit_xor(('x' || substr(md5(c.id::text), 1, 16))::bit(64)::bigint), 0), ':',
      coalesce(bit_xor(('x' || substr(md5(c.id::text), 17, 16))::bit(64)::bigint), 0)
    ) AS fingerprint
    FROM contacts c
    WHERE c.tenant_id = ${actor.tenantId}::uuid AND ${readable} AND ${filter}`);
  const cursorScope = {
    kind: 'directory',
    tenantId: actor.tenantId,
    userId: actor.userId,
    filter: c360FilterDigest([search.type, search.key ?? '']),
    scope: sha256(`${c360ScopeDigest(actor)}|${authorization!.fingerprint}`),
  };
  const position = search.cursor ? codec.open(search.cursor, cursorScope) : null;
  if (position && (position.length !== 2 || !position[0] || !position[1]))
    throw new C360ReadError(400, 'CURSOR_INVALID');
  let after = Prisma.sql`true`;
  if (position) {
    const [createdKey, id] = position as [string, string];
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/.test(createdKey) ||
      !/^[0-9a-f-]{36}$/i.test(id)
    )
      throw new C360ReadError(400, 'CURSOR_INVALID');
    after = Prisma.sql`(c.created_at, c.id) < (${createdKey}::timestamp, ${id}::uuid)`;
  }
  const rows = await tx.$queryRaw<
    {
      id: string;
      display_name: string | null;
      company: string | null;
      vip: boolean;
      identity: string | null;
      created_key: string;
    }[]
  >(Prisma.sql`
    SELECT c.id, c.display_name, c.company, c.vip,
           (SELECT ih.state::text FROM c360_identity_heads ih
             WHERE ih.tenant_id = c.tenant_id AND ih.contact_id = c.id) AS identity,
           to_char(c.created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_key
    FROM contacts c
    WHERE c.tenant_id = ${actor.tenantId}::uuid AND ${readable} AND ${filter} AND ${after}
    ORDER BY c.created_at DESC, c.id DESC
    LIMIT ${search.limit + 1}`);
  const [deferred] = await tx.$queryRaw<{ deferred: boolean }[]>(Prisma.sql`
    SELECT EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.tenant_id = ${actor.tenantId}::uuid
        AND ${c360DeferredContactSql(actor)} AND ${NOT_MERGED} AND ${filter}
    ) AS deferred`);
  const incomplete = deferred?.deferred === true;
  const page = rows.slice(0, search.limit);
  const last = page.at(-1);
  const items = page.map((row): C360SearchItem => {
    const identity = (row.identity ?? 'LEGACY_MISSING_HEAD') as C360SearchItem['identity'];
    return {
      contactId: row.id,
      displayName: row.display_name,
      company: row.company,
      vip: row.vip,
      identity,
      reviewRequired: identity === 'AMBIGUOUS',
      ...(search.type === 'PHONE' || search.type === 'EMAIL'
        ? {
            matchedChannel: {
              kind: search.type,
              masked: maskC360Channel(search.type, search.key!),
            },
          }
        : {}),
    };
  });
  const result: C360SearchResult = {
    items,
    nextCursor:
      rows.length > search.limit && last
        ? codec.seal({ ...cursorScope, position: [last.created_key, last.id] })
        : null,
    scope: { state: incomplete ? 'INCOMPLETE' : 'COMPLETE' },
  };
  if (search.type === 'DIRECTORY' && !search.cursor) {
    if (incomplete) result.accessibleCount = { state: 'UNAVAILABLE', value: null };
    else {
      const [count] = await tx.$queryRaw<{ n: bigint }[]>(Prisma.sql`
        SELECT count(*)::bigint AS n FROM contacts c
        WHERE c.tenant_id = ${actor.tenantId}::uuid AND ${readable}`);
      result.accessibleCount = { state: 'AVAILABLE', value: Number(count?.n ?? 0n) };
    }
  }
  return result;
}

// ---------------------------------------------------------------- profile

export interface C360ProfileView {
  contact: {
    id: string;
    displayName: string | null;
    company: string | null;
    vip: boolean;
    vipSource: string;
  };
  contactPoints: {
    id: string;
    kind: string;
    value: string;
    state: 'ACTIVE' | 'REVIEW_REQUIRED';
    sourceKind: string;
  }[];
  tags: { id: string; name: string; state: string }[];
  revisions: { profile: string; tag: string; lineage: number | null };
  identity: {
    state: C360IdentityView;
    reviewRequired: boolean;
    /** เฉพาะ MERGED และเฉพาะเมื่อ actor อ่าน canonical target ได้จริง — ไม่ redirect, ไม่เปิดเผย hidden target */
    canonicalContactId?: string;
  };
  capabilities: { read: true; manage: boolean };
  source: { authorizationBasis: string; vipSource: string };
}

/** DENY/ไม่พบ = 404 เหมือนกัน, DEFER = 503 SCOPE_UNAVAILABLE; ใช้ร่วมกันทุก read ของ contact เดียว */
export async function requireReadableC360Contact(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactId: string,
): Promise<Extract<C360ContactAccess, { decision: 'ALLOW' }>> {
  if (!SEARCH_ROLES.has(actor.role)) throw new C360ReadError(403, 'CUSTOMER_ACCESS_DENIED');
  const access = await authorizeC360ContactAccess(tx, actor, contactId);
  if (access.decision === 'DEFER') throw new C360ReadError(503, 'SCOPE_UNAVAILABLE', true);
  if (access.decision === 'DENY') throw new C360ReadError(404, 'RESOURCE_NOT_FOUND');
  return access;
}

export type C360SectionResult<T> =
  | { state: 'READY'; asOf: string; data: T }
  | { state: 'UNAVAILABLE'; asOf: string; reason: 'OWNER_UNAVAILABLE'; retryable: true };

/**
 * อ่านข้อมูลเสริมจาก owner หลังตรวจสิทธิ์ลูกค้าแล้ว: ถ้า owner ล้ม (error ของ DB/owner) ต้องได้ typed
 * UNAVAILABLE ไม่ใช่ empty และไม่ทำให้ core profile ล้ม. ใช้ SAVEPOINT เพื่อให้ transaction ใช้ต่อได้
 */
export async function runC360OwnerSection<T>(
  tx: Prisma.TransactionClient,
  read: () => Promise<T>,
): Promise<C360SectionResult<T>> {
  await tx.$executeRawUnsafe('SAVEPOINT c360_owner_section');
  try {
    const data = await read();
    await tx.$executeRawUnsafe('RELEASE SAVEPOINT c360_owner_section');
    return { state: 'READY', asOf: new Date().toISOString(), data };
  } catch (error) {
    if (error instanceof C360ReadError) throw error;
    await tx.$executeRawUnsafe('ROLLBACK TO SAVEPOINT c360_owner_section');
    return {
      state: 'UNAVAILABLE',
      asOf: new Date().toISOString(),
      reason: 'OWNER_UNAVAILABLE',
      retryable: true,
    };
  }
}

/** Core profile: ไม่ส่ง supplementary data ใด ๆ (timeline/governance แยก endpoint และแยก failure) */
export async function readC360Profile(
  tx: Prisma.TransactionClient,
  actor: C360VerifiedActor,
  contactId: string,
): Promise<C360ProfileView> {
  const access = await requireReadableC360Contact(tx, actor, contactId);
  const [contact] = await tx.$queryRaw<
    {
      id: string;
      display_name: string | null;
      company: string | null;
      vip: boolean;
      vip_source: string;
      profile_revision: bigint;
      tag_revision: bigint;
      lineage_revision: number | null;
      canonical_contact_id: string | null;
    }[]
  >(Prisma.sql`
    SELECT c.id, c.display_name, c.company, c.vip, c.vip_source, c.profile_revision, c.tag_revision,
           ih.lineage_revision, ih.canonical_contact_id
    FROM contacts c
    LEFT JOIN c360_identity_heads ih ON ih.tenant_id = c.tenant_id AND ih.contact_id = c.id
    WHERE c.tenant_id = ${actor.tenantId}::uuid AND c.id = ${contactId}::uuid`);
  if (!contact) throw new C360ReadError(404, 'RESOURCE_NOT_FOUND');
  const points = await tx.$queryRaw<
    {
      id: string;
      kind: string;
      value: string;
      state: 'ACTIVE' | 'REVIEW_REQUIRED';
      source_kind: string;
    }[]
  >(Prisma.sql`
    SELECT p.id, p.kind, coalesce(p.normalized_value, p.raw_value) AS value, p.state, p.source_kind
    FROM c360_contact_points p
    WHERE p.tenant_id = ${actor.tenantId}::uuid AND p.contact_id = ${contactId}::uuid
      AND p.state IN ('ACTIVE', 'REVIEW_REQUIRED')
    ORDER BY p.kind, p.created_at, p.id`);
  const tags = await tx.$queryRaw<{ id: string; name: string; state: string }[]>(Prisma.sql`
    SELECT t.id, t.name, t.state
    FROM c360_contact_tags ct
    JOIN c360_tags t ON t.tenant_id = ct.tenant_id AND t.id = ct.tag_id
    WHERE ct.tenant_id = ${actor.tenantId}::uuid AND ct.contact_id = ${contactId}::uuid
    ORDER BY t.name_key, t.id`);
  let canonicalContactId: string | undefined;
  if (
    access.identity === 'MERGED' &&
    contact.canonical_contact_id &&
    contact.canonical_contact_id !== contactId
  ) {
    const target = await authorizeC360ContactAccess(tx, actor, contact.canonical_contact_id);
    if (target.decision === 'ALLOW') canonicalContactId = contact.canonical_contact_id;
  }
  return {
    contact: {
      id: contact.id,
      displayName: contact.display_name,
      company: contact.company,
      vip: contact.vip,
      vipSource: contact.vip_source,
    },
    contactPoints: points.map((point) => ({
      id: point.id,
      kind: point.kind,
      value: point.value,
      state: point.state,
      sourceKind: point.source_kind,
    })),
    tags,
    revisions: {
      profile: contact.profile_revision.toString(),
      tag: contact.tag_revision.toString(),
      lineage: contact.lineage_revision,
    },
    identity: {
      state: access.identity,
      reviewRequired: access.identity === 'AMBIGUOUS',
      ...(canonicalContactId ? { canonicalContactId } : {}),
    },
    capabilities: { read: true, manage: access.manage },
    source: { authorizationBasis: access.basis, vipSource: contact.vip_source },
  };
}
