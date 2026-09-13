import { randomUUID } from 'node:crypto';
import {
  Prisma,
  type Cg4Exception,
  type Cg4ExceptionScopeKind,
  type Cg4ExceptionStatus,
  type Cg4ExceptionTier,
  type PrismaClient,
  withTenantDatabaseTransaction,
} from '@d-contact/db';
import type { Cg4SourceType, ContactChannel } from '@d-contact/cxa-contracts';
import {
  Cg3IdempotencyConflictError,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
  stableDigest,
} from './cg3-persistence.js';
import { resolveCg4OverrideEligibility } from './cg4-rule-registry.js';
import { Cg4InvalidLifecycleTransitionError } from './cg4-exception-lifecycle.js';

/**
 * CG4.2 primitive สำหรับเขียน exception revision แบบ append-only เท่านั้น.
 * Approval/effective-state/evaluator เป็น authority ของ CG4.3+ จึงไม่อยู่ใน class นี้.
 */
export interface RecordCg4ExceptionInput {
  tenantId: string;
  contactId: string;
  identityId?: string;
  scopeKind: Cg4ExceptionScopeKind;
  channel: ContactChannel;
  purpose: string;
  sourceType: Cg4SourceType;
  sourceId: string;
  allowedRuleCodes: readonly string[];
  policyId: string;
  policyVersion: number;
  policyContentDigest: string;
  registryVersion: string;
  startsAt: string;
  expiresAt: string;
  tier: Cg4ExceptionTier;
  reasonCode: string;
  ticketRef?: string;
  evidenceRef: string;
  actorRef: string;
  occurredAt: string;
  exceptionId?: string;
  /** CG4.4 (#187): series this request renews; renewal is always a new series. */
  renewsExceptionId?: string;
  idempotencyKey: string;
  expectedVersion: number;
}

export interface Cg4ExceptionView {
  id: string;
  tenantId: string;
  exceptionId: string;
  revision: number;
  contactId: string;
  identityId?: string;
  scopeKind: Cg4ExceptionScopeKind;
  channel: ContactChannel;
  purpose: string;
  sourceType: string;
  sourceId: string;
  allowedRuleCodes: string[];
  policyId: string;
  policyVersion: number;
  policyContentDigest: string;
  registryVersion: string;
  startsAt: string;
  expiresAt: string;
  tier: Cg4ExceptionTier;
  status: Cg4ExceptionStatus;
  reasonCode: string;
  ticketRef?: string;
  evidenceRef: string;
  actorRef: string;
  createdAt: string;
}

export interface RecordCg4ExceptionResult {
  mutationId: string;
  eventId: string;
  aggregateVersion: number;
  exception: Cg4ExceptionView;
}

export interface Cg4ExceptionHistoryQuery {
  tenantId: string;
  contactId: string;
  exceptionId?: string;
}

export class Cg4PolicyBindingError extends Error {
  readonly code = 'POLICY_BINDING_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'Cg4PolicyBindingError';
  }
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

function sha256(value: string, field: string): string {
  if (!/^[a-f0-9]{64}$/.test(value)) throw new TypeError(`${field} ต้องเป็น lowercase SHA-256`);
  return value;
}

const CG4_SOURCE_TYPES = new Set<Cg4SourceType>([
  'JOURNEY',
  'CAMPAIGN',
  'DIALER',
  'CHANNEL',
  'SURVEY',
  'AGENT',
  'EXTERNAL',
]);

function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

function policyAllowedRuleCodes(content: unknown): string[] {
  if (!content || typeof content !== 'object' || Array.isArray(content)) {
    throw new Cg4PolicyBindingError(
      'policy content ต้องเป็น object ที่มี allowedOperationalRuleCodes',
    );
  }
  const value = (content as Record<string, unknown>).allowedOperationalRuleCodes;
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || !entry.trim())) {
    throw new Cg4PolicyBindingError('policy content ไม่มี allowedOperationalRuleCodes ที่ถูกต้อง');
  }
  return value;
}

function view(row: Cg4Exception): Cg4ExceptionView {
  return {
    id: row.id,
    tenantId: row.tenantId,
    exceptionId: row.exceptionId,
    revision: row.revision,
    contactId: row.contactId,
    ...(row.identityId ? { identityId: row.identityId } : {}),
    scopeKind: row.scopeKind,
    channel: row.channel,
    purpose: row.purpose,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    allowedRuleCodes: [...row.allowedRuleCodes],
    policyId: row.policyId,
    policyVersion: row.policyVersion,
    policyContentDigest: row.policyContentDigest,
    registryVersion: row.registryVersion,
    startsAt: row.startsAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    tier: row.tier,
    status: row.status,
    reasonCode: row.reasonCode,
    ...(row.ticketRef ? { ticketRef: row.ticketRef } : {}),
    evidenceRef: row.evidenceRef,
    actorRef: row.actorRef,
    createdAt: row.createdAt.toISOString(),
  };
}

