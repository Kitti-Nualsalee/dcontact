import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgPreference,
  type CgPreferenceDecision,
  type CgSourceKind,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';

export interface LocalTimeWindow {
  daysOfWeek: number[];
  startLocal: string;
  endLocal: string;
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

export function stableDigest(value: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(value)))
    .digest('hex');
}

const CONTACT_CHANNELS = new Set<ContactChannel>([
  'VOICE',
  'WEBCHAT',
  'LINE',
  'FACEBOOK',
  'WHATSAPP',
  'EMAIL',
]);

export interface CgPreferenceScope {
  identityId: string | null;
  channel: ContactChannel | null;
  purpose: string | null;
  contactKind: string | null;
}

export interface CgEventPayloadV1 {
  contractVersion: 1;
  mutationId: string;
  subjectVersion: number;
  identityId?: string;
  affectedScope: CgPreferenceScope;
  effectiveAt: string;
  policyVersion?: number;
  stateDigest: string;
}

function jsonRecord(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError(`${field} ต้องเป็น JSON object`);
  }
  return value as Record<string, unknown>;
}

function assertKnownKeys(
  record: Record<string, unknown>,
  allowedKeys: readonly string[],
  field: string,
): void {
  const allowed = new Set(allowedKeys);
  const unknownKey = Object.keys(record).find((key) => !allowed.has(key));
  if (unknownKey) throw new TypeError(`${field} มี field ที่ไม่รู้จัก: ${unknownKey}`);
}

function optionalString(value: unknown, field: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new TypeError(`${field} ต้องเป็น string หรือ null`);
  return nonEmpty(value, field);
}

function requiredString(value: unknown, field: string): string {
  const normalized = optionalString(value, field);
  if (normalized === null) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
  return normalized;
}

export function validateCgScope(value: unknown): CgPreferenceScope {
  const scope = jsonRecord(value, 'affectedScope');
  assertKnownKeys(scope, ['identityId', 'channel', 'purpose', 'contactKind'], 'affectedScope');
  const channel = optionalString(scope.channel, 'channel');
  if (channel !== null && !CONTACT_CHANNELS.has(channel as ContactChannel)) {
    throw new TypeError('channel ไม่อยู่ใน ContactChannel');
  }
  return {
    identityId: optionalString(scope.identityId, 'identityId'),
    channel: channel as ContactChannel | null,
    purpose: optionalString(scope.purpose, 'purpose'),
    contactKind: optionalString(scope.contactKind, 'contactKind'),
  };
}

export function validateCgEventPayloadV1(value: unknown): CgEventPayloadV1 {
  const payload = jsonRecord(value, 'payload');
  assertKnownKeys(
    payload,
    [
      'contractVersion',
      'mutationId',
      'subjectVersion',
      'identityId',
      'affectedScope',
      'effectiveAt',
      'policyVersion',
      'stateDigest',
    ],
    'payload',
  );
  if (payload.contractVersion !== 1) throw new RangeError('contractVersion ต้องเป็น 1');
  if (!Number.isInteger(payload.subjectVersion) || (payload.subjectVersion as number) < 1) {
    throw new RangeError('subjectVersion ต้องเป็น positive integer');
  }
  const policyVersion = payload.policyVersion;
  if (
    policyVersion !== undefined &&
    (!Number.isInteger(policyVersion) || (policyVersion as number) < 1)
  ) {
    throw new RangeError('policyVersion ต้องเป็น positive integer');
  }
  const stateDigest = requiredString(payload.stateDigest, 'stateDigest');
  if (!/^[a-f0-9]{64}$/.test(stateDigest)) {
    throw new TypeError('stateDigest ต้องเป็น lowercase SHA-256');
  }
  const effectiveAt = instant(
    requiredString(payload.effectiveAt, 'effectiveAt'),
    'effectiveAt',
  ).toISOString();
  const identityId = optionalString(payload.identityId, 'identityId');
  return {
    contractVersion: 1,
    mutationId: requiredString(payload.mutationId, 'mutationId'),
    subjectVersion: payload.subjectVersion as number,
    ...(identityId ? { identityId } : {}),
    affectedScope: validateCgScope(payload.affectedScope),
    effectiveAt,
    ...(policyVersion !== undefined ? { policyVersion: policyVersion as number } : {}),
    stateDigest,
  };
}

