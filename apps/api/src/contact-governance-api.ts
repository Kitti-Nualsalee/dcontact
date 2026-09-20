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
  if (typeof value !== 'string' || !CONTACT_CHANNELS.has(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'channel ไม่ถูกต้อง' });
  }
  return value as ContactChannel;
}

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${field} ต้องเป็นจำนวนเต็ม`,
    });
  }
  return value as number;
}

function requiredWindows(value: unknown): LocalTimeWindow[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new BadRequestException({
      code: 'WINDOW_INVALID',
      message: 'preferredWindows ต้องเป็น array',
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
      message: 'header Idempotency-Key ต้องระบุ',
    });
  }
  return value.trim();
}

function requiredUuidParam(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `${field} ต้องเป็น UUID` });
  }
  return value;
}

type Actor = { actorClass: string; actorRef: string; tenantId: string; isPrivileged: boolean };

/** เฉพาะ workspace identity เท่านั้นในเวอร์ชันนี้ — customer/service auth ยังไม่ decide (S1.3 gap ที่ flag ไว้) */
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
    // generic message เสมอ — ไม่เผยว่ามี resource อยู่ tenant อื่นหรือไม่
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
        message: 'tenantId ต้องมาจาก access token ที่ตรวจสอบแล้ว',
      });
    }

    const decision = requiredString(candidate.decision, 'decision');
    if (decision !== 'ALLOW' && decision !== 'BLOCK' && decision !== 'DEFER') {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'decision ไม่ถูกต้อง' });
    }

    // dual-mode route: service principal (CRM/Flow sync) หรือ workspace (Agent/Admin) — ดู gateway-auth.ts
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
          message: 'sourceKind ต้องเป็น CRM หรือ FLOW',
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
 * CG4.10 (#193): route เดิมของ CG3 คงไว้เป็น compatibility alias ระหว่าง migration แต่เข้า
 * CG4 validation/quorum/test/head transaction เดียวกับ successor (#179 §2) — `approvalRef` เป็นเพียง
 * evidence ref ไม่ใช่ authority จึง publish อะไรที่ยังไม่ผ่าน test + quorum ของ CG4 ไม่ได้
 * ทุก response มี deprecation metadata; route ถูกถอดใน versioned API ถัดไปหลัง compatibility window
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

    // id เดิมคือแถว cg_policies ของ CG3 ซึ่ง backfill map ไว้; รับ policy version id ของ CG4 ด้วย
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
    // version ที่ยังไม่มี binding ของ approval ไม่มีอะไรให้ CG4 ตรวจ; ถ้ามีแล้วส่งต่อให้ publish เสมอ
    // เพื่อให้ retry ด้วย Idempotency-Key เดิมได้ receipt เดิม และสถานะอื่นถูกปฏิเสธโดย lifecycle เอง
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
      // expected bindings มาจาก version ที่ approve ไว้เอง: publish ยังตรวจ digest, test ที่สด,
      // quorum และ head CAS ซ้ำใน transaction ทั้งหมด หาก head ขยับหลัง approve จะได้ conflict
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

// TODO(S1.3 gap): "verified customer, own identity only" RBAC ที่ #107 ต้องการ (customer
// self-service แก้ preference/callback ของตัวเอง) ยังไม่มี auth mechanism ใน repo นี้เลย —
// gateway-auth.ts มีแค่ workspace identity (Keycloak org login: agent/admin/compliance/
// platform-operator) กับ service identity (OAuth2 client_credentials: CRM/Flow) ไม่มี
// customer session/token shape ใดๆ ยังไม่เปิด customer route ในเวอร์ชันนี้ ต้องมี decision
// แยกเรื่อง customer auth (#103's Preference center frontend เป็นของ S1.8) ก่อนเปิดใช้งานจริง
