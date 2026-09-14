import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
  UnauthorizedException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { PrismaClient } from '@d-contact/db';
import type {
  Cg4ApprovalDecision,
  Cg4AuthorizationSubject,
  Cg4Capability,
  Cg4ExceptionRiskTier,
  Cg4SourceType,
  ContactChannel,
} from '@d-contact/cxa-contracts';
import {
  buildCg4PolicyScopeKey,
  assertCg4RequestAuthorization,
  Cg4ApprovalRepository,
  Cg4ApprovalStaleError,
  Cg4CapabilityRequiredError,
  Cg4DatabaseAuthorizationPort,
  Cg4DelegationNotAllowedError,
  Cg4DuplicateCheckerError,
  Cg4ExceptionLifecycleRepository,
  Cg4ExceptionScopeConflictError,
  Cg4FoundationRepository,
  Cg4InvalidLifecycleTransitionError,
  Cg4PolicyBindingError,
  Cg4PolicyLifecycleError,
  Cg4PolicyLifecycleRepository,
  Cg4PolicyValidationError,
  Cg4QuorumNotMetError,
  Cg4SelfApprovalError,
  Cg3IdempotencyConflictError,
  Cg3ResourceNotFoundError,
  Cg3VersionConflictError,
  cg4ContactExceptions,
  cg4EffectiveScope,
  cg4ExceptionApprovals,
  cg4ExceptionBySeriesId,
  cg4ExceptionHistory,
  cg4ExceptionMakerSubjectId,
  cg4KillSwitches,
  cg4PolicyApprovals,
  cg4PolicyMakerSubjectId,
  cg4PolicyTestArtifacts,
  cg4PolicyVersionById,
  cg4PolicyVersions,
  resolveCg4EvidenceAccess,
  type Cg4EvidenceAccessLevel,
  type Cg4EvidenceAccessSink,
  type Cg4PolicyFixturePack,
  type Cg4QueryContext,
} from '@d-contact/contact-governance';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';

export const CG4_DATABASE = Symbol('CG4_DATABASE');
export const CG4_EVIDENCE_ACCESS_SINK = Symbol('CG4_EVIDENCE_ACCESS_SINK');

/**
 * CG4.7 (#190): the frozen command/query surface from #179 §2.
 *
 * Three rules run through every route here. The tenant and the acting subject come from
 * the verified gateway identity and nowhere else — a body field naming a tenant or an
 * actor is ignored, not merged. The scope a capability is checked against is *derived
 * server-side from the resource*, never taken from the request, so a caller cannot aim a
 * command at a scope it happens to hold a grant for. And a resource that belongs to
 * another tenant is reported exactly like one that never existed.
 */

// ---- shared helpers --------------------------------------------------------

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

function requiredInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: `${field} ต้องเป็นจำนวนเต็ม`,
    });
  }
  return value as number;
}

function requiredInstant(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  if (Number.isNaN(new Date(raw).getTime())) {
    throw new BadRequestException({
      code: 'TIME_WINDOW_INVALID',
      message: `${field} ต้องเป็น ISO-8601 timestamp`,
    });
  }
  return raw;
}

function requiredDigest(value: unknown, field: string): string {
  const raw = requiredString(value, field, 64);
  if (!/^[a-f0-9]{64}$/.test(raw)) {
    throw new BadRequestException({ code: 'DIGEST_INVALID', message: `${field} ต้องเป็น SHA-256` });
  }
  return raw;
}

function requiredUuid(value: string, field: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: `${field} ต้องเป็น UUID` });
  }
  return value;
}

const CONTACT_CHANNELS = new Set(['VOICE', 'WEBCHAT', 'LINE', 'FACEBOOK', 'WHATSAPP', 'EMAIL']);
const SOURCE_TYPES = new Set([
  'JOURNEY',
  'CAMPAIGN',
  'DIALER',
  'CHANNEL',
  'SURVEY',
  'AGENT',
  'EXTERNAL',
]);
const RISK_TIERS = new Set(['STANDARD', 'HIGH', 'EMERGENCY']);

function requiredChannel(value: unknown): ContactChannel {
  const raw = requiredString(value, 'channel', 32);
  if (!CONTACT_CHANNELS.has(raw)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'channel ไม่ถูกต้อง' });
  }
  return raw as ContactChannel;
}

function requiredSourceType(value: unknown): Cg4SourceType {
  const raw = requiredString(value, 'sourceType', 32);
  if (!SOURCE_TYPES.has(raw)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'sourceType ไม่ถูกต้อง' });
  }
  return raw as Cg4SourceType;
}

function requiredRiskTier(value: unknown): Cg4ExceptionRiskTier {
  const raw = requiredString(value, 'riskTier', 16);
  if (!RISK_TIERS.has(raw)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'riskTier ไม่ถูกต้อง' });
  }
  return raw as Cg4ExceptionRiskTier;
}