function localMinute(value: string, field: string): number {
  const match = /^(?:[01]\d|2[0-3]):[0-5]\d$/.exec(value);
  if (!match) throw new TypeError(`${field} ต้องเป็นเวลา HH:mm`);
  const [hour, minute] = value.split(':').map(Number);
  return hour! * 60 + minute!;
}

export function normalizeLocalTimeWindows(windows: readonly LocalTimeWindow[]): LocalTimeWindow[] {
  const normalized = windows.map((window, index) => {
    const daysOfWeek = [...new Set(window.daysOfWeek)].sort((left, right) => left - right);
    if (
      daysOfWeek.length === 0 ||
      daysOfWeek.some((day) => !Number.isInteger(day) || day < 1 || day > 7)
    ) {
      throw new TypeError(`windows[${index}].daysOfWeek ต้องอยู่ระหว่าง 1 ถึง 7`);
    }
    localMinute(window.startLocal, `windows[${index}].startLocal`);
    localMinute(window.endLocal, `windows[${index}].endLocal`);
    return { daysOfWeek, startLocal: window.startLocal, endLocal: window.endLocal };
  });

  const weekMinutes = 7 * 24 * 60;
  const intervals: Array<{ start: number; end: number }> = [];
  for (const window of normalized) {
    const startMinute = localMinute(window.startLocal, 'startLocal');
    const endMinute = localMinute(window.endLocal, 'endLocal');
    for (const day of window.daysOfWeek) {
      const start = (day - 1) * 24 * 60 + startMinute;
      const unwrappedEnd =
        (day - 1) * 24 * 60 + endMinute + (endMinute <= startMinute ? 24 * 60 : 0);
      if (unwrappedEnd <= weekMinutes) intervals.push({ start, end: unwrappedEnd });
      else {
        intervals.push({ start, end: weekMinutes });
        intervals.push({ start: 0, end: unwrappedEnd - weekMinutes });
      }
    }
  }
  intervals.sort((left, right) => left.start - right.start || left.end - right.end);
  for (let index = 1; index < intervals.length; index += 1) {
    if (intervals[index]!.start < intervals[index - 1]!.end) {
      throw new RangeError('local-time windows ทับซ้อนกันหลัง normalize');
    }
  }

  return normalized.sort(
    (left, right) =>
      left.daysOfWeek.join(',').localeCompare(right.daysOfWeek.join(',')) ||
      left.startLocal.localeCompare(right.startLocal) ||
      left.endLocal.localeCompare(right.endLocal),
  );
}

export interface AppendPreferenceInput {
  tenantId: string;
  contactId: string;
  identityId?: string;
  seriesId?: string;
  channel?: ContactChannel;
  purpose?: string;
  contactKind?: string;
  decision: CgPreferenceDecision;
  timezone?: string;
  preferredWindows: readonly LocalTimeWindow[];
  sourceKind: CgSourceKind;
  sourceVersion?: string;
  occurredAt: string;
  effectiveFrom: string;
  effectiveTo?: string;
  evidenceRef: string;
  actorClass: string;
  actorRef: string;
  idempotencyKey: string;
  expectedVersion: number;
  correlationId: string;
}

export interface PreferenceView {
  id: string;
  tenantId: string;
  seriesId: string;
  version: number;
  contactId: string;
  identityId?: string;
  channel?: ContactChannel;
  purpose?: string;
  contactKind?: string;
  scopeHash: string;
  decision?: CgPreferenceDecision;
  timezone?: string;
  preferredWindows: LocalTimeWindow[];
  sourceKind: CgSourceKind;
  sourceVersion?: string;
  occurredAt: string;
  effectiveFrom: string;
  effectiveTo?: string;
  mutationKind: 'SET' | 'REVOKE';
  supersedesId?: string;
  evidenceRef: string;
  actorClass: string;
  createdAt: string;
}

export interface PreferenceMutationResult {
  mutationId: string;
  eventId: string;
  aggregateVersion: number;
  preference: PreferenceView;
}

export interface ContactStateHeadView {
  tenantId: string;
  contactId: string;
  aggregateVersion: number;
  currentDigest: string;
  latestMutationId?: string;
  updatedAt: string;
}

