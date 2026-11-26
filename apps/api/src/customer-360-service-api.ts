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

/** the maximum time from the start of introspection to the commit of create (Phase Contract M3 v1 item 2) */
export const C360_SERVICE_PROOF_DEADLINE_MS = 5_000;

const denied = () => new Customer360HttpError(403, 'CUSTOMER_ACCESS_DENIED');
const identityUnavailable = () =>
  new Customer360HttpError(503, 'SERVICE_IDENTITY_UNAVAILABLE', true);

/**
 * External customer API (#954): create/search/read/receipt of the service principal
 *
 * - the Gateway checks the JWT, the `service` role and the scope, but the real permission comes from the binding, capability and READ grant in the DB
 *   which is rechecked on every request under the principal's row guard (serialized with operator revoke/rebind)
 * - Create checks the token by online introspection outside the DB lock, then rechecks binding/capability/custodian under the lock
 *   there is no cache of the active result; no introspector = create is closed (503), never fail open
 * - never logs the body, token or PII values
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

  /** the active Binding of this token with a shared row guard in the transaction; none/closed = 403 */
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
        // a bucket per service client; rotating the credential does not get a new bucket
        actorId: `service:${identity.issuer}|${identity.subject}|${identity.clientId}`,
        policy,
      });
    } catch {
      throw new Customer360HttpError(503, 'RATE_LIMITER_UNAVAILABLE', true);
    }
    if (limited)
      throw new Customer360HttpError(429, 'RATE_LIMITED', true, limited.retryAfterSeconds);
  }

  /** confirms with the IdP that this token is still active right now, then returns the time by which the effect must commit */
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

  /** the active Binding of this identity without holding a lock; used only before getting the command lock */
  private async activeBinding(tx: Prisma.TransactionClient, identity: C360ServiceIdentity) {
    const [row] = await tx.$queryRaw<{ id: string; authz_epoch: bigint }[]>`
      SELECT id, authz_epoch FROM int_service_principals
      WHERE tenant_id = ${identity.tenantId}::uuid AND issuer = ${identity.issuer}
        AND subject = ${identity.subject} AND client_id = ${identity.clientId} AND active`;
    if (!row) throw denied();
    return row;
  }

  /**
   * a service Command lives only in the actor namespace SERVICE of this binding
   * lock order per Phase Contract M3 v1 item 4: `authorize` holds no lock, then the engine holds the command lock
   * then `fence` holds the principal's row guard (serialized with operator revoke/rebind)
   */
  private async commandContext(req: AuthenticatedGatewayRequest, identity: C360ServiceIdentity) {
    const binding = await withTenantDatabaseTransaction(this.db, identity.tenantId, (tx) =>
      this.activeBinding(tx, identity),
    );
    let current: C360LockedServicePrincipal | undefined;
    const authorization: C360CommandAuthorization = {
      authorize: async (tx) => {
        if ((await this.activeBinding(tx, identity)).id !== binding.id) throw denied();
      },
      fence: async (tx) => {
        current = undefined;
        const principal = await this.principal(tx, req);
        if (principal.id !== binding.id) throw denied();
        current = principal;
      },
      canAccessCommand: (command) => command.isTombstone || command.action === 'CONTACT_CREATE',
      canReadRef: async (tx, ref) =>
        ref.type === 'CONTACT' &&
        !!current &&
        (await authorizeC360ServiceContact(tx, current, ref.id)),
    };
    return {
      actor: c360ServiceActor(identity, binding.id),
      authorization,
      /** the epoch seen before the online proof; create must not pass if the operator changes the binding after this */
      authzEpoch: binding.authz_epoch,
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
    // the proof timed out = the effect is not committed yet; the client can safely resend the same commandId
    const withinDeadline = () => {
      if (this.now() >= deadline) throw identityUnavailable();
    };
    const authorization: C360CommandAuthorization = {
      ...context.authorization,
      authorize: async (tx) => {
        withinDeadline();
        await context.authorization.authorize(tx);
      },
      fence: async (tx) => {
        await context.authorization.fence!(tx);
        const principal = context.principal()!;
        // the operator changed the binding/grant/custodian after the proof: no effect, the client resends to recheck permission
        if (principal.authz_epoch !== context.authzEpoch)
          throw new Customer360HttpError(409, 'SERVICE_AUTHORIZATION_CHANGED', true);
        if (!(await authorizeC360ServiceCapability(tx, principal))) throw denied();
      },
      // checked after audit/receipt/constraints without calling the network
      beforeCommit: async () => withinDeadline(),
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
    try {
      return await withTenantDatabaseTransaction(
        this.db,
        identity.tenantId,
        async (tx) => {
          await tx.$queryRaw`SELECT set_config('jit', 'off', true)`;
          const principal = await this.principal(tx, req);
          return searchC360ContactsAs(tx, c360ServiceContactReader(principal), body, this.codec);
        },
        { isolationLevel: 'RepeatableRead' },
      );
    } catch (error) {
      // the operator edited the principal after the RepeatableRead snapshot but before taking the row guard: let the client retry
      const e = error as { code?: string; meta?: { code?: string } };
      if (e?.code === '40001' || e?.meta?.code === '40001' || e?.code === 'P2034')
        throw new Customer360HttpError(503, 'RESOURCE_BUSY', true);
      throw error;
    }
  }

  /** only the core fields of a Contact; does not compose tags, Voice, governance or history for a machine */
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
    // reconcile changes the command status, so the token must be confirmed online just like create
    await this.onlineProof(req, identity);
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
