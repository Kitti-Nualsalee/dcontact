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
import type { PrismaClient } from '@d-contact/db';
import type { ContactChannel } from '@d-contact/cxa-contracts';
import {
  Cg3CallbackRepository,
  Cg3IdempotencyConflictError,
  Cg3InvalidLifecycleTransitionError,
  Cg3PolicyRepository,
  Cg3PreferenceRepository,
  Cg3ResourceNotFoundError,
  Cg3SourceAuthorityConflictError,
  Cg3VersionConflictError,
  decisionById,
  effectivePolicy,
  type LocalTimeWindow,
} from '@d-contact/contact-governance';
import {
  GatewayRoles,
  GatewayServiceRoles,
  type AuthenticatedGatewayRequest,
} from './gateway-auth.js';

export const CONTACT_GOVERNANCE_DATABASE = Symbol('CONTACT_GOVERNANCE_DATABASE');

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

// ---- POST /api/v1/contact-governance/policies/:id/publish ------------------

@Controller('api/v1/contact-governance/policies')
export class ContactGovernancePoliciesController {
  private readonly policies: Cg3PolicyRepository;

  constructor(@Inject(CONTACT_GOVERNANCE_DATABASE) database: PrismaClient) {
    this.policies = new Cg3PolicyRepository(database);
  }

  @Post(':id/publish')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('compliance')
  async publish(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('id') id: string,
    @Body() body: unknown,
  ) {
    const actor = workspaceActor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const candidate = (body ?? {}) as Record<string, unknown>;
    if (candidate.approvalRef === undefined || candidate.approvalRef === null) {
      throw new UnprocessableEntityException({ code: 'POLICY_APPROVAL_REQUIRED' });
    }

    try {
      return await this.policies.publish({
        tenantId: actor.tenantId,
        policyRowId: requiredUuidParam(id, 'id'),
        expectedVersion: requiredInteger(candidate.expectedVersion, 'expectedVersion'),
        checkerActorRef: actor.actorRef,
        approvalRef: requiredString(candidate.approvalRef, 'approvalRef'),
        idempotencyKey,
        actorClass: actor.actorClass,
        actorRef: actor.actorRef,
        correlationId: request.correlationId ?? idempotencyKey,
      });
    } catch (error) {
      mapDomainError(error);
    }
  }
}

// ---- GET /api/v1/contact-governance/contacts/:contactId/... ----------------

@Controller('api/v1/contact-governance/contacts')
export class ContactGovernanceContactQueryController {
  private readonly preferences: Cg3PreferenceRepository;

  constructor(@Inject(CONTACT_GOVERNANCE_DATABASE) private readonly database: PrismaClient) {
    this.preferences = new Cg3PreferenceRepository(database);
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
      const history = await this.preferences.history({
        tenantId: actor.tenantId,
        contactId: requiredUuidParam(contactId, 'contactId'),
      });
      const aggregateVersion = history[0]?.version ?? 0;
      response.setHeader('ETag', `cg-contact-v${aggregateVersion}`);
      return { preferences: history };
    } catch (error) {
      mapDomainError(error);
    }
  }

  @Get(':contactId/effective-policy')
  @GatewayRoles('agent', 'admin', 'compliance')
  async effectivePolicy(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('contactId') contactId: string,
    @Query('channel') channel: unknown,
    @Query('purpose') purpose: unknown,
    @Query('contactKind') contactKind: unknown,
    @Res({ passthrough: true }) response: ServerResponse,
  ) {
    const actor = workspaceActor(request);
    try {
      const result = await effectivePolicy(this.database, {
        tenantId: actor.tenantId,
        contactId: requiredUuidParam(contactId, 'contactId'),
        channel: requiredChannel(channel),
        purpose: requiredString(purpose, 'purpose'),
        contactKind: optionalString(contactKind, 'contactKind'),
      });
      response.setHeader('ETag', `cg-contact-v${result.policy?.version ?? 0}`);
      return result;
    } catch (error) {
      mapDomainError(error);
    }
  }
}

// ---- GET /api/v1/contact-governance/decisions/:decisionId ------------------

@Controller('api/v1/contact-governance/decisions')
export class ContactGovernanceDecisionQueryController {
  constructor(@Inject(CONTACT_GOVERNANCE_DATABASE) private readonly database: PrismaClient) {}

  @Get(':decisionId')
  @GatewayRoles('admin', 'compliance')
  async find(@Req() request: AuthenticatedGatewayRequest, @Param('decisionId') decisionId: string) {
    const actor = workspaceActor(request);
    const decision = await decisionById(this.database, {
      tenantId: actor.tenantId,
      decisionId: requiredUuidParam(decisionId, 'decisionId'),
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