export interface PreferenceHistoryQuery {
  tenantId: string;
  contactId: string;
  limit?: number;
}

export interface MutationEvidenceQuery {
  tenantId: string;
  mutationId: string;
}

export interface MutationEvidence {
  aggregateVersion: number;
  auditCount: number;
  outboxCount: number;
  receiptCount: number;
}

export class Cg3IdempotencyConflictError extends Error {
  readonly code = 'IDEMPOTENCY_CONFLICT';

  constructor(readonly idempotencyKey: string) {
    super(`Idempotency-Key ถูกใช้กับ canonical request อื่นแล้ว: ${idempotencyKey}`);
    this.name = 'Cg3IdempotencyConflictError';
  }
}

export class Cg3VersionConflictError extends Error {
  readonly code = 'VERSION_CONFLICT';

  constructor(
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`expectedVersion ${expectedVersion} ไม่ตรงกับ aggregateVersion ${actualVersion}`);
    this.name = 'Cg3VersionConflictError';
  }
}

export class Cg3ResourceNotFoundError extends Error {
  readonly code = 'RESOURCE_NOT_FOUND';

  constructor() {
    super('ไม่พบ resource ใน active tenant');
    this.name = 'Cg3ResourceNotFoundError';
  }
}

export interface Cg3PreferenceRepositoryOptions {
  id?: () => string;
}

