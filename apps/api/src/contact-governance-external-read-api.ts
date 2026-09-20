import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import {
  BadRequestException,
  Controller,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Query,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { CG5_API_SCOPES, type ContactChannel } from '@d-contact/cxa-contracts';
import {
  cg4ContactExceptions,
  loadCg3Facts,
  PrismaCg5TenantConfigRepository,
  redactCg4Ref,
  resolveEffectivePreference,
  stableDigest,
  type Cg4EvidenceAccessLevel,
} from '@d-contact/contact-governance';
import { CONTACT_GOVERNANCE_DATABASE } from './contact-governance-tokens.js';
import { GatewayServiceScopes, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import { TenantClientRateLimiter } from './tenant-client-rate-limiter.js';
import type { VerifiedServiceIdentity } from '@d-contact/workspace-session';

export const CG5_TENANT_CLIENT_RATE_LIMITER = Symbol('CG5_TENANT_CLIENT_RATE_LIMITER');

const CONTACT_CHANNELS = new Set(['VOICE', 'WEBCHAT', 'LINE', 'FACEBOOK', 'WHATSAPP', 'EMAIL']);

export interface Cg5ExternalReadContext {
  tenantId: string;
  clientId: string;
  level: Cg4EvidenceAccessLevel;
}

function requiredUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `${field} ต้องเป็น UUID` });
  }
  return value;
}

