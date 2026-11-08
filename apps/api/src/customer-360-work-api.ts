import {
  Body,
  Catch,
  Controller,
  Get,
  Header,
  Inject,
  Optional,
  Param,
  Patch,
  Post,
  Req,
  Res,
  UseFilters,
  type ArgumentsHost,
  type ExceptionFilter,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import { withTenantDatabaseTransaction, type Prisma, type PrismaClient } from '@d-contact/db';
import {
  C360WorkError,
  C360ProfileCommandError,
  C360ProfileCommandRejection,
  authorizeC360WorkContact,
  changeC360WorkLink,
  c360CursorCodecFromEnv,
  c360Uuid,
  executeC360ProfileCommand,
  fenceC360Work,
  lookupC360ProfileCommand,
  normalizeC360WorkPatch,
  normalizeC360WorkSearch,
  openC360WorkCandidate,
  readC360WorkCustomer,
  reconcileC360ProfileCommand,
  searchC360WorkCandidates,
  updateC360WorkProfile,
  type C360CommandAuthorization,
  type C360VerifiedActor,
  type C360WorkContext,
} from '@d-contact/customer-360';
import { GatewayRoles, type AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  CUSTOMER_360_DATABASE,
  Customer360HttpError,
  ReceiptRecoveryGate,
  c360CurrentActor,
  commandActor,
  requestIdentity,
  send,
} from './customer-360-api.js';
import { Customer360ReadErrors } from './customer-360-read-api.js';
import { C360WorkAuthService, C360WorkAuthError } from './customer-360-work-auth.js';
import {
  C360_SEARCH_POLICY,
  C360_WRITE_POLICY,
  C360_RECEIPT_POLICY,
  CUSTOMER_360_SEARCH_LIMITER,
  type SharedRateLimiter,
  type SharedRateLimitInput,
} from './shared-rate-limiter.js';
import { CUSTOMER_360_WRITE_RUNTIME, type C360WriteRuntime } from './customer-360-write-runtime.js';

export const CUSTOMER_360_WORK_AUTH = Symbol('CUSTOMER_360_WORK_AUTH');
const workReceiptRecovery = new ReceiptRecoveryGate();
@Catch()
export class Customer360WorkErrors implements ExceptionFilter {
  private fallback = new Customer360ReadErrors();
  catch(error: unknown, host: ArgumentsHost) {
    if (error instanceof C360WorkError || error instanceof C360WorkAuthError)
      return this.fallback.catch(
        new Customer360HttpError(error.status, error.code, error.retryable),
        host,
      );
    return this.fallback.catch(error, host);
  }
}
const envelope = (body: unknown) => {
  if (!body || typeof body !== 'object' || Array.isArray(body))
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  return body as Record<string, unknown>;
};
function revision(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !/^(0|[1-9][0-9]{0,18})$/.test(value) ||
    BigInt(value) > 9223372036854775807n
  )
    throw new C360ProfileCommandError('INVALID_REQUEST', 400);
  return value;
}
type Proof = Awaited<ReturnType<C360WorkAuthService['verifyOnline']>>;