function nonEmpty(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} ต้องเป็น string ที่ไม่ว่าง`);
  return normalized;
}

function instant(value: string, field: string): Date {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new TypeError(`${field} ต้องเป็น ISO-8601 timestamp`);
  return parsed;
}

function preferenceView(preference: CgPreference): PreferenceView {
  return {
    id: preference.id,
    tenantId: preference.tenantId,
    seriesId: preference.seriesId,
    version: preference.version,
    contactId: preference.contactId,
    ...(preference.identityId ? { identityId: preference.identityId } : {}),
    ...(preference.channel ? { channel: preference.channel } : {}),
    ...(preference.purpose ? { purpose: preference.purpose } : {}),
    ...(preference.contactKind ? { contactKind: preference.contactKind } : {}),
    scopeHash: preference.scopeHash,
    ...(preference.decision ? { decision: preference.decision } : {}),
    ...(preference.timezone ? { timezone: preference.timezone } : {}),
    preferredWindows: preference.preferredWindows as unknown as LocalTimeWindow[],
    sourceKind: preference.sourceKind,
    ...(preference.sourceVersion ? { sourceVersion: preference.sourceVersion } : {}),
    occurredAt: preference.occurredAt.toISOString(),
    effectiveFrom: preference.effectiveFrom.toISOString(),
    ...(preference.effectiveTo ? { effectiveTo: preference.effectiveTo.toISOString() } : {}),
    mutationKind: preference.mutationKind,
    ...(preference.supersedesId ? { supersedesId: preference.supersedesId } : {}),
    evidenceRef: preference.evidenceRef,
    actorClass: preference.actorClass,
    createdAt: preference.createdAt.toISOString(),
  };
}

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class Cg3PreferenceRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: Cg3PreferenceRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  async ensureHead(query: { tenantId: string; contactId: string }): Promise<ContactStateHeadView> {
    return withTenantDatabaseTransaction(this.database, query.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg3-contact:${query.tenantId}:${query.contactId}`}))`,
      );
      const contact = await transaction.contact.findFirst({
        where: { tenantId: query.tenantId, id: query.contactId },
        select: { id: true },
      });
      if (!contact) throw new Cg3ResourceNotFoundError();
      const existing = await transaction.cgContactStateHead.findUnique({
        where: { tenantId_contactId: query },
      });
      const head =
        existing ??
        (await transaction.cgContactStateHead.create({
          data: {
            ...query,
            aggregateVersion: 0,
            currentDigest: stableDigest({ preferences: [] }),
          },
        }));
      return {
        tenantId: head.tenantId,
        contactId: head.contactId,
        aggregateVersion: head.aggregateVersion,
        currentDigest: head.currentDigest,
        ...(head.latestMutationId ? { latestMutationId: head.latestMutationId } : {}),
        updatedAt: head.updatedAt.toISOString(),
      };
    });
  }

  async append(input: AppendPreferenceInput): Promise<PreferenceMutationResult> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.contactId, 'contactId');
    nonEmpty(input.evidenceRef, 'evidenceRef');
    nonEmpty(input.actorClass, 'actorClass');
    nonEmpty(input.actorRef, 'actorRef');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    nonEmpty(input.correlationId, 'correlationId');
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new RangeError('expectedVersion ต้องเป็น integer ตั้งแต่ 0');
    }
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const effectiveFrom = instant(input.effectiveFrom, 'effectiveFrom');
    const effectiveTo = input.effectiveTo ? instant(input.effectiveTo, 'effectiveTo') : undefined;
    if (effectiveTo && effectiveTo <= effectiveFrom) {
      throw new RangeError('effectiveTo ต้องอยู่หลัง effectiveFrom');
    }
    if (input.timezone) {
      try {
        new Intl.DateTimeFormat('en-US', { timeZone: input.timezone }).format(occurredAt);
      } catch {
        throw new TypeError('timezone ต้องเป็น IANA timezone ที่ถูกต้อง');
      }
    }
    const preferredWindows = normalizeLocalTimeWindows(input.preferredWindows);
    const scope = validateCgScope({
      identityId: input.identityId ?? null,
      channel: input.channel ?? null,
      purpose: input.purpose ?? null,
      contactKind: input.contactKind ?? null,
    });
    const scopeHash = stableDigest(scope);
    const requestHash = stableDigest({
      tenantId: input.tenantId,
      contactId: input.contactId,
      seriesId: input.seriesId ?? null,
      scope,
      decision: input.decision,
      timezone: input.timezone ?? null,
      preferredWindows,
      sourceKind: input.sourceKind,
      sourceVersion: input.sourceVersion ?? null,
      occurredAt: occurredAt.toISOString(),
      effectiveFrom: effectiveFrom.toISOString(),
      effectiveTo: effectiveTo?.toISOString() ?? null,
      evidenceRef: input.evidenceRef,
      actorClass: input.actorClass,
      actorRef: input.actorRef,
      expectedVersion: input.expectedVersion,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg3-contact:${input.tenantId}:${input.contactId}`}))`,
      );

      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation: 'PREFERENCE_SET',
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          throw new Cg3IdempotencyConflictError(input.idempotencyKey);
        }
        return receipt.responseBody as unknown as PreferenceMutationResult;
      }

      const contact = await transaction.contact.findFirst({
        where: { id: input.contactId, tenantId: input.tenantId },
        select: { id: true },
      });
      const identity = input.identityId
        ? await transaction.contactIdentity.findFirst({
            where: {
              id: input.identityId,
              tenantId: input.tenantId,
              contactId: input.contactId,
            },
            select: { id: true },
          })
        : undefined;
      if (!contact || (input.identityId && !identity)) throw new Cg3ResourceNotFoundError();

      const head = await transaction.cgContactStateHead.findUnique({
        where: {
          tenantId_contactId: { tenantId: input.tenantId, contactId: input.contactId },
        },
      });
      const actualVersion = head?.aggregateVersion ?? 0;
      if (actualVersion !== input.expectedVersion) {
        throw new Cg3VersionConflictError(input.expectedVersion, actualVersion);
      }

      const latestInScope = await transaction.cgPreference.findFirst({
        where: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          scopeHash,
        },
        orderBy: { version: 'desc' },
      });
      const latestInSeries = input.seriesId
        ? await transaction.cgPreference.findFirst({
            where: { tenantId: input.tenantId, seriesId: input.seriesId },
            orderBy: { version: 'desc' },
          })
        : undefined;
      if (
        latestInSeries &&
        (latestInSeries.contactId !== input.contactId || latestInSeries.scopeHash !== scopeHash)
      ) {
        throw new Cg3IdempotencyConflictError(input.idempotencyKey);
      }
      const seriesId = input.seriesId ?? latestInScope?.seriesId ?? this.id();
      const preferenceVersion =
        Math.max(latestInScope?.version ?? 0, latestInSeries?.version ?? 0) + 1;

      const mutationId = this.id();
      const aggregateVersion = actualVersion + 1;
      const preference = await transaction.cgPreference.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          seriesId,
          version: preferenceVersion,
          contactId: input.contactId,
          identityId: input.identityId,
          channel: input.channel,
          purpose: input.purpose,
          contactKind: input.contactKind,
          scopeHash,
          decision: input.decision,
          timezone: input.timezone,
          preferredWindows: json(preferredWindows),
          sourceKind: input.sourceKind,
          sourceVersion: input.sourceVersion,
          occurredAt,
          effectiveFrom,
          effectiveTo,
          mutationKind: 'SET',
          supersedesId: latestInScope?.id,
          requestHash,
          evidenceRef: input.evidenceRef,
          actorClass: input.actorClass,
        },
      });
      const afterDigest = stableDigest({
        previous: head?.currentDigest ?? null,
        preference: preferenceView(preference),
      });

      if (head) {
        const updated = await transaction.cgContactStateHead.updateMany({
          where: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            aggregateVersion: input.expectedVersion,
          },
          data: { aggregateVersion, currentDigest: afterDigest, latestMutationId: mutationId },
        });
        if (updated.count !== 1) {
          throw new Cg3VersionConflictError(input.expectedVersion, actualVersion);
        }
      } else {
        await transaction.cgContactStateHead.create({
          data: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            aggregateVersion,
            currentDigest: afterDigest,
            latestMutationId: mutationId,
          },
        });
      }

      const payload = validateCgEventPayloadV1({
        contractVersion: 1,
        mutationId,
        subjectVersion: aggregateVersion,
        ...(input.identityId ? { identityId: input.identityId } : {}),
        affectedScope: scope,
        effectiveAt: effectiveFrom.toISOString(),
        stateDigest: afterDigest,
      });
      const eventId = this.id();
      await transaction.cgEventOutbox.create({
        data: {
          id: eventId,
          mutationId,
          tenantId: input.tenantId,
          aggregateType: 'CONTACT',
          aggregateId: input.contactId,
          aggregateVersion,
          eventType: 'preference.changed',
          orderingKey: `${input.tenantId}:${input.contactId}`,
          payload: json(payload),
          payloadHash: stableDigest(payload),
        },
      });
      await transaction.cgAuditLog.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          mutationId,
          aggregateType: 'CONTACT',
          aggregateId: input.contactId,
          aggregateVersion,
          action: 'PREFERENCE_SET',
          actorClass: input.actorClass,
          actorRef: input.actorRef,
          sourceKind: input.sourceKind,
          evidenceRef: input.evidenceRef,
          beforeDigest: head?.currentDigest,
          afterDigest,
          occurredAt,
        },
      });
      const result: PreferenceMutationResult = {
        mutationId,
        eventId,
        aggregateVersion,
        preference: preferenceView(preference),
      };
      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: 'PREFERENCE_SET',
          idempotencyKey: input.idempotencyKey,
          requestHash,
          expectedVersion: input.expectedVersion,
          aggregateVersion,
          responseStatus: 201,
          responseBody: json(result),
        },
      });
      return result;
    });
  }

  async history(query: PreferenceHistoryQuery): Promise<PreferenceView[]> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('preference history limit ต้องเป็น integer ระหว่าง 1 ถึง 500');
    }
    return withTenantDatabaseTransaction(this.database, query.tenantId, async (transaction) => {
      const preferences = await transaction.cgPreference.findMany({
        where: { tenantId: query.tenantId, contactId: query.contactId },
        orderBy: [{ occurredAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      return preferences.map(preferenceView);
    });
  }

  async mutationEvidence(query: MutationEvidenceQuery): Promise<MutationEvidence | undefined> {
    return withTenantDatabaseTransaction(this.database, query.tenantId, async (transaction) => {
      const [audits, outbox, receipts] = await Promise.all([
        transaction.cgAuditLog.findMany({
          where: { tenantId: query.tenantId, mutationId: query.mutationId },
          select: { aggregateVersion: true },
        }),
        transaction.cgEventOutbox.count({
          where: { tenantId: query.tenantId, mutationId: query.mutationId },
        }),
        transaction.cgCommandReceipt.count({
          where: {
            tenantId: query.tenantId,
            responseBody: { path: ['mutationId'], equals: query.mutationId },
          },
        }),
      ]);
      if (!audits[0]) return undefined;
      return {
        aggregateVersion: audits[0].aggregateVersion,
        auditCount: audits.length,
        outboxCount: outbox,
        receiptCount: receipts,
      };
    });
  }
}