export interface Cg4FoundationRepositoryOptions {
  id?: () => string;
}

export class Cg4FoundationRepository {
  private readonly id: () => string;

  constructor(
    private readonly database: PrismaClient,
    options: Cg4FoundationRepositoryOptions = {},
  ) {
    this.id = options.id ?? randomUUID;
  }

  async recordException(input: RecordCg4ExceptionInput): Promise<RecordCg4ExceptionResult> {
    for (const [field, value] of Object.entries({
      tenantId: input.tenantId,
      contactId: input.contactId,
      purpose: input.purpose,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      policyId: input.policyId,
      registryVersion: input.registryVersion,
      reasonCode: input.reasonCode,
      evidenceRef: input.evidenceRef,
      actorRef: input.actorRef,
      idempotencyKey: input.idempotencyKey,
    })) {
      nonEmpty(value, field);
    }
    if (input.exceptionId) nonEmpty(input.exceptionId, 'exceptionId');
    if (input.identityId) nonEmpty(input.identityId, 'identityId');
    if (input.ticketRef) nonEmpty(input.ticketRef, 'ticketRef');
    if (input.renewsExceptionId) nonEmpty(input.renewsExceptionId, 'renewsExceptionId');
    if (!CG4_SOURCE_TYPES.has(input.sourceType)) {
      throw new TypeError('sourceType ไม่อยู่ใน CG4 source registry');
    }
    if (
      (input.scopeKind === 'IDENTITY' && !input.identityId) ||
      (input.scopeKind === 'CONTACT_WIDE' && input.identityId)
    ) {
      throw new TypeError(
        'scopeKind และ identityId ต้องผูกกันแบบ exact identity หรือ contact-wide',
      );
    }
    if (!Number.isInteger(input.policyVersion) || input.policyVersion < 1) {
      throw new RangeError('policyVersion ต้องเป็น positive integer');
    }
    if (!Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) {
      throw new RangeError('expectedVersion ต้องเป็น integer ตั้งแต่ 0');
    }
    sha256(input.policyContentDigest, 'policyContentDigest');
    const occurredAt = instant(input.occurredAt, 'occurredAt');
    const startsAt = instant(input.startsAt, 'startsAt');
    const expiresAt = instant(input.expiresAt, 'expiresAt');
    if (expiresAt <= startsAt) throw new RangeError('expiresAt ต้องอยู่หลัง startsAt');
    const allowedRuleCodes = [
      ...new Set(input.allowedRuleCodes.map((code) => nonEmpty(code, 'allowedRuleCodes'))),
    ].sort();
    if (allowedRuleCodes.length === 0)
      throw new RangeError('allowedRuleCodes ต้องมีอย่างน้อยหนึ่ง rule');

    const requestHash = stableDigest({
      tenantId: input.tenantId,
      contactId: input.contactId,
      identityId: input.identityId ?? null,
      scopeKind: input.scopeKind,
      channel: input.channel,
      purpose: input.purpose,
      sourceType: input.sourceType,
      sourceId: input.sourceId,
      allowedRuleCodes,
      policyId: input.policyId,
      policyVersion: input.policyVersion,
      policyContentDigest: input.policyContentDigest,
      registryVersion: input.registryVersion,
      startsAt: startsAt.toISOString(),
      expiresAt: expiresAt.toISOString(),
      tier: input.tier,
      reasonCode: input.reasonCode,
      ticketRef: input.ticketRef ?? null,
      evidenceRef: input.evidenceRef,
      actorRef: input.actorRef,
      occurredAt: occurredAt.toISOString(),
      exceptionId: input.exceptionId ?? null,
      renewsExceptionId: input.renewsExceptionId ?? null,
      expectedVersion: input.expectedVersion,
    });

    return withTenantDatabaseTransaction(this.database, input.tenantId, async (transaction) => {
      await transaction.$queryRaw(
        Prisma.sql`SELECT 1 FROM pg_advisory_xact_lock(hashtext(${`cg4-contact:${input.tenantId}:${input.contactId}`}))`,
      );

      const receipt = await transaction.cgCommandReceipt.findUnique({
        where: {
          tenantId_operation_idempotencyKey: {
            tenantId: input.tenantId,
            operation: 'CG4_EXCEPTION_RECORD',
            idempotencyKey: input.idempotencyKey,
          },
        },
      });
      if (receipt) {
        if (receipt.requestHash !== requestHash)
          throw new Cg3IdempotencyConflictError(input.idempotencyKey);
        return receipt.responseBody as unknown as RecordCg4ExceptionResult;
      }

      const contact = await transaction.contact.findFirst({
        where: { id: input.contactId, tenantId: input.tenantId },
        select: { id: true },
      });
      if (!contact) throw new Cg3ResourceNotFoundError();
      if (input.identityId) {
        const identity = await transaction.contactIdentity.findFirst({
          where: { id: input.identityId, tenantId: input.tenantId, contactId: input.contactId },
          select: { id: true },
        });
        if (!identity) throw new Cg3ResourceNotFoundError();
      }

      const policy = await transaction.cg4Policy.findFirst({
        where: { tenantId: input.tenantId, policyId: input.policyId, version: input.policyVersion },
        select: { content: true, contentDigest: true, registryVersion: true, status: true },
      });
      if (!policy) throw new Cg4PolicyBindingError('ไม่พบ policy version ใน active tenant');
      if (!['PUBLISHED', 'SCHEDULED', 'ACTIVE'].includes(policy.status)) {
        throw new Cg4PolicyBindingError(
          'exception ต้อง pin กับ policy ที่ published, scheduled หรือ active',
        );
      }
      if (
        policy.contentDigest !== input.policyContentDigest ||
        policy.registryVersion !== input.registryVersion
      ) {
        throw new Cg4PolicyBindingError(
          'policy digest หรือ registry version ไม่ตรงกับ pinned policy',
        );
      }
      const policyRules = policyAllowedRuleCodes(policy.content);
      const lifetimeSeconds = Math.floor((expiresAt.getTime() - startsAt.getTime()) / 1_000);
      const identityScope = input.scopeKind === 'IDENTITY' ? 'EXACT_IDENTITY' : 'CONTACT_WIDE';
      for (const ruleCode of allowedRuleCodes) {
        const eligibility = resolveCg4OverrideEligibility({
          ruleCode,
          mechanism: 'APPROVED_EXCEPTION',
          identityScope,
          policyAllowedRuleCodes: policyRules,
          riskTier: input.tier,
          requestedRuleCount: allowedRuleCodes.length,
          lifetimeSeconds,
        });
        if (!eligibility.eligible) {
          throw new Cg4PolicyBindingError(
            `rule ${ruleCode} ใช้ exception ไม่ได้: ${eligibility.reason}`,
          );
        }
      }

      const contactHead = await transaction.cg4ContactExceptionHead.findUnique({
        where: { tenantId_contactId: { tenantId: input.tenantId, contactId: input.contactId } },
      });
      const actualVersion = contactHead?.aggregateVersion ?? 0;
      if (actualVersion !== input.expectedVersion) {
        throw new Cg3VersionConflictError(input.expectedVersion, actualVersion);
      }

      const exceptionId = input.exceptionId ?? this.id();
      const exceptionHead = await transaction.cg4ExceptionHead.findUnique({
        where: { tenantId_exceptionId: { tenantId: input.tenantId, exceptionId } },
      });
      if (exceptionHead) {
        const previous = await transaction.cg4Exception.findFirst({
          where: {
            tenantId: input.tenantId,
            id: exceptionHead.currentRevisionId,
            contactId: input.contactId,
          },
          select: { id: true },
        });
        if (!previous) throw new Cg3ResourceNotFoundError();
        // CG4.4 (#187): only a PENDING series takes another content revision. Approved
        // content is immutable and a terminal series never reopens — changing either
        // means requesting a renewal series instead.
        if (exceptionHead.status !== 'PENDING') {
          throw new Cg4InvalidLifecycleTransitionError(exceptionHead.status, 'PENDING');
        }
      }

      // CG4.4 (#187): a renewal points back at the series it renews; it never extends it.
      if (input.renewsExceptionId) {
        const renewed = await transaction.cg4ExceptionHead.findUnique({
          where: {
            tenantId_exceptionId: {
              tenantId: input.tenantId,
              exceptionId: input.renewsExceptionId,
            },
          },
        });
        if (!renewed) throw new Cg3ResourceNotFoundError();
        const renewedRevision = await transaction.cg4Exception.findFirst({
          where: {
            tenantId: input.tenantId,
            id: renewed.currentRevisionId,
            contactId: input.contactId,
          },
          select: { id: true },
        });
        if (!renewedRevision) throw new Cg3ResourceNotFoundError();
      }

      const mutationId = this.id();
      const revision = (exceptionHead?.currentRevision ?? 0) + 1;
      const aggregateVersion = actualVersion + 1;
      const exception = await transaction.cg4Exception.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          exceptionId,
          revision,
          contactId: input.contactId,
          identityId: input.identityId,
          scopeKind: input.scopeKind,
          channel: input.channel,
          purpose: input.purpose,
          sourceType: input.sourceType,
          sourceId: input.sourceId,
          allowedRuleCodes,
          policyId: input.policyId,
          policyVersion: input.policyVersion,
          policyContentDigest: input.policyContentDigest,
          registryVersion: input.registryVersion,
          startsAt,
          expiresAt,
          tier: input.tier,
          status: 'PENDING',
          reasonCode: input.reasonCode,
          ticketRef: input.ticketRef,
          evidenceRef: input.evidenceRef,
          actorRef: input.actorRef,
          requestHash,
          supersedesId: exceptionHead?.currentRevisionId,
          renewsExceptionId: input.renewsExceptionId,
        },
      });
      const exceptionView = view(exception);
      const afterDigest = stableDigest({
        previous: contactHead?.currentDigest ?? null,
        exception: exceptionView,
      });