@Controller('api/v1/customer-360/work/:interactionId')
@GatewayRoles('agent')
@UseFilters(Customer360WorkErrors)
export class Customer360WorkController {
  private codec = c360CursorCodecFromEnv();
  constructor(
    @Inject(CUSTOMER_360_DATABASE) private db: PrismaClient,
    @Inject(CUSTOMER_360_SEARCH_LIMITER) private limiter: SharedRateLimiter,
    @Inject(CUSTOMER_360_WRITE_RUNTIME) private runtime: C360WriteRuntime,
    @Optional() @Inject(CUSTOMER_360_WORK_AUTH) private auth?: C360WorkAuthService,
  ) {}
  private lease(req: AuthenticatedGatewayRequest) {
    const id = req.headers['x-work-session-lease-id'];
    return typeof id === 'string' ? c360Uuid(id) : null;
  }
  private token(req: AuthenticatedGatewayRequest) {
    const value = req.headers.authorization;
    if (!value?.startsWith('Bearer ')) throw new Customer360HttpError(401, 'SESSION_REQUIRED');
    return value.slice(7).trim();
  }
  private ready() {
    if (!this.auth || !this.runtime.ready)
      throw new Customer360HttpError(503, 'WORK_CUSTOMER_UNAVAILABLE', true);
    return this.auth;
  }
  private async throttle(req: AuthenticatedGatewayRequest, policy: SharedRateLimitInput['policy']) {
    const identity = requestIdentity(req);
    let limited;
    try {
      limited = await this.limiter.consume({
        tenantId: identity.tenantId,
        actorId: identity.userId,
        policy,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
  }
  private async proof(req: AuthenticatedGatewayRequest) {
    const leaseId = this.lease(req);
    if (!leaseId) throw new Customer360HttpError(401, 'REAUTH_REQUIRED');
    return this.ready().verifyOnline({
      accessToken: this.token(req),
      leaseId,
      identity: req.gatewayIdentity,
    });
  }
  private async context(
    tx: Prisma.TransactionClient,
    req: AuthenticatedGatewayRequest,
    id: string,
    write: boolean,
    proof?: Proof,
  ) {
    const actor = await c360CurrentActor(tx, requestIdentity(req));
    const work = await fenceC360Work(tx, actor, id, this.lease(req), write);
    if (proof) await this.ready().assertOnlineProof(tx, proof);
    return { actor, work };
  }
  @Post('reauthenticate')
  async reauthenticate(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('interactionId') raw: string,
    @Body() body: unknown,
  ) {
    if (Object.keys(envelope(body)).length)
      throw new C360ProfileCommandError('INVALID_REQUEST', 400);
    const id = c360Uuid(raw);
    const identity = requestIdentity(req);
    const leaseId = this.lease(req);
    if (!leaseId) throw new Customer360HttpError(401, 'REAUTH_REQUIRED');
    await withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) =>
      this.context(tx, req, id, true),
    );
    await this.ready().reauthenticate({
      accessToken: this.token(req),
      leaseId,
      identity: req.gatewayIdentity,
    });
    return { state: 'ACTIVE' };
  }
  @Get('customer')
  @Header('Cache-Control', 'no-store')
  async customer(@Req() req: AuthenticatedGatewayRequest, @Param('interactionId') raw: string) {
    const id = c360Uuid(raw);
    await this.throttle(req, C360_RECEIPT_POLICY);
    const identity = requestIdentity(req);
    const completed = await withTenantDatabaseTransaction(this.db, identity.tenantId, (tx) =>
      tx.interaction.findFirst({
        where: { tenantId: identity.tenantId, id, agentId: identity.userId, state: 'COMPLETED' },
        select: { id: true },
      }),
    );
    const proof = completed ? undefined : await this.proof(req);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const actor = await c360CurrentActor(tx, identity);
      const work = await fenceC360Work(tx, actor, id, completed ? null : this.lease(req), false);
      if (proof) await this.ready().assertOnlineProof(tx, proof);
      return readC360WorkCustomer(tx, actor, work);
    });
  }
  @Post('candidates/search')
  @Header('Cache-Control', 'no-store')
  async candidates(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('interactionId') raw: string,
    @Body() body: unknown,
  ) {
    const id = c360Uuid(raw);
    const search = normalizeC360WorkSearch(envelope(body));
    await this.throttle(req, C360_SEARCH_POLICY);
    const proof = await this.proof(req);
    return withTenantDatabaseTransaction(this.db, requestIdentity(req).tenantId, async (tx) => {
      const { actor, work } = await this.context(tx, req, id, true, proof);
      const result = await searchC360WorkCandidates(tx, actor, work, search, this.codec);
      await this.ready().assertOnlineProof(tx, proof);
      return result;
    });
  }
  private authorization(
    req: AuthenticatedGatewayRequest,
    id: string,
    proof?: Proof,
    readOnly = false,
  ) {
    let current: { actor: C360VerifiedActor; work: C360WorkContext } | undefined;
    const authorization: C360CommandAuthorization = {
      authorize: async (tx) => {
        if (!readOnly) current = await this.context(tx, req, id, true, proof);
        else {
          const actor = await c360CurrentActor(tx, requestIdentity(req));
          const completed = await tx.interaction.findFirst({
            where: { tenantId: actor.tenantId, id, agentId: actor.userId, state: 'COMPLETED' },
            select: { id: true },
          });
          const work = await fenceC360Work(
            tx,
            actor,
            id,
            completed ? null : this.lease(req),
            false,
          );
          if (work.state !== 'COMPLETED' && proof) await this.ready().assertOnlineProof(tx, proof);
          current = { actor, work };
        }
      },
      canAccessCommand: (command) =>
        command.action === null ||
        (command.resourceType === 'INTERACTION' &&
          command.resourceId === id &&
          ['WORK_CUSTOMER_LINK', 'WORK_CUSTOMER_UPDATE'].includes(command.action)),
      canReadRef: async (tx, ref) => {
        if (!current) return false;
        if (ref.type === 'INTERACTION') return ref.id === id;
        if (ref.type !== 'CONTACT') return false;
        try {
          await authorizeC360WorkContact(
            tx,
            current.actor,
            ref.id,
            current.work.state === 'COMPLETED' ? 'VIEW' : 'WORK',
          );
          return true;
        } catch (error) {
          if (error instanceof C360WorkError) return false;
          throw error;
        }
      },
    };
    return authorization;
  }
  @Post('customer-link')
  async link(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('interactionId') raw: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const id = c360Uuid(raw);
    const payload = envelope(body);
    if (
      Object.keys(payload).some(
        (k) =>
          !['commandId', 'expectedLinkageRevision', 'candidateRef', 'reason', 'confirmed'].includes(
            k,
          ),
      )
    )
      throw new C360ProfileCommandError('INVALID_REQUEST', 400);
    if (payload.confirmed !== undefined && typeof payload.confirmed !== 'boolean')
      throw new C360ProfileCommandError('INVALID_REQUEST', 400);
    const expected = revision(payload.expectedLinkageRevision);
    if (
      payload.candidateRef !== null &&
      (typeof payload.candidateRef !== 'string' || payload.candidateRef.length > 2048)
    )
      throw new C360ProfileCommandError('INVALID_REQUEST', 400);
    const reason =
      payload.reason === undefined || payload.reason === null
        ? null
        : typeof payload.reason === 'string'
          ? payload.reason.trim()
          : null;
    if (
      payload.reason !== undefined &&
      payload.reason !== null &&
      (!reason || reason.length > 500 || /[\p{Cc}\p{Cs}]/u.test(reason))
    )
      throw new C360ProfileCommandError('INVALID_REQUEST', 400);
    const normalized = {
      candidateRef: payload.candidateRef,
      reason,
      confirmed: payload.confirmed === true,
    };
    await this.throttle(req, C360_WRITE_POLICY);
    const proof = await this.proof(req);
    const identity = requestIdentity(req);
    const actor = commandActor(identity);
    const result = await executeC360ProfileCommand(
      this.db,
      actor,
      {
        commandId: payload.commandId,
        action: 'WORK_CUSTOMER_LINK',
        resourceType: 'INTERACTION',
        resourceId: id,
        expectedRevisions: { linkage: expected },
        normalizationContractVersion: 'c360-work-v1',
        normalizedRequest: normalized,
      },
      this.authorization(req, id, proof),
      async (tx, command) => {
        const { actor: verified, work } = await this.context(tx, req, id, true, proof);
        if (work.linkageRevision !== expected)
          throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
        if (work.contactId && (payload.confirmed !== true || !reason))
          throw new C360ProfileCommandError('INVALID_REQUEST', 400);
        const target =
          payload.candidateRef === null
            ? null
            : openC360WorkCandidate(verified, work, payload.candidateRef as string, this.codec);
        const effect = await changeC360WorkLink(tx, verified, work, actor, command, target, reason);
        await this.ready().assertOnlineProof(tx, proof);
        return effect;
      },
    );
    send(response, result);
  }
  @Patch('customer')
  async update(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('interactionId') raw: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    const id = c360Uuid(raw);
    const payload = envelope(body);
    const patch = normalizeC360WorkPatch(payload);
    const expected = revision(payload.expectedLinkageRevision);
    const profile = revision(payload.expectedProfileRevision);
    const lineage = revision(payload.expectedLineageRevision);
    await this.throttle(req, C360_WRITE_POLICY);
    const proof = await this.proof(req);
    const identity = requestIdentity(req);
    const result = await executeC360ProfileCommand(
      this.db,
      commandActor(identity),
      {
        commandId: payload.commandId,
        action: 'WORK_CUSTOMER_UPDATE',
        resourceType: 'INTERACTION',
        resourceId: id,
        expectedRevisions: { profile, lineage, linkage: expected },
        normalizationContractVersion: 'c360-profile-v1',
        normalizedRequest: patch,
      },
      this.authorization(req, id, proof),
      async (tx) => {
        const { actor, work } = await this.context(tx, req, id, true, proof);
        if (work.linkageRevision !== expected)
          throw new C360ProfileCommandRejection('REVISION_CONFLICT', 409);
        const effect = await updateC360WorkProfile(tx, actor, work, profile, lineage, patch);
        await this.ready().assertOnlineProof(tx, proof);
        return effect;
      },
    );
    send(response, result);
  }
  @Get('commands/:commandId')
  @Header('Cache-Control', 'no-store')
  async lookup(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('interactionId') raw: string,
    @Param('commandId') commandId: string,
    @Res() response: ServerResponse,
  ) {
    const id = c360Uuid(raw);
    const identity = requestIdentity(req);
    const completed = await withTenantDatabaseTransaction(this.db, identity.tenantId, (tx) =>
      tx.interaction.findFirst({
        where: { id, tenantId: identity.tenantId, agentId: identity.userId, state: 'COMPLETED' },
        select: { id: true },
      }),
    );
    const proof = completed ? undefined : await this.proof(req);
    let recovery = false;
    try {
      await this.throttle(req, C360_RECEIPT_POLICY);
    } catch (error) {
      if (!(error instanceof Customer360HttpError) || error.code !== 'RATE_LIMITER_UNAVAILABLE')
        throw error;
      recovery = true;
    }
    const lookup = () =>
      lookupC360ProfileCommand(
        this.db,
        commandActor(identity),
        commandId,
        this.authorization(req, id, proof, true),
        { boundedRecovery: recovery },
      );
    send(
      response,
      recovery
        ? await workReceiptRecovery.run(lookup, () => {
            throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
          })
        : await lookup(),
    );
  }

  @Post('commands/:commandId/reconcile')
  async reconcile(
    @Req() req: AuthenticatedGatewayRequest,
    @Param('interactionId') raw: string,
    @Param('commandId') commandId: string,
    @Body() body: unknown,
    @Res() response: ServerResponse,
  ) {
    if (Object.keys(envelope(body)).length)
      throw new C360ProfileCommandError('INVALID_REQUEST', 400);
    const id = c360Uuid(raw);
    await this.throttle(req, C360_RECEIPT_POLICY);
    const proof = await this.proof(req);
    send(
      response,
      await reconcileC360ProfileCommand(
        this.db,
        commandActor(requestIdentity(req)),
        commandId,
        this.authorization(req, id, proof, true),
      ),
    );
  }
}