function requiredDecision(value: unknown): Cg4ApprovalDecision {
  const raw = requiredString(value, 'decision', 16);
  if (raw !== 'APPROVE' && raw !== 'REJECT') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'decision ต้องเป็น APPROVE หรือ REJECT',
    });
  }
  return raw;
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

function body(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'body ต้องเป็น object' });
  }
  return value as Record<string, unknown>;
}

/** The tenant fixture pack is synthetic test data, not authority — shape-checked only. */
function requiredFixturePack(value: unknown): Cg4PolicyFixturePack {
  const pack = body(value);
  if (typeof pack.packId !== 'string' || typeof pack.suiteVersion !== 'string') {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'tenantPack ต้องมี packId และ suiteVersion',
    });
  }
  if (!Array.isArray(pack.checks)) {
    throw new BadRequestException({
      code: 'VALIDATION_FAILED',
      message: 'tenantPack.checks ต้องเป็น array',
    });
  }
  return pack as unknown as Cg4PolicyFixturePack;
}

function mapCg4Error(error: unknown): never {
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
  // Generic on purpose: a resource in another tenant must be indistinguishable from one
  // that never existed (#179 §3).
  if (error instanceof Cg3ResourceNotFoundError) throw new NotFoundException({ code: error.code });
  if (error instanceof Cg4CapabilityRequiredError) {
    throw new ForbiddenException({ code: error.code, capability: error.capability });
  }
  if (error instanceof Cg4SelfApprovalError) throw new ForbiddenException({ code: error.code });
  if (error instanceof Cg4DuplicateCheckerError) throw new ForbiddenException({ code: error.code });
  if (error instanceof Cg4DelegationNotAllowedError) {
    throw new ForbiddenException({ code: error.code });
  }
  if (error instanceof Cg4ApprovalStaleError) {
    throw new UnprocessableEntityException({ code: error.code });
  }
  if (error instanceof Cg4QuorumNotMetError) {
    throw new UnprocessableEntityException({
      code: error.code,
      required: error.required,
      current: error.current,
    });
  }
  if (error instanceof Cg4InvalidLifecycleTransitionError) {
    throw new UnprocessableEntityException({ code: error.code, from: error.from, to: error.to });
  }
  if (error instanceof Cg4ExceptionScopeConflictError) {
    throw new ConflictException({
      code: error.code,
      conflictingExceptionId: error.conflictingExceptionId,
    });
  }
  if (error instanceof Cg4PolicyLifecycleError) {
    const conflicts = ['POLICY_SCOPE_AMBIGUOUS', 'POLICY_HEAD_CONFLICT', 'SCHEDULE_CONFLICT'];
    if (conflicts.includes(error.code)) {
      throw new ConflictException({ code: error.code, message: error.message });
    }
    throw new UnprocessableEntityException({ code: error.code, message: error.message });
  }
  if (error instanceof Cg4PolicyValidationError) {
    if (error.code === 'NON_OVERRIDABLE_RULE' || error.code === 'POLICY_VERSION_UNSUPPORTED') {
      throw new UnprocessableEntityException({ code: error.code, message: error.message });
    }
    throw new BadRequestException({ code: error.code, message: error.message });
  }
  if (error instanceof Cg4PolicyBindingError) {
    throw new BadRequestException({ code: error.code, message: error.message });
  }
  if (error instanceof TypeError || error instanceof RangeError) {
    throw new BadRequestException({ code: 'VALIDATION_FAILED', message: error.message });
  }
  throw new ServiceUnavailableException({ code: 'GOVERNANCE_STATE_UNAVAILABLE' });
}

interface Cg4ActorContext {
  tenantId: string;
  subject: Cg4AuthorizationSubject;
  level: Cg4EvidenceAccessLevel;
  correlationId: string;
}

function setEtag(response: ServerResponse, etag: string | undefined): void {
  if (etag) response.setHeader('etag', etag);
}

// ---- base controller -------------------------------------------------------

abstract class Cg4ControllerBase {
  protected readonly authorization: Cg4DatabaseAuthorizationPort;

  constructor(
    protected readonly database: PrismaClient,
    protected readonly evidenceAccess: Cg4EvidenceAccessSink,
  ) {
    this.authorization = new Cg4DatabaseAuthorizationPort(database);
  }

