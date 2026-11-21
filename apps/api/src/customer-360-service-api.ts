import type { ServerResponse } from 'node:http';
import { withTenantDatabaseTransaction, type Prisma, type PrismaClient } from '@d-contact/db';
import {
  C360ProfileCommandError,
  C360ReadError,
  C360_PROFILE_WRITE_VERSION,
  authorizeC360ServiceCapability,
  authorizeC360ServiceContact,
  c360CursorCodecFromEnv,
  c360ServiceActor,
  c360ServiceContactReader,
  c360Uuid,
  createC360ServiceProfile,
  executeC360ProfileCommand,
  lookupC360ProfileCommand,
  normalizeC360CreateProfile,
  readC360ProfileAs,
  reconcileC360ProfileCommand,
  searchC360ContactsAs,
  type C360CommandAuthorization,
  type C360CursorCodec,
  type C360LockedServicePrincipal,
  type C360ServiceIdentity,
} from '@d-contact/customer-360';
import { Customer360HttpError, send } from './customer-360-api.js';
import { currentC360ServicePrincipal } from './customer-360-service-identity.js';
import type { Customer360ServicePort } from './customer-360-service-port.js';
import type { C360TokenIntrospector } from './customer-360-work-auth.js';
import type { C360WriteRuntime } from './customer-360-write-runtime.js';
import type { AuthenticatedGatewayRequest } from './gateway-auth.js';
import {
  C360_RECEIPT_POLICY,
  C360_SEARCH_POLICY,
  C360_WRITE_POLICY,
  type SharedRateLimiter,
  type SharedRateLimitInput,
} from './shared-rate-limiter.js';

/** เวลาสูงสุดจากเริ่ม introspection ถึง commit ของ create (Phase Contract M3 v1 ข้อ 2) */
export const C360_SERVICE_PROOF_DEADLINE_MS = 5_000;

const denied = () => new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
const identityUnavailable = () =>
  new Customer360HttpError(503, 'SERVICE_IDENTITY_UNAVAILABLE', true);

/**
 * External customer API (#954): create/search/read/receipt ของ service principal
 *
 * - Gateway ตรวจ JWT, role `service` และ scope แล้ว แต่สิทธิ์จริงมาจาก binding, capability และ READ grant ใน DB
 *   ซึ่งตรวจใหม่ทุก request ภายใต้ row guard ของ principal (serialize กับ operator revoke/rebind)
 * - Create ตรวจ token แบบ online introspection นอก DB lock แล้วตรวจ binding/capability/custodian ซ้ำใต้ lock
 *   ไม่มี cache ผล active; ไม่มี introspector = create ปิด (503) ไม่ fail open
 * - ไม่ log body, token หรือค่า PII
 */
export class Customer360ServiceApi implements Customer360ServicePort {
  constructor(
    private readonly db: PrismaClient,
    private readonly limiter: SharedRateLimiter,
    private readonly runtime: C360WriteRuntime,
    private readonly introspector: C360TokenIntrospector | null,
    private readonly codec: C360CursorCodec = c360CursorCodecFromEnv(),
    private readonly now: () => number = Date.now,
  ) {}

  private identity(req: AuthenticatedGatewayRequest): C360ServiceIdentity {
    const service = req.gatewayServiceIdentity;
    const issuer = (req.gatewayVerifiedClaims as { iss?: unknown } | undefined)?.iss;
    if (!service || typeof issuer !== 'string') throw denied();
    try {
      return {
        tenantId: c360Uuid(service.tenantId),
        issuer,
        subject: service.subject,
        clientId: service.clientId,
      };
    } catch {
      throw denied();
    }
  }

  /** Binding ที่ active ของ token นี้ พร้อม shared row guard ใน transaction; ไม่มี/ถูกปิด = 403 */
  private async principal(tx: Prisma.TransactionClient, req: AuthenticatedGatewayRequest) {
    try {
      return await currentC360ServicePrincipal(tx, req);
    } catch (error) {
      if (error instanceof C360ProfileCommandError && error.httpStatus === 403) throw denied();
      throw error;
    }
  }

