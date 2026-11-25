import type { ServerResponse } from 'node:http';
import {
  BadRequestException,
  Body,
  Controller,
  ConflictException,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import { CG5_API_SCOPES, type ContactChannel } from '@d-contact/cxa-contracts';
import {
  Cg3CallbackRepository,
  Cg3IdempotencyConflictError,
  Cg3InvalidLifecycleTransitionError,
  Cg3PreferenceRepository,
  Cg4DatabaseAuthorizationPort,
  Cg4PolicyLifecycleRepository,
  Cg3ResourceNotFoundError,
  Cg3SourceAuthorityConflictError,
  Cg3VersionConflictError,
  decisionById,
  effectivePolicy,
  loadCg3Facts,
  resolveEffectivePreference,
  type LocalTimeWindow,
} from '@d-contact/contact-governance';
import {
  GatewayRoles,
  GatewayServiceRoles,
  GatewayServiceScopes,
  type AuthenticatedGatewayRequest,
} from './gateway-auth.js';
import { mapCg4Error } from './contact-governance-cg4-api.js';
import { CONTACT_GOVERNANCE_DATABASE } from './contact-governance-tokens.js';
import {
  CG5_TENANT_CLIENT_RATE_LIMITER,
  Cg5ExternalReadService,
  externalDecisionView,
  externalEtag,
  externalPolicyView,
  setConditionalEtag,
} from './contact-governance-external-read-api.js';
import { TenantClientRateLimiter } from './tenant-client-rate-limiter.js';

export { CONTACT_GOVERNANCE_DATABASE } from './contact-governance-tokens.js';

const CONTACT_CHANNELS = new Set(['VOICE', 'WEBCHAT', 'LINE', 'FACEBOOK', 'WHATSAPP', 'EMAIL']);
const PRIVILEGED_ROLES = ['admin', 'compliance'];

// ---- shared validation/auth helpers ----------------------------------------

function requiredString(value: unknown, field: string, maximum = 256): string {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > maximum) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${field} must be 1-${maximum} characters long`,
    });
  }
  return value.trim();
}

function optionalString(value: unknown, field: string, maximum = 256): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, field, maximum);
}

function requiredChannel(value: unknown): ContactChannel {
  if (typeof value !== 'string' || !CONTACT_CHANNELS.has(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'channel is invalid' });
  }
  return value as ContactChannel;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${field} must be an integer`,
    });
  }
  return value as number;
}

function requiredWindows(value: unknown): LocalTimeWindow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException({
      code: 'WINDOW_INVALID',
      message: 'preferredWindows must be an array',
    });
  }
  return value as LocalTimeWindow[];
}

function requiredIdempotencyKey(request: AuthenticatedGatewayRequest): string {
  const header = request.headers['idempotency-key'];
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || value.trim().length === 0) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'header Idempotency-Key is required',
    });
  }
  return value.trim();
}