  /**
   * Resolves the acting subject from the verified identity through the IAM port. The
   * gateway proves *who* is asking; only the port says what they may do, so no route can
   * accept a capability, role or tenant from the request itself (#173 §1).
   */
  protected async actor(request: AuthenticatedGatewayRequest): Promise<Cg4ActorContext> {
    const identity = request.gatewayIdentity;
    if (!identity) throw new UnauthorizedException();
    let subject: Cg4AuthorizationSubject | null;
    try {
      subject = await this.authorization.resolveSubject({
        tenantId: identity.tenantId as never,
        subjectId: identity.userId as never,
      });
    } catch {
      // The authorization store is unreachable: fail closed rather than assume anything.
      throw new ServiceUnavailableException({ code: 'AUTHORIZATION_CONTEXT_UNAVAILABLE' });
    }
    if (!subject) throw new ForbiddenException({ code: 'CAPABILITY_REQUIRED' });
    return {
      tenantId: identity.tenantId,
      subject,
      level: resolveCg4EvidenceAccess({ capabilities: subject.capabilities }),
      correlationId: request.correlationId ?? 'unknown',
    };
  }

  protected queryContext(actor: Cg4ActorContext): Cg4QueryContext {
    return { tenantId: actor.tenantId, level: actor.level };
  }

  /** Records that evidence-level data was served, so evidence access is itself auditable. */
  protected async auditEvidence(
    actor: Cg4ActorContext,
    resourceKind: 'EXCEPTION' | 'POLICY_VERSION' | 'DECISION' | 'KILL_SWITCH',
    resourceId: string,
  ): Promise<void> {
    if (actor.level !== 'EVIDENCE') return;
    await this.evidenceAccess.record({
      tenantId: actor.tenantId,
      viewerSubjectId: actor.subject.subjectId,
      resourceKind,
      resourceId,
      level: actor.level,
      occurredAt: new Date().toISOString(),
    });
  }
}

// ---- exceptions ------------------------------------------------------------

/**
 * Derived server-side from the resource's own scope. A caller that could name its own
 * scope key could aim any command at whichever scope it holds a grant for.
 */
function exceptionScopeKey(input: { channel: string; purpose: string }): string {
  return buildCg4PolicyScopeKey({ channel: input.channel, purpose: input.purpose });
}

@Controller('api/v1/contact-governance/exceptions')
export class ContactGovernanceCg4ExceptionController extends Cg4ControllerBase {
  private readonly foundation: Cg4FoundationRepository;
  private readonly approvals: Cg4ApprovalRepository;
  private readonly lifecycle: Cg4ExceptionLifecycleRepository;

  constructor(
    @Inject(CG4_DATABASE) database: PrismaClient,
    @Inject(CG4_EVIDENCE_ACCESS_SINK) evidenceAccess: Cg4EvidenceAccessSink,
  ) {
    super(database, evidenceAccess);
    this.foundation = new Cg4FoundationRepository(database);
    this.approvals = new Cg4ApprovalRepository(database);
    this.lifecycle = new Cg4ExceptionLifecycleRepository(database);
  }

  private async loadSeries(actor: Cg4ActorContext, seriesId: string) {
    const view = await cg4ExceptionBySeriesId(this.database, this.queryContext(actor), seriesId);
    if (!view) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return view;
  }