  private async throttle(identity: C360ServiceIdentity, policy: SharedRateLimitInput['policy']) {
    let limited: { retryAfterSeconds: number } | null;
    try {
      limited = await this.limiter.consume({
        tenantId: identity.tenantId,
        // bucket ต่อ service client; หมุน credential ไม่ได้ bucket ใหม่
        actorId: `service:${identity.issuer}|${identity.subject}|${identity.clientId}`,
        policy,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
  }

  /** ยืนยันกับ IdP ว่า token นี้ยัง active ขณะนี้ แล้วคืนเวลาที่ effect ต้อง commit ให้ทัน */
  private async onlineProof(
    req: AuthenticatedGatewayRequest,
    identity: C360ServiceIdentity,
  ): Promise<number> {
    if (!this.introspector) throw identityUnavailable();
    const authorization = req.headers.authorization;
    const token = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    if (!token) throw new Customer360HttpError(401, 'SESSION_REQUIRED');
    const started = this.now();
    let result: Record<string, unknown>;
    try {
      result = await this.introspector.introspect(token);
    } catch {
      throw identityUnavailable();
    }
    if (result.active !== true) throw new Customer360HttpError(401, 'SESSION_REQUIRED');
    for (const [name, expected] of [
      ['iss', identity.issuer],
      ['sub', identity.subject],
      ['client_id', identity.clientId],
      ['azp', identity.clientId],
    ] as const)
      if (result[name] !== undefined && result[name] !== expected)
        throw new Customer360HttpError(401, 'SESSION_REQUIRED');
    return Math.min(
      req.gatewayServiceIdentity!.expiresAt.getTime(),
      started + C360_SERVICE_PROOF_DEADLINE_MS,
    );
  }

  /** Command ของ service อยู่ใน actor namespace SERVICE ของ binding นี้เท่านั้น */
  private async commandContext(req: AuthenticatedGatewayRequest, identity: C360ServiceIdentity) {
    const bindingId = await withTenantDatabaseTransaction(
      this.db,
      identity.tenantId,
      async (tx) => (await this.principal(tx, req)).id,
    );
    let current: C360LockedServicePrincipal | undefined;
    const authorization: C360CommandAuthorization = {
      authorize: async (tx) => {
        current = undefined;
        const principal = await this.principal(tx, req);
        if (principal.id !== bindingId) throw denied();
        current = principal;
      },
      canAccessCommand: (command) => command.isTombstone || command.action === 'CONTACT_CREATE',
      canReadRef: async (tx, ref) =>
        ref.type === 'CONTACT' &&
        !!current &&
        (await authorizeC360ServiceContact(tx, current, ref.id)),
    };
    return {
      actor: c360ServiceActor(identity, bindingId),
      authorization,
      principal: () => current,
    };
  }

  async create(req: AuthenticatedGatewayRequest, body: unknown, response: ServerResponse) {
    const identity = this.identity(req);
    if (!this.runtime.ready) throw new Customer360HttpError(503, 'WRITE_RUNTIME_UNAVAILABLE', true);
    if (!body || typeof body !== 'object' || Array.isArray(body))
      throw new Customer360HttpError(400, 'INVALID_REQUEST');
    const payload = body as Record<string, unknown>;
    const profile = normalizeC360CreateProfile(payload);
    await this.throttle(identity, C360_WRITE_POLICY);
    const context = await this.commandContext(req, identity);
    const deadline = await this.onlineProof(req, identity);
    const authorization: C360CommandAuthorization = {
      ...context.authorization,
      authorize: async (tx) => {
        // หมดเวลาของ proof = ยังไม่ทำ effect; client ส่ง commandId เดิมซ้ำได้อย่างปลอดภัย
        if (this.now() >= deadline) throw identityUnavailable();
        await context.authorization.authorize(tx);
        if (!(await authorizeC360ServiceCapability(tx, context.principal()!))) throw denied();
      },
    };
    const result = await executeC360ProfileCommand(
      this.db,
      context.actor,
      {
        commandId: payload.commandId,
        action: 'CONTACT_CREATE',
        resourceType: 'CONTACT',
        resourceId: null,
        expectedRevisions: {},
        normalizationContractVersion: C360_PROFILE_WRITE_VERSION,
        normalizedRequest: profile,
      },
      authorization,
      (tx, command) =>
        createC360ServiceProfile(tx, context.principal()!, context.actor, command, profile),
    );
    send(response, result);
  }

  async search(req: AuthenticatedGatewayRequest, body: unknown) {
    const identity = this.identity(req);
    await this.throttle(identity, C360_SEARCH_POLICY);
    return withTenantDatabaseTransaction(
      this.db,
      identity.tenantId,
      async (tx) => {
        await tx.$queryRaw`SELECT set_config('jit', 'off', true)`;
        const principal = await this.principal(tx, req);
        return searchC360ContactsAs(tx, c360ServiceContactReader(principal), body, this.codec);
      },
      { isolationLevel: 'RepeatableRead' },
    );
  }

  /** เฉพาะ core fields ของ Contact; ไม่ compose tags, Voice, governance หรือประวัติให้ machine */
  async profile(req: AuthenticatedGatewayRequest, contactId: string) {
    const identity = this.identity(req);
    let id: string;
    try {
      id = c360Uuid(contactId);
    } catch {
      throw new C360ReadError(404, 'RESOURCE_NOT_FOUND');
    }
    await this.throttle(identity, C360_RECEIPT_POLICY);
    return withTenantDatabaseTransaction(this.db, identity.tenantId, async (tx) => {
      const principal = await this.principal(tx, req);
      const view = await readC360ProfileAs(tx, c360ServiceContactReader(principal), id);
      return {
        contact: view.contact,
        contactPoints: view.contactPoints,
        revisions: view.revisions,
        identity: view.identity,
        capabilities: view.capabilities,
      };
    });
  }

  async command(req: AuthenticatedGatewayRequest, commandId: string, response: ServerResponse) {
    const identity = this.identity(req);
    await this.throttle(identity, C360_RECEIPT_POLICY);
    const context = await this.commandContext(req, identity);
    send(
      response,
      await lookupC360ProfileCommand(this.db, context.actor, commandId, context.authorization),
    );
  }

  async reconcile(
    req: AuthenticatedGatewayRequest,
    commandId: string,
    body: unknown,
    response: ServerResponse,
  ) {
    const identity = this.identity(req);
    await this.throttle(identity, C360_RECEIPT_POLICY);
    const context = await this.commandContext(req, identity);
    send(
      response,
      await reconcileC360ProfileCommand(
        this.db,
        context.actor,
        commandId,
        body,
        context.authorization,
      ),
    );
  }
}
