import { createHash, randomUUID } from 'node:crypto';
import {
  Prisma,
  type CgSourceKind,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';
import { stableDigest } from './cg3-persistence.js';
import {
  Cg3IdempotencyConflictError,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
} from './cg3-persistence.js';

/**
 * Request-side ของ callback exception (#101 §5). Consumption เกิดเป็น side effect
 * ภายใน `authorizeAndReserve()` เท่านั้น (S1.2) — ไม่มี HTTP consume/revoke command ใน S1.3
 */

export interface RequestCallbackInput {
  tenantId: string;
  contactId: string;
  identityId?: string;
  channel: ContactChannel;
  purpose: string;
  requestedAt: string;
  requestedTimezone: string;
  expiresAt: string;
  sourceKind: CgSourceKind;
  sourceVersion?: string;
  evidenceRef: string;
  actorClass: string;
  actorRef: string;
  idempotencyKey: string;
  expectedVersion: number;
  correlationId: string;
}

export interface CallbackRequestView {
  id: string;
  tenantId: string;
  seriesId: string;
  version: number;
  contactId: string;
  identityId?: string;
  channel: ContactChannel;
  purpose: string;
  requestedAt: string;
  requestedTimezone: string;
  expiresAt: string;
  sourceKind: CgSourceKind;
  sourceVersion?: string;
  approvedExceptionId?: string;
  mutationKind: 'REQUEST' | 'CONSUME' | 'REVOKE';
  supersedesId?: string;
  evidenceRef: string;
  actorClass: string;
  createdAt: string;
}

export interface RequestCallbackResult {
  mutationId: string;
  callbackRequest: CallbackRequestView;
  /** plaintext one-use token — ส่งกลับครั้งเดียวตอนสร้าง; server เก็บเฉพาะ hash */
  oneUseToken: string;
}

export interface CallbackHistoryQuery {
  tenantId: string;
  contactId: string;
  limit?: number;
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

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function view(row: {
  id: string;
  tenantId: string;
  seriesId: string;
  version: number;
  contactId: string;
  identityId: string | null;
  channel: ContactChannel;
  purpose: string;
  requestedAt: Date;
  requestedTimezone: string;
  expiresAt: Date;
  sourceKind: CgSourceKind;
  sourceVersion: string | null;
  approvedExceptionId: string | null;
  mutationKind: 'REQUEST' | 'CONSUME' | 'REVOKE';
  supersedesId: string | null;
  evidenceRef: string;
  actorClass: string;
  createdAt: Date;
}): CallbackRequestView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    seriesId: row.seriesId,
    version: row.version,
    contactId: row.contactId,
    ...(row.identityId ? { identityId: row.identityId } : {}),
    channel: row.channel,
    purpose: row.purpose,
    requestedAt: row.requestedAt.toISOString(),
    requestedTimezone: row.requestedTimezone,
    expiresAt: row.expiresAt.toISOString(),
    sourceKind: row.sourceKind,
    ...(row.sourceVersion ? { sourceVersion: row.sourceVersion } : {}),
    ...(row.approvedExceptionId ? { approvedExceptionId: row.approvedExceptionId } : {}),
    mutationKind: row.mutationKind,
    ...(row.supersedesId ? { supersedesId: row.supersedesId } : {}),
    evidenceRef: row.evidenceRef,
    actorClass: row.actorClass,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface Cg3CallbackRepositoryOptions {
  id?: () => string;
}

export class Cg3CallbackRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: Cg3CallbackRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  /**
   * สร้าง callback request ใหม่ในซีรีส์ที่ระบุด้วย exact scope
   * (contactId, identityId, channel, purpose) — CAS ผ่าน `expectedVersion`
   * เทียบกับ version ล่าสุดของซีรีส์นั้น (ไม่ใช่ CgContactStateHead — callback มี
   * versioning ของตัวเองแยกจาก preference aggregate)
   */
  async request(input: RequestCallbackInput): Promise<RequestCallbackResult> {
    nonEmpty(input.tenantId, 'tenantId');
    nonEmpty(input.contactId, 'contactId');
    nonEmpty(input.purpose, 'purpose');
    nonEmpty(input.requestedTimezone, 'requestedTimezone');
    nonEmpty(input.evidenceRef, 'evidenceRef');
    nonEmpty(input.actorClass, 'actorClass');
    nonEmpty(input.actorRef, 'actorRef');
    nonEmpty(input.idempotencyKey, 'idempotencyKey');
    nonEmpty(input.correlationId, 'correlationId');
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new RangeError('expectedVersion ต้องเป็น integer ตั้งแต่ 0');
    }
    const requestedAt = instant(input.requestedAt, 'requestedAt');
    const expiresAt = instant(input.expiresAt, 'expiresAt');
    if (expiresAt <= requestedAt) {
      throw new RangeError('expiresAt ต้องอยู่หลัง requestedAt');
    }
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: input.requestedTimezone }).format(requestedAt);
    } catch {
      throw new TypeError('requestedTimezone ต้องเป็น IANA timezone ที่ถูกต้อง');
    }

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      contactId: input.contactId,
      identityId: input.identityId ?? null,
      channel: input.channel,
      purpose: input.purpose,
      requestedAt: requestedAt.toISOString(),
      requestedTimezone: input.requestedTimezone,
      expiresAt: expiresAt.toISOString(),
      sourceKind: input.sourceKind,
      sourceVersion: input.sourceVersion ?? null,
      evidenceRef: input.evidenceRef,
      actorClass: input.actorClass,
      actorRef: input.actorRef,
      expectedVersion: input.expectedVersion,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 AS acquired FROM pg_advisory_xact_lock(hashtext(${`cg3-callback:${input.tenantId}:${input.contactId}:${input.channel}:${input.purpose}`}))`,
      );

      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation: 'CALLBACK_REQUEST_CREATE',
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash) {
          throw new Cg3IdempotencyConflictError(input.idempotencyKey);
        }
        return receipt.responseBody as unknown as RequestCallbackResult;
      }

      const contact = await transaction.contact.findFirst({
        where: { id: input.contactId, tenantId: input.tenantId },
        select: { id: true },
      });
      const identity = input.identityId
        ? await transaction.contactIdentity.findFirst({
            where: { id: input.identityId, tenantId: input.tenantId, contactId: input.contactId },
            select: { id: true },
          })
        : undefined;
      if (!contact || (input.identityId && !identity)) throw new Cg3ResourceNotFoundError();

      const latest = await transaction.cgCallbackRequest.findFirst({
        where: {
          tenantId: input.tenantId,
          contactId: input.contactId,
          identityId: input.identityId ?? null,
          channel: input.channel,
          purpose: input.purpose,
        },
        orderBy: { version: 'desc' },
      });
      const actualVersion = latest?.version ?? 0;
      if (actualVersion !== input.expectedVersion) {
        throw new Cg3VersionConflictError(input.expectedVersion, actualVersion);
      }

      const seriesId = latest?.seriesId ?? this.id();
      const version = actualVersion + 1;
      const oneUseToken = randomUUID();
      const oneUseTokenHash = createHash('sha256').update(oneUseToken).digest('hex');

      const created = await transaction.cgCallbackRequest.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          seriesId,
          version,
          contactId: input.contactId,
          identityId: input.identityId,
          channel: input.channel,
          purpose: input.purpose,
          requestedAt,
          requestedTimezone: input.requestedTimezone,
          expiresAt,
          sourceKind: input.sourceKind,
          sourceVersion: input.sourceVersion,
          oneUseTokenHash,
          mutationKind: 'REQUEST',
          supersedesId: latest?.id,
          evidenceRef: input.evidenceRef,
          requestHash,
          actorClass: input.actorClass,
        },
      });

      const mutationId = this.id();
      await transaction.cgAuditLog.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          mutationId,
          aggregateType: 'CONTACT',
          aggregateId: input.contactId,
          aggregateVersion: version,
          action: 'CALLBACK_REQUEST_CREATE',
          actorClass: input.actorClass,
          actorRef: input.actorRef,
          sourceKind: input.sourceKind,
          evidenceRef: input.evidenceRef,
          afterDigest: stableDigest(view(created)),
          occurredAt: requestedAt,
        },
      });

      const result: RequestCallbackResult = {
        mutationId,
        callbackRequest: view(created),
        oneUseToken,
      };
      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: 'CALLBACK_REQUEST_CREATE',
          idempotencyKey: input.idempotencyKey,
          requestHash,
          expectedVersion: input.expectedVersion,
          aggregateVersion: version,
          responseStatus: 201,
          responseBody: json(result),
        },
      });
      return result;
    });
  }

  async history(query: CallbackHistoryQuery): Promise<CallbackRequestView[]> {
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError('callback history limit ต้องเป็น integer ระหว่าง 1 ถึง 500');
    }
    return withTenantDatabaseTransaction(this.database, query.tenantId, async (transaction) => {
      const callbacks = await transaction.cgCallbackRequest.findMany({
        where: { tenantId: query.tenantId, contactId: query.contactId },
        orderBy: [{ requestedAt: 'desc' }, { version: 'desc' }, { id: 'desc' }],
        take: limit,
      });
      return callbacks.map(view);
    });
  }
}