function requiredUuidParam(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${field} must be a UUID`,
    });
  }
  return value;
}

type Actor = { actorClass: string; actorRef: string; tenantId: string; isPrivileged: boolean };

/** Workspace identity only in this version — customer/service auth is still undecided (flagged S1.3 gap) */
function workspaceActor(request: AuthenticatedGatewayRequest): Actor {
  const identity = request.gatewayIdentity;
  if (!identity) throw new UnauthorizedException();
  const isPrivileged = identity.roles.some((role) => PRIVILEGED_ROLES.includes(role));
  const actorClass = identity.roles.includes('compliance')
    ? 'COMPLIANCE'
    : identity.roles.includes('admin')
      ? 'ADMIN'
      : 'AGENT';
  return { actorClass, actorRef: identity.userId, tenantId: identity.tenantId, isPrivileged };
}

function mapDomainError(error: unknown): never {
  if (error instanceof Cg3IdempotencyConflictError) {
    throw new ConflictException({ code: error.code, idempotencyKey: error.idempotencyKey });
  }
  if (error instanceof Cg3VersionConflictError) {
    throw new ConflictException({
      code: error.code,
      expectedVersion: error.expectedVersion,
      actualVersion: error.actualVersion,
    });
  }
  if (error instanceof Cg3ResourceNotFoundError) {
    // Always a generic message — never reveal whether the resource exists in another tenant
    throw new NotFoundException({ code: error.code });
  }
  if (error instanceof Cg3InvalidLifecycleTransitionError) {
    throw new UnprocessableEntityException({ code: error.code });
  }
  if (error instanceof Cg3SourceAuthorityConflictError) {
    throw new UnprocessableEntityException({ code: error.code });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    const message = error.message;
    const code = /timezone/i.test(message)
      ? 'TIMEZONE_INVALID'
      : /window/i.test(message)
        ? 'WINDOW_INVALID'
        : /scope/i.test(message)
          ? 'CALLBACK_SCOPE_INVALID'
          : 'VALIDATION_FAILED';
    throw new BadRequestException({ code, message });
  }
  throw new ServiceUnavailableException({ code: 'GOVERNANCE_STATE_UNAVAILABLE' });
}

// ---- POST /api/v1/contact-governance/preferences ---------------------------

@Controller('api/v1/contact-governance/preferences')
export class ContactGovernancePreferencesController {
  private readonly preferences: Cg3PreferenceRepository;

  constructor(@Inject(CONTACT_GOVERNANCE_DATABASE) database: PrismaClient) {
    this.preferences = new Cg3PreferenceRepository(database);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('agent', 'admin')
  @GatewayServiceRoles('contact-governance-source')
  async create(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const idempotencyKey = requiredIdempotencyKey(request);
    const candidate = (body ?? {}) as Record<string, unknown>;
    if (Object.hasOwn(candidate, 'tenantId')) {
      throw new BadRequestException({
        code: 'VALIDATION_FAILED',
        message: 'tenantId must come from a verified access token',
      });
    }

    const decision = requiredString(candidate.decision, 'decision');
    if (decision !== 'ALLOW' && decision !== 'BLOCK' && decision !== 'DEFER') {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'decision is invalid' });
    }

    // Dual-mode route: service principal (CRM/Flow sync) or workspace (Agent/Admin) — see gateway-auth.ts
    let tenantId: string;
    let sourceKind: string;
    let sourceVersion: string | undefined;
    let actorClass: string;
    let actorRef: string;
    if (request.gatewayServiceIdentity) {
      const identity = request.gatewayServiceIdentity;
      const bodySourceKind = requiredString(candidate.sourceKind, 'sourceKind');
      if (bodySourceKind !== 'CRM' && bodySourceKind !== 'FLOW') {
        throw new BadRequestException({
          code: 'VALIDATION_FAILED',
          message: 'sourceKind must be CRM or FLOW',
        });
      }
      tenantId = identity.tenantId;
      sourceKind = bodySourceKind;
      sourceVersion = requiredString(candidate.sourceVersion, 'sourceVersion');
      actorClass = bodySourceKind;
      actorRef = identity.clientId;
    } else {
      const actor = workspaceActor(request);
      if (decision === 'ALLOW' && !actor.isPrivileged) {
        throw new ForbiddenException({ code: 'PREFERENCE_RELAXATION_NOT_AUTHORIZED' });
      }
      tenantId = actor.tenantId;
      sourceKind = actor.actorClass === 'ADMIN' ? 'ADMIN' : 'AGENT';
      actorClass = actor.actorClass;
      actorRef = actor.actorRef;
    }

    try {
      return await this.preferences.append({
        tenantId,
        contactId: requiredString(candidate.contactId, 'contactId'),
        identityId: optionalString(candidate.identityId, 'identityId'),
        channel: candidate.channel !== undefined ? requiredChannel(candidate.channel) : undefined,
        purpose: optionalString(candidate.purpose, 'purpose'),
        contactKind: optionalString(candidate.contactKind, 'contactKind'),
        decision: decision as 'ALLOW' | 'BLOCK' | 'DEFER',
        timezone: optionalString(candidate.timezone, 'timezone'),
        preferredWindows: requiredWindows(candidate.preferredWindows),
        sourceKind: sourceKind as never,
        sourceVersion,
        occurredAt: requiredString(candidate.occurredAt, 'occurredAt'),
        effectiveFrom: requiredString(candidate.effectiveFrom, 'effectiveFrom'),
        effectiveTo: optionalString(candidate.effectiveTo, 'effectiveTo'),
        evidenceRef: requiredString(candidate.evidenceRef, 'evidenceRef'),
        actorClass,
        actorRef,
        idempotencyKey,
        expectedVersion: requiredInteger(candidate.expectedVersion, 'expectedVersion'),
        correlationId: request.correlationId ?? idempotencyKey,
      });
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Post(':id/revoke')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('agent', 'admin', 'compliance')
  async revoke(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = workspaceActor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const candidate = (body ?? {}) as Record<string, unknown>;

    try {
      return await this.preferences.revoke({
        tenantId: actor.tenantId,
        contactId: requiredString(candidate.contactId, 'contactId'),
        preferenceId: requiredUuidParam(id, 'id'),
        occurredAt: requiredString(candidate.occurredAt, 'occurredAt'),
        evidenceRef: requiredString(candidate.evidenceRef, 'evidenceRef'),
        actorClass: actor.actorClass,
        actorRef: actor.actorRef,
        idempotencyKey,
        expectedVersion: requiredInteger(candidate.expectedVersion, 'expectedVersion'),
        correlationId: request.correlationId ?? idempotencyKey,
      });
    } catch (error) {
      mapDomainError(error);
    }
  }
}

// ---- POST /api/v1/contact-governance/callback-requests ---------------------

@Controller('api/v1/contact-governance/callback-requests')
export class ContactGovernanceCallbackRequestsController {
  private readonly callbacks: Cg3CallbackRepository;

  constructor(@Inject(CONTACT_GOVERNANCE_DATABASE) database: PrismaClient) {
    this.callbacks = new Cg3CallbackRepository(database);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('agent', 'admin')
  async create(@Req() request: AuthenticatedGatewayRequest, @Body() body: unknown) {
    const actor = workspaceActor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const candidate = (body ?? {}) as Record<string, unknown>;

    try {
      return await this.callbacks.request({
        tenantId: actor.tenantId,
        contactId: requiredString(candidate.contactId, 'contactId'),
        identityId: optionalString(candidate.identityId, 'identityId'),
        channel: requiredChannel(candidate.channel),
        purpose: requiredString(candidate.purpose, 'purpose'),
        requestedAt: requiredString(candidate.requestedAt, 'requestedAt'),
        requestedTimezone: requiredString(candidate.requestedTimezone, 'requestedTimezone'),
        expiresAt: requiredString(candidate.expiresAt, 'expiresAt'),
        sourceKind: actor.actorClass === 'ADMIN' ? 'ADMIN' : 'AGENT',
        evidenceRef: requiredString(candidate.evidenceRef, 'evidenceRef'),
        actorClass: actor.actorClass,
        actorRef: actor.actorRef,
        idempotencyKey,
        expectedVersion: requiredInteger(candidate.expectedVersion, 'expectedVersion'),
        correlationId: request.correlationId ?? idempotencyKey,
      });
    } catch (error) {
      mapDomainError(error);
    }
  }
}

// ---- POST /api/v1/contact-governance/policies/:id/publish (compatibility alias) ----

export const LEGACY_POLICY_PUBLISH_SUCCESSOR =
  '/api/v1/contact-governance/policy-versions/{versionId}/publish';

/**
 * CG4.10 (#193): the old CG3 route stays as a compatibility alias during migration, but it goes through
 * the same CG4 validation/quorum/test/head transaction as its successor (#179 §2) — `approvalRef` is only
 * an evidence ref, not authority, so nothing that has not passed CG4 tests + quorum can be published.
 * Every response carries deprecation metadata; the route is removed in the next versioned API after the
 * compatibility window
 */
@Controller('api/v1/contact-governance/policies')
export class ContactGovernancePoliciesController {
  private readonly policies: Cg4PolicyLifecycleRepository;
  private readonly authorization: Cg4DatabaseAuthorizationPort;

  constructor(@Inject(CONTACT_GOVERNANCE_DATABASE) private readonly database: PrismaClient) {
    this.policies = new Cg4PolicyLifecycleRepository(database);
    this.authorization = new Cg4DatabaseAuthorizationPort(database);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('compliance')
  async publish(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const identity = request.gatewayIdentity;
    if (!identity) throw new UnauthorizedException();
    response.setHeader('Deprecation', 'true');
    response.setHeader('Link', `<${LEGACY_POLICY_PUBLISH_SUCCESSOR}>; rel="successor-version"`);
    const deprecation = { deprecated: true, successor: LEGACY_POLICY_PUBLISH_SUCCESSOR };

    const idempotencyKey = requiredIdempotencyKey(request);
    const candidate = (body ?? {}) as Record<string, unknown>;
    if (candidate.approvalRef === undefined || candidate.approvalRef === null) {
      throw new UnprocessableEntityException({ code: 'POLICY_APPROVAL_REQUIRED', deprecation });
    }
    const approvalRef = requiredString(candidate.approvalRef, 'approvalRef');
    const expectedVersion = requiredInteger(candidate.expectedVersion, 'expectedVersion');
    const rowId = requiredUuidParam(id, 'id');

    // The old id is a CG3 cg_policies row mapped by the backfill; a CG4 policy version id is accepted too
    const version = await withTenantDatabaseTransaction(
      this.database,
      identity.tenantId,
      (transaction) =>
        transaction.cg4Policy.findFirst({
          where: {
            tenantId: identity.tenantId,
            OR: [{ id: rowId }, { legacySourceRowId: rowId }],
          },
        }),
    );
    if (!version) {
      throw new UnprocessableEntityException({ code: 'LEGACY_POLICY_NOT_MIGRATED', deprecation });
    }
    if (version.version !== expectedVersion) {
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        expectedVersion,
        actualVersion: version.version,
      });
    }
    // A version without an approval binding has nothing for CG4 to check; once bound, always hand it to
    // publish so a retry with the same Idempotency-Key gets the same receipt, and the lifecycle itself
    // rejects other states
    if (
      !version.testArtifactDigest ||
      !version.approvalDigest ||
      version.baseHeadVersion === null ||
      !version.baseHeadDigest
    ) {
      throw new UnprocessableEntityException({
        code: 'POLICY_CG4_APPROVAL_REQUIRED',
        lifecycleState: version.status,
        policyVersionId: version.id,
        deprecation,
      });
    }

    let subject: Awaited<ReturnType<Cg4DatabaseAuthorizationPort['resolveSubject']>>;
    try {
      subject = await this.authorization.resolveSubject({
        tenantId: identity.tenantId as never,
        subjectId: identity.userId as never,
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'AUTHORIZATION_CONTEXT_UNAVAILABLE' });
    }
    if (!subject) throw new ForbiddenException({ code: 'CAPABILITY_REQUIRED' });

    try {
      // Expected bindings come from the approved version itself: publish still re-checks the digest, fresh
      // tests, quorum and head CAS in one transaction; if the head moved after approval it is a conflict
      const result = await this.policies.publish({
        tenantId: identity.tenantId,
        policyId: version.policyId,
        version: version.version,
        expectedContentDigest: version.contentDigest,
        expectedTestArtifactDigest: version.testArtifactDigest,
        expectedApprovalDigest: version.approvalDigest,
        expectedScopeHeadVersion: version.baseHeadVersion,
        expectedScopeHeadDigest: version.baseHeadDigest,
        actor: subject,
        evidenceRef: approvalRef,
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
      return { ...result, deprecation };
    } catch (error) {
      mapCg4Error(error);
    }
  }
}

// ---- GET /api/v1/contact-governance/contacts/:contactId/... ----------------

@Controller('api/v1/contact-governance/contacts')
export class ContactGovernanceContactQueryController {
  private readonly preferences: Cg3PreferenceRepository;
  private readonly callbacks: Cg3CallbackRepository;

  private readonly external: Cg5ExternalReadService;

  constructor(
    @Inject(CONTACT_GOVERNANCE_DATABASE) private readonly database: PrismaClient,
    @Inject(CG5_TENANT_CLIENT_RATE_LIMITER) limiter: TenantClientRateLimiter,
  ) {
    this.preferences = new Cg3PreferenceRepository(database);
    this.callbacks = new Cg3CallbackRepository(database);
    this.external = new Cg5ExternalReadService(database, limiter);
  }

  @Get(':contactId/preferences')
  @GatewayRoles('agent', 'admin', 'compliance')
  async history(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const actor = workspaceActor(request);
    try {
      const canonicalContactId = requiredUuidParam(contactId, 'contactId');
      const [preferences, callbacks, aggregateVersion] = await Promise.all([
        this.preferences.history({ tenantId: actor.tenantId, contactId: canonicalContactId }),
        this.callbacks.history({ tenantId: actor.tenantId, contactId: canonicalContactId }),
        this.preferences.aggregateVersion({
          tenantId: actor.tenantId,
          contactId: canonicalContactId,
        }),
      ]);
      response.setHeader('ETag', `cg-contact-v${aggregateVersion}`);
      return { preferences, callbacks };
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Get(':contactId/effective-policy')
  @GatewayRoles('agent', 'admin', 'compliance')
  @GatewayServiceScopes(CG5_API_SCOPES.READ)
  async effectivePolicy(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Query('channel') channel: unknown,
    @Query('purpose') purpose: unknown,
    @Query('contactKind') contactKind: unknown,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const canonicalContactId = requiredUuidParam(contactId, 'contactId');
    const query = {
      contactId: canonicalContactId,
      channel: requiredChannel(channel),
      purpose: requiredString(purpose, 'purpose'),
      contactKind: optionalString(contactKind, 'contactKind'),
    };
    try {
      if (request.gatewayServiceIdentity) {
        const context = await this.external.access(request, response);
        const result = await effectivePolicy(this.database, {
          tenantId: context.tenantId,
          ...query,
        });
        const view = { policy: externalPolicyView(result.policy), holidays: result.holidays };
        await this.external.recordEvidenceRead(context, {
          aggregateId: canonicalContactId,
          aggregateVersion: result.policy?.version ?? 0,
          resourceKind: 'EFFECTIVE_POLICY',
        });
        if (setConditionalEtag(request, response, externalEtag('effective-policy', view))) {
          return undefined;
        }
        return view;
      }
      const actor = workspaceActor(request);
      const result = await effectivePolicy(this.database, { tenantId: actor.tenantId, ...query });
      response.setHeader('ETag', `cg-contact-v${result.policy?.version ?? 0}`);
      return result;
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Get(':contactId/effective-preference')
  @GatewayRoles('agent', 'admin', 'compliance')
  @GatewayServiceScopes(CG5_API_SCOPES.READ)
  async effectivePreference(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Query('channel') channel: unknown,
    @Query('purpose') purpose: unknown,
    @Query('contactKind') contactKind: unknown,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const canonicalContactId = requiredUuidParam(contactId, 'contactId');
    const query = {
      contactId: canonicalContactId,
      channel: requiredChannel(channel),
      purpose: requiredString(purpose, 'purpose'),
      contactKind: optionalString(contactKind, 'contactKind'),
    };
    try {
      if (request.gatewayServiceIdentity) {
        const context = await this.external.access(request, response);
        const status = await this.external.contactStatus(context, query);
        const view = {
          aggregateVersion: status.aggregateVersion,
          ...(status.preference ? { preference: status.preference } : {}),
        };
        await this.external.recordEvidenceRead(context, {
          aggregateId: canonicalContactId,
          aggregateVersion: status.aggregateVersion,
          resourceKind: 'EFFECTIVE_PREFERENCE',
        });
        if (setConditionalEtag(request, response, externalEtag('effective-preference', view))) {
          return undefined;
        }
        return view;
      }
      const actor = workspaceActor(request);
      const now = new Date();
      const facts = await withTenantDatabaseTransaction(
        this.database,
        actor.tenantId,
        (transaction) => loadCg3Facts(transaction, { tenantId: actor.tenantId, ...query, now }),
      );
      const preference = resolveEffectivePreference(facts.preferences, {
        now,
        channel: query.channel,
        purpose: query.purpose,
        contactKind: query.contactKind,
        preferences: facts.preferences,
      });
      response.setHeader('ETag', `cg-contact-v${facts.aggregateVersion}`);
      return {
        aggregateVersion: facts.aggregateVersion,
        ...(preference
          ? { preference: { decision: preference.decision, version: preference.version } }
          : {}),
      };
    } catch (error) {
      mapDomainError(error);
    }
  }
}

// ---- GET /api/v1/contact-governance/decisions/:decisionId ------------------

@Controller('api/v1/contact-governance/decisions')
export class ContactGovernanceDecisionQueryController {
  private readonly external: Cg5ExternalReadService;

  constructor(
    @Inject(CONTACT_GOVERNANCE_DATABASE) private readonly database: PrismaClient,
    @Inject(CG5_TENANT_CLIENT_RATE_LIMITER) limiter: TenantClientRateLimiter,
  ) {
    this.external = new Cg5ExternalReadService(database, limiter);
  }

  @Get(':decisionId')
  @GatewayRoles('admin', 'compliance')
  @GatewayServiceScopes(CG5_API_SCOPES.READ)
  async find(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('decisionId') decisionId: string,
  ) {
    const canonicalDecisionId = requiredUuidParam(decisionId, 'decisionId');
    if (request.gatewayServiceIdentity) {
      const context = await this.external.access(request, response);
      const decision = await decisionById(this.database, {
        tenantId: context.tenantId,
        decisionId: canonicalDecisionId,
      });
      if (!decision) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
      const view = externalDecisionView(decision, context.level);
      await this.external.recordEvidenceRead(context, {
        aggregateId: canonicalDecisionId,
        aggregateVersion: decision.aggregateVersion ?? 0,
        resourceKind: 'DECISION',
      });
      if (setConditionalEtag(request, response, externalEtag('decision', view))) return undefined;
      return view;
    }
    const actor = workspaceActor(request);
    const decision = await decisionById(this.database, {
      tenantId: actor.tenantId,
      decisionId: canonicalDecisionId,
    });
    if (!decision) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return decision;
  }
}

// TODO(S1.3 gap): the "verified customer, own identity only" RBAC that #107 needs (customers editing
// their own preference/callback) has no auth mechanism in this repo yet — gateway-auth.ts only has
// workspace identity (Keycloak org login: agent/admin/compliance/platform-operator) and service
// identity (OAuth2 client_credentials: CRM/Flow), with no customer session/token shape. Customer
// routes stay closed in this version until a separate customer-auth decision (#103's Preference
// center frontend belongs to S1.8)