function requiredString(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${field} ต้องมีความยาว 1-${maximum} ตัวอักษร`,
    });
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maximum = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field, maximum);
}

function requiredChannel(value: unknown): ContactChannel {
  const channel = requiredString(value, 'channel', 32);
  if (!CONTACT_CHANNELS.has(channel)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'channel ไม่ถูกต้อง' });
  }
  return channel as ContactChannel;
}

function serviceIdentity(request: AuthenticatedGatewayRequest): VerifiedServiceIdentity {
  const identity = request.gatewayServiceIdentity;
  if (!identity) throw new UnauthorizedException();
  return identity;
}

export function externalEtag(resource: string, value: unknown): string {
  return `"cg5-external:${resource}:${stableDigest(value).slice(0, 24)}"`;
}

export function setConditionalEtag(
  request: AuthenticatedGatewayRequest,
  response: ServerResponse,
  etag: string,
): boolean {
  response.setHeader('ETag', etag);
  const requested = request.headers['if-none-match'];
  const provided = Array.isArray(requested) ? requested[0] : requested;
  if (provided !== etag) return false;
  response.statusCode = HttpStatus.NOT_MODIFIED;
  return true;
}

/**
 * CG5.9 external read boundary. Tenant/client and evidence level are only taken from a
 * verified service token; request path/query/body never participate in that decision.
 */
export class Cg5ExternalReadService {
  private readonly config: PrismaCg5TenantConfigRepository;

  constructor(
    private readonly database: PrismaClient,
    private readonly limiter: TenantClientRateLimiter,
  ) {
    this.config = new PrismaCg5TenantConfigRepository(database);
  }

  async access(
    request: AuthenticatedGatewayRequest,
    response: ServerResponse,
  ): Promise<Cg5ExternalReadContext> {
    const identity = serviceIdentity(request);
    const snapshot = await this.config.read(identity.tenantId);
    const rejected = this.limiter.consume({
      tenantId: identity.tenantId,
      clientId: identity.clientId,
      limitPerMinute: snapshot.config.apiRateLimitPerMinute,
    });
    if (rejected) {
      response.setHeader('Retry-After', String(rejected.retryAfterSeconds));
      throw new HttpException(
        { code: 'GOVERNANCE_RATE_LIMITED', retryAfterSeconds: rejected.retryAfterSeconds },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    return {
      tenantId: identity.tenantId,
      clientId: identity.clientId,
      level: identity.scopes.includes(CG5_API_SCOPES.EVIDENCE) ? 'EVIDENCE' : 'SUMMARY',
    };
  }

  async recordEvidenceRead(
    context: Cg5ExternalReadContext,
    input: { aggregateId: string; aggregateVersion: number; resourceKind: string },
  ): Promise<void> {
    if (context.level !== 'EVIDENCE') return;
    await withTenantDatabaseTransaction(this.database, context.tenantId, (tx) =>
      tx.cgAuditLog.create({
        data: {
          tenantId: context.tenantId,
          mutationId: randomUUID(),
          aggregateType: 'CONTACT',
          aggregateId: input.aggregateId,
          aggregateVersion: input.aggregateVersion,
          action: 'CG5_EXTERNAL_EVIDENCE_READ',
          actorClass: 'SERVICE',
          actorRef: context.clientId,
          sourceKind: 'SYSTEM',
          evidenceRef: `cg5-external-read:${input.resourceKind}`,
          afterDigest: stableDigest({
            clientId: context.clientId,
            resourceKind: input.resourceKind,
            aggregateId: input.aggregateId,
            aggregateVersion: input.aggregateVersion,
          }),
          occurredAt: new Date(),
        },
      }),
    );
  }

  async contactStatus(
    context: Cg5ExternalReadContext,
    query: { contactId: string; channel: ContactChannel; purpose: string; contactKind?: string },
  ) {
    const now = new Date();
    const facts = await withTenantDatabaseTransaction(
      this.database,
      context.tenantId,
      (transaction) =>
        transaction.cgContactStateHead
          .findUnique({
            where: {
              tenantId_contactId: { tenantId: context.tenantId, contactId: query.contactId },
            },
            select: { aggregateVersion: true },
          })
          .then(async (head) => ({
            head,
            facts: await loadCg3Facts(transaction, {
              tenantId: context.tenantId,
              ...query,
              now,
            }),
          })),
    );
    const preference = resolveEffectivePreference(facts.facts.preferences, {
      now,
      channel: query.channel,
      purpose: query.purpose,
      contactKind: query.contactKind,
      preferences: facts.facts.preferences,
    });
    return {
      aggregateVersion: facts.head?.aggregateVersion ?? 0,
      ...(preference
        ? { preference: { decision: preference.decision, version: preference.version } }
        : {}),
      ...(facts.facts.activeCallback
        ? {
            callback: {
              channel: facts.facts.activeCallback.channel,
              purpose: facts.facts.activeCallback.purpose,
              expiresAt: facts.facts.activeCallback.expiresAt,
              hasApprovedException: facts.facts.activeCallback.approvedExceptionId !== null,
            },
          }
        : {}),
      activeExceptionCount: facts.facts.activeExceptions.length,
    };
  }

  async effectiveExceptions(context: Cg5ExternalReadContext, contactId: string) {
    const exceptions = await cg4ContactExceptions(
      this.database,
      { tenantId: context.tenantId, level: context.level },
      contactId,
    );
    return exceptions
      .filter((exception) => exception.effectiveState === 'EFFECTIVE')
      .map((exception) => ({
        seriesId: exception.seriesId,
        revision: exception.revision,
        scopeKind: exception.scopeKind,
        channel: exception.channel,
        purpose: exception.purpose,
        sourceType: exception.sourceType,
        policyId: exception.policyId,
        policyVersion: exception.policyVersion,
        startsAt: exception.startsAt,
        expiresAt: exception.expiresAt,
        riskTier: exception.riskTier,
        reasonCode: exception.reasonCode,
        ...(exception.ticketRef ? { ticketRef: exception.ticketRef } : {}),
        evidenceRef: exception.evidenceRef,
        actorRef: exception.actorRef,
      }));
  }
}

export function externalPolicyView(
  policy:
    | {
        policyId: string;
        version: number;
        purpose?: string;
        contactKind?: string;
        channel?: string;
        status: string;
        effectiveFrom: string;
        effectiveTo?: string;
        publishedAt?: string;
      }
    | undefined,
) {
  if (!policy) return undefined;
  return {
    policyId: policy.policyId,
    version: policy.version,
    ...(policy.purpose ? { purpose: policy.purpose } : {}),
    ...(policy.contactKind ? { contactKind: policy.contactKind } : {}),
    ...(policy.channel ? { channel: policy.channel } : {}),
    status: policy.status,
    effectiveFrom: policy.effectiveFrom,
    ...(policy.effectiveTo ? { effectiveTo: policy.effectiveTo } : {}),
    ...(policy.publishedAt ? { publishedAt: policy.publishedAt } : {}),
  };
}

export function externalDecisionView(
  decision: {
    decisionId: string;
    decision: string;
    reasonCode: string;
    policyVersion: number;
    gate: string;
    aggregateVersion?: number;
    preferenceVersion?: number;
    nextEligibleAt?: string;
    timezoneSource?: string;
    exceptionMode?: string;
    exceptionRef?: string;
    decidedAt: string;
  },
  level: Cg4EvidenceAccessLevel,
) {
  return {
    decisionId: decision.decisionId,
    decision: decision.decision,
    reasonCode: decision.reasonCode,
    policyVersion: decision.policyVersion,
    gate: decision.gate,
    ...(decision.aggregateVersion !== undefined
      ? { aggregateVersion: decision.aggregateVersion }
      : {}),
    ...(decision.preferenceVersion !== undefined
      ? { preferenceVersion: decision.preferenceVersion }
      : {}),
    ...(decision.nextEligibleAt ? { nextEligibleAt: decision.nextEligibleAt } : {}),
    ...(decision.timezoneSource ? { timezoneSource: decision.timezoneSource } : {}),
    ...(decision.exceptionMode ? { exceptionMode: decision.exceptionMode } : {}),
    ...(decision.exceptionRef ? { exceptionRef: redactCg4Ref(decision.exceptionRef, level) } : {}),
    decidedAt: decision.decidedAt,
  };
}

@Controller('api/v1/contact-governance/contacts')
export class ContactGovernanceExternalReadController {
  private readonly external: Cg5ExternalReadService;

  constructor(
    @Inject(CONTACT_GOVERNANCE_DATABASE) database: PrismaClient,
    @Inject(CG5_TENANT_CLIENT_RATE_LIMITER) limiter: TenantClientRateLimiter,
  ) {
    this.external = new Cg5ExternalReadService(database, limiter);
  }

  @Get(':contactId/status')
  @GatewayServiceScopes(CG5_API_SCOPES.READ)
  async status(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('contactId') contactId: string,
    @Query('channel') channel: unknown,
    @Query('purpose') purpose: unknown,
    @Query('contactKind') contactKind: unknown,
  ) {
    const context = await this.external.access(request, response);
    const view = await this.external.contactStatus(context, {
      contactId: requiredUuid(contactId, 'contactId'),
      channel: requiredChannel(channel),
      purpose: requiredString(purpose, 'purpose'),
      contactKind: optionalString(contactKind, 'contactKind'),
    });
    await this.external.recordEvidenceRead(context, {
      aggregateId: requiredUuid(contactId, 'contactId'),
      aggregateVersion: view.aggregateVersion,
      resourceKind: 'CONTACT_STATUS',
    });
    if (setConditionalEtag(request, response, externalEtag('contact-status', view)))
      return undefined;
    return view;
  }

  @Get(':contactId/effective-exceptions')
  @GatewayServiceScopes(CG5_API_SCOPES.READ)
  async effectiveExceptions(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('contactId') contactId: string,
  ) {
    const canonicalContactId = requiredUuid(contactId, 'contactId');
    const context = await this.external.access(request, response);
    const items = await this.external.effectiveExceptions(context, canonicalContactId);
    await this.external.recordEvidenceRead(context, {
      aggregateId: canonicalContactId,
      aggregateVersion: 0,
      resourceKind: 'EFFECTIVE_EXCEPTIONS',
    });
    const view = { items };
    if (setConditionalEtag(request, response, externalEtag('effective-exceptions', view))) {
      return undefined;
    }
    return view;
  }
}