  /**
   * Shared by request / amend / renew: all three record an append-only revision, and
   * differ only in whether a series id or a renewal reference is bound to it.
   */
  private async recordRevision(
    actor: Cg4ActorContext,
    idempotencyKey: string,
    input: Record<string, unknown>,
    bind: { seriesId?: string; renewsSeriesId?: string } = {},
  ) {
    const channel = requiredChannel(input.channel);
    const purpose = requiredString(input.purpose, 'purpose');
    const scopeKey = exceptionScopeKey({ channel, purpose });
    try {
      // `Cg4FoundationRepository` is CG4.2 code that takes no actor, so the domain
      // capability recheck #190 requires happens here, against the server-derived scope.
      assertCg4RequestAuthorization({
        subject: actor.subject,
        capability: 'cg.exception.request',
        scopeKey,
        now: new Date(),
      });
      const result = await this.foundation.recordException({
        tenantId: actor.tenantId,
        contactId: requiredUuid(requiredString(input.contactId, 'contactId'), 'contactId'),
        ...(input.identityId
          ? {
              identityId: requiredUuid(
                requiredString(input.identityId, 'identityId'),
                'identityId',
              ),
            }
          : {}),
        scopeKind: input.identityId ? 'IDENTITY' : 'CONTACT_WIDE',
        channel,
        purpose,
        sourceType: requiredSourceType(input.sourceType),
        sourceId: requiredString(input.sourceId, 'sourceId'),
        allowedRuleCodes: Array.isArray(input.allowedRuleCodes)
          ? (input.allowedRuleCodes as string[])
          : [],
        policyId: requiredUuid(requiredString(input.policyId, 'policyId'), 'policyId'),
        policyVersion: requiredInteger(input.policyVersion, 'policyVersion'),
        policyContentDigest: requiredDigest(input.policyContentDigest, 'policyContentDigest'),
        registryVersion: requiredString(input.registryVersion, 'registryVersion'),
        startsAt: requiredInstant(input.startsAt, 'startsAt'),
        expiresAt: requiredInstant(input.expiresAt, 'expiresAt'),
        tier: requiredRiskTier(input.riskTier),
        reasonCode: requiredString(input.reasonCode, 'reasonCode'),
        ...(input.ticketRef ? { ticketRef: requiredString(input.ticketRef, 'ticketRef') } : {}),
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        // The maker is the verified subject, never a body field.
        actorRef: actor.subject.subjectId,
        // Declared by the caller, not read from the server clock: the command receipt
        // hashes it, so a server timestamp would make an honest retry look like a
        // different request and fail with IDEMPOTENCY_CONFLICT.
        occurredAt: requiredInstant(input.occurredAt, 'occurredAt'),
        ...(bind.seriesId ? { exceptionId: bind.seriesId } : {}),
        ...(bind.renewsSeriesId ? { renewsExceptionId: bind.renewsSeriesId } : {}),
        idempotencyKey,
        expectedVersion: requiredInteger(input.expectedVersion, 'expectedVersion'),
      });
      return {
        mutationId: result.mutationId,
        seriesId: result.exception.exceptionId,
        revisionId: result.exception.id,
        revision: result.exception.revision,
        aggregateVersion: result.aggregateVersion,
        workflowState: result.exception.status,
        riskTier: result.exception.tier,
        contentDigest: result.exception.policyContentDigest,
        scopeKey,
        etag: `"cg4-exception:${result.exception.exceptionId}:${result.exception.revision}"`,
      };
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('admin', 'compliance')
  async request(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const result = await this.recordRevision(actor, requiredIdempotencyKey(request), body(payload));
    setEtag(response, result.etag);
    return result;
  }

  @Post(':seriesId/revisions')
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('admin', 'compliance')
  async amend(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('seriesId') seriesId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const existing = await this.loadSeries(actor, requiredUuid(seriesId, 'seriesId'));
    const result = await this.recordRevision(
      actor,
      requiredIdempotencyKey(request),
      body(payload),
      { seriesId: existing.seriesId },
    );
    setEtag(response, result.etag);
    return result;
  }

  @Post(':seriesId/renewals')
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('admin', 'compliance')
  async renew(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('seriesId') seriesId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const existing = await this.loadSeries(actor, requiredUuid(seriesId, 'seriesId'));
    // A renewal is always a NEW series bound back to the one it renews (#177 §2).
    const result = await this.recordRevision(
      actor,
      requiredIdempotencyKey(request),
      body(payload),
      { renewsSeriesId: existing.seriesId },
    );
    setEtag(response, result.etag);
    return result;
  }

  @Post(':seriesId/approvals')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('admin', 'compliance')
  async decide(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('seriesId') seriesId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const series = await this.loadSeries(actor, requiredUuid(seriesId, 'seriesId'));
    const decision = requiredDecision(input.decision);
    const expectedRevision = requiredInteger(input.expectedRevision, 'expectedRevision');
    const expectedContentDigest = requiredDigest(
      input.expectedContentDigest,
      'expectedContentDigest',
    );
    const scopeKey = exceptionScopeKey(series);

    try {
      const vote = await this.approvals.recordExceptionApproval({
        tenantId: actor.tenantId,
        exceptionId: series.seriesId,
        expectedRevision,
        expectedContentDigest,
        decision,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        // Canonical maker, read outside the redaction path: this value is compared, not
        // shown, and the caller is usually the person who must not match it.
        makerSubjectId:
          (await cg4ExceptionMakerSubjectId(
            this.database,
            actor.tenantId,
            series.seriesId,
            expectedRevision,
          )) ?? '',
        scopeKey,
        checker: actor.subject,
        idempotencyKey,
      });

      // Recording a vote is not activation: the head only moves when quorum is actually
      // met, and a REJECT is terminal for the revision (#173 §2).
      const shouldFinalize = decision === 'REJECT' || vote.quorum.status === 'MET';
      if (!shouldFinalize) {
        return { seriesId: series.seriesId, revision: expectedRevision, quorum: vote.quorum };
      }
      const transition = await this.lifecycle.transition({
        tenantId: actor.tenantId,
        exceptionId: series.seriesId,
        expectedRevision,
        expectedContentDigest,
        action: decision === 'APPROVE' ? 'APPROVE' : 'REJECT',
        reasonCode: optionalString(input.reasonCode, 'reasonCode') ?? 'CHECKER_DECISION',
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        actor: actor.subject,
        scopeKey,
        occurredAt: new Date().toISOString(),
        expectedVersion: requiredInteger(input.expectedVersion, 'expectedVersion'),
        idempotencyKey: `${idempotencyKey}:finalize`,
      });
      return { ...transition, seriesId: series.seriesId, quorum: transition.quorum ?? vote.quorum };
    } catch (error) {
      mapCg4Error(error);
    }
  }

  private async transition(
    request: AuthenticatedGatewayRequest,
    seriesId: string,
    payload: unknown,
    action: 'CANCEL' | 'REVOKE',
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const series = await this.loadSeries(actor, requiredUuid(seriesId, 'seriesId'));
    try {
      return await this.lifecycle.transition({
        tenantId: actor.tenantId,
        exceptionId: series.seriesId,
        expectedRevision: requiredInteger(input.expectedRevision, 'expectedRevision'),
        expectedContentDigest: requiredDigest(input.expectedContentDigest, 'expectedContentDigest'),
        action,
        reasonCode: requiredString(input.reasonCode, 'reasonCode'),
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        actor: actor.subject,
        scopeKey: exceptionScopeKey(series),
        occurredAt: new Date().toISOString(),
        expectedVersion: requiredInteger(input.expectedVersion, 'expectedVersion'),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':seriesId/cancel')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('admin', 'compliance')
  async cancel(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('seriesId') seriesId: string,
    @Body() payload: unknown,
  ) {
    return this.transition(request, seriesId, payload, 'CANCEL');
  }

  @Post(':seriesId/revoke')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('admin', 'compliance')
  async revoke(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('seriesId') seriesId: string,
    @Body() payload: unknown,
  ) {
    return this.transition(request, seriesId, payload, 'REVOKE');
  }

  @Get(':seriesId')
  @GatewayRoles('admin', 'compliance')
  async find(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('seriesId') seriesId: string,
  ) {
    const actor = await this.actor(request);
    const view = await this.loadSeries(actor, requiredUuid(seriesId, 'seriesId'));
    await this.auditEvidence(actor, 'EXCEPTION', view.seriesId);
    setEtag(response, view.etag);
    return view;
  }

  @Get(':seriesId/history')
  @GatewayRoles('admin', 'compliance')
  async history(@Req() request: AuthenticatedGatewayRequest, @Param('seriesId') seriesId: string) {
    const actor = await this.actor(request);
    const id = requiredUuid(seriesId, 'seriesId');
    const revisions = await cg4ExceptionHistory(this.database, this.queryContext(actor), id);
    if (revisions.length === 0) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    await this.auditEvidence(actor, 'EXCEPTION', id);
    return { seriesId: id, revisions };
  }

  @Get(':seriesId/approvals')
  @GatewayRoles('admin', 'compliance')
  async approvalsFor(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('seriesId') seriesId: string,
    @Query('revision') revision: string,
  ) {
    const actor = await this.actor(request);
    const series = await this.loadSeries(actor, requiredUuid(seriesId, 'seriesId'));
    const wanted = revision ? Number(revision) : series.revision;
    if (!Number.isInteger(wanted)) {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'revision ไม่ถูกต้อง' });
    }
    await this.auditEvidence(actor, 'EXCEPTION', series.seriesId);
    return {
      seriesId: series.seriesId,
      revision: wanted,
      approvals: await cg4ExceptionApprovals(
        this.database,
        this.queryContext(actor),
        series.seriesId,
        wanted,
      ),
    };
  }
}

@Controller('api/v1/contact-governance/contacts')
export class ContactGovernanceCg4ContactQueryController extends Cg4ControllerBase {
  constructor(
    @Inject(CG4_DATABASE) database: PrismaClient,
    @Inject(CG4_EVIDENCE_ACCESS_SINK) evidenceAccess: Cg4EvidenceAccessSink,
  ) {
    super(database, evidenceAccess);
  }

  @Get(':contactId/exceptions')
  @GatewayRoles('admin', 'compliance')
  async list(@Req() request: AuthenticatedGatewayRequest, @Param('contactId') contactId: string) {
    const actor = await this.actor(request);
    const id = requiredUuid(contactId, 'contactId');
    const exceptions = await cg4ContactExceptions(this.database, this.queryContext(actor), id);
    await this.auditEvidence(actor, 'EXCEPTION', id);
    return { contactId: id, exceptions };
  }
}

// ---- policies --------------------------------------------------------------

@Controller('api/v1/contact-governance/policies')
export class ContactGovernanceCg4PolicyController extends Cg4ControllerBase {
  private readonly policies: Cg4PolicyLifecycleRepository;

  constructor(
    @Inject(CG4_DATABASE) database: PrismaClient,
    @Inject(CG4_EVIDENCE_ACCESS_SINK) evidenceAccess: Cg4EvidenceAccessSink,
  ) {
    super(database, evidenceAccess);
    this.policies = new Cg4PolicyLifecycleRepository(database);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('admin', 'compliance')
  async createSeries(@Req() request: AuthenticatedGatewayRequest, @Body() payload: unknown) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const scope = body(input.scope ?? {});
    try {
      return await this.policies.createDraft({
        tenantId: actor.tenantId,
        scopeKey: buildCg4PolicyScopeKey({
          ...(scope.channel ? { channel: requiredChannel(scope.channel) } : {}),
          ...(scope.purpose ? { purpose: requiredString(scope.purpose, 'scope.purpose') } : {}),
          ...(scope.contactKind
            ? { contactKind: requiredString(scope.contactKind, 'scope.contactKind') }
            : {}),
          ...(scope.sourceType ? { sourceType: requiredSourceType(scope.sourceType) } : {}),
        }),
        content: input.content,
        effectiveFrom: requiredInstant(input.effectiveFrom, 'effectiveFrom'),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':policyId/versions')
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('admin', 'compliance')
  async createVersion(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('policyId') policyId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const id = requiredUuid(policyId, 'policyId');
    const versions = await cg4PolicyVersions(this.database, this.queryContext(actor), id);
    const latest = versions.at(-1);
    if (!latest) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    try {
      return await this.policies.createDraft({
        tenantId: actor.tenantId,
        policyId: id,
        // The scope is fixed at series creation; a scope change is a new series (#176 §1).
        scopeKey: latest.scopeKey,
        content: input.content,
        effectiveFrom: requiredInstant(input.effectiveFrom, 'effectiveFrom'),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':policyId/rollbacks')
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('compliance')
  async rollback(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('policyId') policyId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    try {
      return await this.policies.rollback({
        tenantId: actor.tenantId,
        policyId: requiredUuid(policyId, 'policyId'),
        sourceVersion: requiredInteger(input.sourceVersion, 'sourceVersion'),
        expectedSourceContentDigest: requiredDigest(
          input.expectedSourceContentDigest,
          'expectedSourceContentDigest',
        ),
        reasonCode: requiredString(input.reasonCode, 'reasonCode'),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Get(':policyId/versions')
  @GatewayRoles('admin', 'compliance')
  async listVersions(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('policyId') policyId: string,
  ) {
    const actor = await this.actor(request);
    const id = requiredUuid(policyId, 'policyId');
    const versions = await cg4PolicyVersions(this.database, this.queryContext(actor), id);
    if (versions.length === 0) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return { policyId: id, versions };
  }
}

@Controller('api/v1/contact-governance/policy-versions')
export class ContactGovernanceCg4PolicyVersionController extends Cg4ControllerBase {
  private readonly policies: Cg4PolicyLifecycleRepository;
  private readonly approvals: Cg4ApprovalRepository;

  constructor(
    @Inject(CG4_DATABASE) database: PrismaClient,
    @Inject(CG4_EVIDENCE_ACCESS_SINK) evidenceAccess: Cg4EvidenceAccessSink,
  ) {
    super(database, evidenceAccess);
    this.policies = new Cg4PolicyLifecycleRepository(database);
    this.approvals = new Cg4ApprovalRepository(database);
  }

  private async loadVersion(actor: Cg4ActorContext, versionId: string) {
    const view = await cg4PolicyVersionById(this.database, this.queryContext(actor), versionId);
    if (!view) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    return view;
  }

  @Patch(':versionId')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('admin', 'compliance')
  async amend(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('versionId') versionId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const version = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    try {
      return await this.policies.amendDraft({
        tenantId: actor.tenantId,
        policyId: version.policyId,
        version: version.version,
        expectedDraftRevision: requiredInteger(
          input.expectedDraftRevision,
          'expectedDraftRevision',
        ),
        content: input.content,
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':versionId/preview')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('admin', 'compliance')
  async preview(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('versionId') versionId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const input = body(payload);
    const version = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    try {
      return await this.policies.preview({
        tenantId: actor.tenantId,
        policyId: version.policyId,
        version: version.version,
        expectedContentDigest: requiredDigest(input.expectedContentDigest, 'expectedContentDigest'),
        tenantPack: requiredFixturePack(input.tenantPack),
        pinnedEvaluationTime: requiredInstant(input.pinnedEvaluationTime, 'pinnedEvaluationTime'),
        pinnedTimezone: requiredString(input.pinnedTimezone, 'pinnedTimezone', 64),
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':versionId/tests')
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('admin', 'compliance')
  async runTests(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('versionId') versionId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const version = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    try {
      const result = await this.policies.runTests({
        tenantId: actor.tenantId,
        policyId: version.policyId,
        version: version.version,
        expectedContentDigest: requiredDigest(input.expectedContentDigest, 'expectedContentDigest'),
        tenantPack: requiredFixturePack(input.tenantPack),
        pinnedEvaluationTime: requiredInstant(input.pinnedEvaluationTime, 'pinnedEvaluationTime'),
        pinnedTimezone: requiredString(input.pinnedTimezone, 'pinnedTimezone', 64),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
      // The per-check detail can carry failure text; the digests are what binds anyway.
      return {
        mutationId: result.mutationId,
        policyId: result.policyId,
        version: result.version,
        artifactId: result.artifactId,
        artifactDigest: result.preview.artifactDigest,
        diffClass: result.preview.diffClass,
        outcome: result.preview.tests.outcome,
        passed: result.preview.tests.passed,
        failed: result.preview.tests.failed,
        baseHeadVersion: result.preview.baseHeadVersion,
        baseHeadDigest: result.preview.baseHeadDigest,
      };
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':versionId/submit')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('admin', 'compliance')
  async submit(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('versionId') versionId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const version = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    try {
      return await this.policies.submit({
        tenantId: actor.tenantId,
        policyId: version.policyId,
        version: version.version,
        expectedDraftRevision: requiredInteger(
          input.expectedDraftRevision,
          'expectedDraftRevision',
        ),
        expectedContentDigest: requiredDigest(input.expectedContentDigest, 'expectedContentDigest'),
        expectedTestArtifactDigest: requiredDigest(
          input.expectedTestArtifactDigest,
          'expectedTestArtifactDigest',
        ),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':versionId/approvals')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('compliance')
  async decide(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('versionId') versionId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const version = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    if (!version.diffClass) {
      throw new UnprocessableEntityException({ code: 'POLICY_TESTS_REQUIRED' });
    }
    const decision = requiredDecision(input.decision);
    try {
      const vote = await this.approvals.recordPolicyApproval({
        tenantId: actor.tenantId,
        policyId: version.policyId,
        expectedVersion: version.version,
        expectedContentDigest: requiredDigest(input.expectedContentDigest, 'expectedContentDigest'),
        diffClass: version.diffClass,
        decision,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        // Canonical maker, read outside the redaction path (see the exception path).
        makerSubjectId:
          (await cg4PolicyMakerSubjectId(
            this.database,
            actor.tenantId,
            version.policyId,
            version.version,
          )) ?? '',
        scopeKey: version.scopeKey,
        checker: actor.subject,
        idempotencyKey,
      });
      const shouldFinalize = decision === 'REJECT' || vote.quorum.status === 'MET';
      if (!shouldFinalize) {
        return {
          policyId: version.policyId,
          version: version.version,
          quorum: vote.quorum,
          lifecycleState: version.lifecycleState,
        };
      }
      return await this.policies.finalizeApproval({
        tenantId: actor.tenantId,
        policyId: version.policyId,
        version: version.version,
        expectedContentDigest: requiredDigest(input.expectedContentDigest, 'expectedContentDigest'),
        expectedTestArtifactDigest: requiredDigest(
          input.expectedTestArtifactDigest,
          'expectedTestArtifactDigest',
        ),
        expectedDiffClass: version.diffClass,
        expectedScopeHeadVersion: requiredInteger(
          input.expectedScopeHeadVersion,
          'expectedScopeHeadVersion',
        ),
        expectedScopeHeadDigest: requiredDigest(
          input.expectedScopeHeadDigest,
          'expectedScopeHeadDigest',
        ),
        activateAt: requiredInstant(input.activateAt, 'activateAt'),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey: `${idempotencyKey}:finalize`,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':versionId/publish')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('compliance')
  async publish(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('versionId') versionId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const version = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    try {
      return await this.policies.publish({
        tenantId: actor.tenantId,
        policyId: version.policyId,
        version: version.version,
        expectedContentDigest: requiredDigest(input.expectedContentDigest, 'expectedContentDigest'),
        expectedTestArtifactDigest: requiredDigest(
          input.expectedTestArtifactDigest,
          'expectedTestArtifactDigest',
        ),
        expectedApprovalDigest: requiredDigest(
          input.expectedApprovalDigest,
          'expectedApprovalDigest',
        ),
        expectedScopeHeadVersion: requiredInteger(
          input.expectedScopeHeadVersion,
          'expectedScopeHeadVersion',
        ),
        expectedScopeHeadDigest: requiredDigest(
          input.expectedScopeHeadDigest,
          'expectedScopeHeadDigest',
        ),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Get(':versionId')
  @GatewayRoles('admin', 'compliance')
  async find(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('versionId') versionId: string,
  ) {
    const actor = await this.actor(request);
    const view = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    await this.auditEvidence(actor, 'POLICY_VERSION', view.policyVersionId);
    setEtag(response, view.etag);
    return view;
  }

  @Get(':versionId/tests')
  @GatewayRoles('admin', 'compliance')
  async tests(@Req() request: AuthenticatedGatewayRequest, @Param('versionId') versionId: string) {
    const actor = await this.actor(request);
    const version = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    return {
      policyVersionId: version.policyVersionId,
      artifacts: await cg4PolicyTestArtifacts(
        this.database,
        this.queryContext(actor),
        version.policyId,
        version.version,
      ),
    };
  }

  @Get(':versionId/approvals')
  @GatewayRoles('admin', 'compliance')
  async approvalsFor(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('versionId') versionId: string,
  ) {
    const actor = await this.actor(request);
    const version = await this.loadVersion(actor, requiredUuid(versionId, 'versionId'));
    await this.auditEvidence(actor, 'POLICY_VERSION', version.policyVersionId);
    return {
      policyVersionId: version.policyVersionId,
      approvals: await cg4PolicyApprovals(
        this.database,
        this.queryContext(actor),
        version.policyId,
        version.version,
      ),
    };
  }
}

@Controller('api/v1/contact-governance/policy-scopes')
export class ContactGovernanceCg4ScopeQueryController extends Cg4ControllerBase {
  constructor(
    @Inject(CG4_DATABASE) database: PrismaClient,
    @Inject(CG4_EVIDENCE_ACCESS_SINK) evidenceAccess: Cg4EvidenceAccessSink,
  ) {
    super(database, evidenceAccess);
  }

  @Get(':scopeKey/effective')
  @GatewayRoles('admin', 'compliance')
  async effective(
    @Req() request: AuthenticatedGatewayRequest,
    @Res({ passthrough: true }) response: ServerResponse,
    @Param('scopeKey') scopeKey: string,
  ) {
    const actor = await this.actor(request);
    const view = await cg4EffectiveScope(
      this.database,
      this.queryContext(actor),
      requiredString(decodeURIComponent(scopeKey), 'scopeKey', 512),
    );
    if (!view) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    setEtag(response, view.etag);
    return view;
  }
}

@Controller('api/v1/contact-governance/kill-switches')
export class ContactGovernanceCg4KillSwitchController extends Cg4ControllerBase {
  private readonly policies: Cg4PolicyLifecycleRepository;

  constructor(
    @Inject(CG4_DATABASE) database: PrismaClient,
    @Inject(CG4_EVIDENCE_ACCESS_SINK) evidenceAccess: Cg4EvidenceAccessSink,
  ) {
    super(database, evidenceAccess);
    this.policies = new Cg4PolicyLifecycleRepository(database);
  }

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @GatewayRoles('compliance', 'platform-operator')
  async activate(@Req() request: AuthenticatedGatewayRequest, @Body() payload: unknown) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    try {
      return await this.policies.killSwitch({
        tenantId: actor.tenantId,
        scopeKey: requiredString(input.scopeKey, 'scopeKey', 512),
        action: 'ACTIVATE',
        reasonCode: requiredString(input.reasonCode, 'reasonCode'),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Post(':killSwitchId/clear')
  @HttpCode(HttpStatus.OK)
  @GatewayRoles('compliance')
  async clear(
    @Req() request: AuthenticatedGatewayRequest,
    @Param('killSwitchId') killSwitchId: string,
    @Body() payload: unknown,
  ) {
    const actor = await this.actor(request);
    const idempotencyKey = requiredIdempotencyKey(request);
    const input = body(payload);
    const id = requiredUuid(killSwitchId, 'killSwitchId');
    const [existing] = await cg4KillSwitches(this.database, this.queryContext(actor), {
      state: 'ACTIVE',
    }).then((rows) => rows.filter((row) => row.killSwitchId === id));
    if (!existing) throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND' });
    try {
      return await this.policies.killSwitch({
        tenantId: actor.tenantId,
        scopeKey: existing.scopeKey,
        action: 'CLEAR',
        reasonCode: requiredString(input.reasonCode, 'reasonCode'),
        clearApprovalRef: requiredString(input.clearApprovalRef, 'clearApprovalRef'),
        actor: actor.subject,
        evidenceRef: requiredString(input.evidenceRef, 'evidenceRef'),
        occurredAt: new Date().toISOString(),
        idempotencyKey,
      });
    } catch (error) {
      mapCg4Error(error);
    }
  }

  @Get()
  @GatewayRoles('admin', 'compliance', 'platform-operator')
  async list(
    @Req() request: AuthenticatedGatewayRequest,
    @Query('scope') scope: string,
    @Query('state') state: string,
  ) {
    const actor = await this.actor(request);
    if (state && state !== 'ACTIVE' && state !== 'CLEARED') {
      throw new BadRequestException({ code: 'VALIDATION_FAILED', message: 'state ไม่ถูกต้อง' });
    }
    const killSwitches = await cg4KillSwitches(this.database, this.queryContext(actor), {
      ...(scope ? { scopeKey: scope } : {}),
      ...(state ? { state: state as 'ACTIVE' | 'CLEARED' } : {}),
    });
    return { killSwitches };
  }
}

export const CG4_API_CONTROLLERS = [
  ContactGovernanceCg4ExceptionController,
  ContactGovernanceCg4ContactQueryController,
  ContactGovernanceCg4PolicyController,
  ContactGovernanceCg4PolicyVersionController,
  ContactGovernanceCg4ScopeQueryController,
  ContactGovernanceCg4KillSwitchController,
];

export type { Cg4Capability };