      if (exceptionHead) {
        await transaction.cg4ExceptionHead.update({
          where: { tenantId_exceptionId: { tenantId: input.tenantId, exceptionId } },
          data: { currentRevisionId: exception.id, currentRevision: revision, status: 'PENDING' },
        });
      } else {
        await transaction.cg4ExceptionHead.create({
          data: {
            id: this.id(),
            tenantId: input.tenantId,
            exceptionId,
            currentRevisionId: exception.id,
            currentRevision: revision,
            status: 'PENDING',
          },
        });
      }
      if (contactHead) {
        const updated = await transaction.cg4ContactExceptionHead.updateMany({
          where: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            aggregateVersion: input.expectedVersion,
          },
          data: { aggregateVersion, currentDigest: afterDigest, latestMutationId: mutationId },
        });
        if (updated.count !== 1)
          throw new Cg3VersionConflictError(input.expectedVersion, actualVersion);
      } else {
        await transaction.cg4ContactExceptionHead.create({
          data: {
            tenantId: input.tenantId,
            contactId: input.contactId,
            aggregateVersion,
            currentDigest: afterDigest,
            latestMutationId: mutationId,
          },
        });
      }

      const eventId = this.id();
      const payload = {
        contractVersion: 1,
        mutationId,
        subjectVersion: aggregateVersion,
        ...(input.identityId ? { identityId: input.identityId } : {}),
        affectedScope: {
          identityId: input.identityId ?? null,
          channel: input.channel,
          purpose: input.purpose,
          contactKind: null,
        },
        effectiveAt: startsAt.toISOString(),
        policyVersion: input.policyVersion,
        stateDigest: afterDigest,
      };
      await transaction.cgEventOutbox.create({
        data: {
          id: eventId,
          mutationId,
          tenantId: input.tenantId,
          aggregateType: 'CONTACT',
          aggregateId: input.contactId,
          aggregateVersion,
          eventType: 'exception.recorded',
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
          action: 'CG4_EXCEPTION_RECORDED',
          actorClass: 'COMPLIANCE',
          actorRef: input.actorRef,
          sourceKind: 'COMPLIANCE',
          evidenceRef: input.evidenceRef,
          beforeDigest: contactHead?.currentDigest,
          afterDigest,
          occurredAt,
        },
      });
      const result: RecordCg4ExceptionResult = {
        mutationId,
        eventId,
        aggregateVersion,
        exception: exceptionView,
      };
      await transaction.cgCommandReceipt.create({
        data: {
          id: this.id(),
          tenantId: input.tenantId,
          operation: 'CG4_EXCEPTION_RECORD',
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

  async history(query: Cg4ExceptionHistoryQuery): Promise<Cg4ExceptionView[]> {
    nonEmpty(query.tenantId, 'tenantId');
    nonEmpty(query.contactId, 'contactId');
    if (query.exceptionId) nonEmpty(query.exceptionId, 'exceptionId');
    return withTenantDatabaseTransaction(this.database, query.tenantId, async (transaction) => {
      const rows = await transaction.cg4Exception.findMany({
        where: {
          tenantId: query.tenantId,
          contactId: query.contactId,
          ...(query.exceptionId ? { exceptionId: query.exceptionId } : {}),
        },
        orderBy: [{ exceptionId: 'asc' }, { revision: 'asc' }],
      });
      return rows.map(view);
    });
  }
}
