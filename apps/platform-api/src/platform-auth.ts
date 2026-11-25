/**
 * Owner: IAM + Platform edge — authorization boundary of the Platform API (A1.2 #407)
 *
 * Authority: #387 enforcement invariants, Phase Contract #388
 *
 * - Global deny-by-default guard: a route must declare either `@RequirePlatformCapability(...)` or
 *   `@PlatformPublic()` — a route that forgets is rejected (403), never left open
 * - The token must pass the verifier (signature/issuer/audience/expiry) and `toVerifiedPlatformIdentity`
 *   (no tenant context, MFA present, platform role present) — failing any of these = 401
 * - An identity whose roles do not cover the capability = 403
 * - A1.8 (#413): `PROVISIONING_MUTATE` must also pass the rollout — flag off = 503 `PROVISIONING_DISABLED`
 *   (rollback: reads keep working), subject outside the canary allowlist = 403
 * - A1.8: the `MIXED_TOKEN_TRIPWIRE` re-checks tenant context with its own list (not the one in
 *   `toVerifiedPlatformIdentity`) — if the identity check is ever weakened, the token is still rejected
 *   and a critical alert fires
 * - Every error body uses the same envelope and never gives the client the detailed reason; the real
 *   reason goes to diagnostics, which must never contain the token or PII claims (email/name)
 */
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Catch,
  ForbiddenException,
  HttpException,
  Inject,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  type ArgumentsHost,
  type CanActivate,
  type ExceptionFilter,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { PlatformRollout } from '@d-contact/platform-control';
import { PlatformProvisioningError, type PlatformProvisioningErrorCode } from '@d-contact/shared';
import {
  PlatformIdentityError,
  toVerifiedPlatformIdentity,
  type PlatformCapability,
  type PlatformIdentityRejection,
  type VerifiedPlatformIdentity,
} from './platform-identity.js';
import type { PlatformAccessTokenVerifier } from './platform-verifier.js';

export const PLATFORM_ACCESS_TOKEN_VERIFIER = Symbol('PLATFORM_ACCESS_TOKEN_VERIFIER');
export const PLATFORM_AUTH_DIAGNOSTICS = Symbol('PLATFORM_AUTH_DIAGNOSTICS');
export const PLATFORM_CLOCK = Symbol('PLATFORM_CLOCK');
export const PLATFORM_ROLLOUT = Symbol('PLATFORM_ROLLOUT');
const PLATFORM_CAPABILITY = Symbol('PLATFORM_CAPABILITY');
const PLATFORM_PUBLIC = Symbol('PLATFORM_PUBLIC');

export interface AuthenticatedPlatformRequest extends IncomingMessage {
  platformIdentity?: VerifiedPlatformIdentity;
  correlationId?: string;
  /** Provisioning request the route already resolved — may go in the error envelope (not for 404) */
  platformRequestId?: string;
}

export type PlatformAuthDenialReason =
  | 'MISSING_BEARER'
  | 'TOKEN_INVALID'
  | PlatformIdentityRejection
  | 'CAPABILITY_NOT_GRANTED'
  | 'ROUTE_UNDECLARED'
  | 'PROVISIONING_DISABLED'
  | 'ROLLOUT_NOT_ALLOWLISTED'
  | 'MIXED_TOKEN_TRIPWIRE';

export interface PlatformAuthDiagnostic {
  event: 'platform.request.authorized' | 'platform.request.denied';
  correlationId: string;
  reason?: PlatformAuthDenialReason;
  capability?: PlatformCapability;
  /** Keycloak subject (opaque UUID) — never an email/username */
  subject?: string;
}

export interface PlatformAuthDiagnosticSink {
  write(diagnostic: PlatformAuthDiagnostic): void;
}

export const RequirePlatformCapability = (capability: PlatformCapability) =>
  SetMetadata(PLATFORM_CAPABILITY, capability);
/** Only liveness/readiness, which return no control-plane data */
export const PlatformPublic = () => SetMetadata(PLATFORM_PUBLIC, true);

/** Tenant-token claims that must never appear in a platform token — kept apart from platform-identity on purpose */
export function carriesTenantContext(claims: Record<string, unknown>): boolean {
  const roles = (claims.realm_access as { roles?: unknown } | undefined)?.roles;
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  return (
    ['tenant_id', 'tenant_slug', 'organization', 'dc_user_id'].some(
      (claim) => claims[claim] !== undefined && claims[claim] !== null,
    ) ||
    (Array.isArray(roles) && roles.length > 0) ||
    audiences.includes('dcontact-api')
  );
}

function requestCorrelationId(request: IncomingMessage): string {
  const supplied = request.headers['x-correlation-id'];
  if (typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return randomUUID();
}

@Injectable()
export class PlatformAuthGuard implements CanActivate {
  constructor(
    @Inject(PLATFORM_ACCESS_TOKEN_VERIFIER)
    private readonly verifier: PlatformAccessTokenVerifier,
    @Inject(PLATFORM_AUTH_DIAGNOSTICS)
    private readonly diagnostics: PlatformAuthDiagnosticSink,
    @Inject(PLATFORM_CLOCK)
    private readonly clock: () => Date,
    @Inject(PLATFORM_ROLLOUT)
    private readonly rollout: PlatformRollout,
    @Inject(Reflector)
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedPlatformRequest>();
    const response = context.switchToHttp().getResponse<ServerResponse>();
    const correlationId = requestCorrelationId(request);
    request.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);
    const targets = [context.getHandler(), context.getClass()];

    if (this.reflector.getAllAndOverride<boolean>(PLATFORM_PUBLIC, targets) === true) return true;
    const capability = this.reflector.getAllAndOverride<PlatformCapability>(
      PLATFORM_CAPABILITY,
      targets,
    );

    const deny = (
      reason: PlatformAuthDenialReason,
      status: 401 | 403 | 503,
      subject?: string,
    ): never => {
      this.diagnostics.write({
        event: 'platform.request.denied',
        correlationId,
        reason,
        ...(capability ? { capability } : {}),
        ...(subject ? { subject } : {}),
      });
      if (status === 503) throw new PlatformProvisioningError('PROVISIONING_DISABLED');
      throw status === 401 ? new UnauthorizedException() : new ForbiddenException();
    };

    const authorization = request.headers.authorization;
    const accessToken = authorization?.startsWith('Bearer ')
      ? authorization.slice('Bearer '.length).trim()
      : '';
    if (!accessToken) return deny('MISSING_BEARER', 401);

    let claims: Record<string, unknown>;
    try {
      claims = await this.verifier.verifyAccessToken(accessToken);
    } catch {
      return deny('TOKEN_INVALID', 401);
    }
    let identity: VerifiedPlatformIdentity;
    try {
      identity = toVerifiedPlatformIdentity(claims, this.clock());
    } catch (error) {
      return deny(error instanceof PlatformIdentityError ? error.reason : 'TOKEN_INVALID', 401);
    }
    if (carriesTenantContext(claims)) return deny('MIXED_TOKEN_TRIPWIRE', 401, identity.subject);
    if (!capability) return deny('ROUTE_UNDECLARED', 403, identity.subject);
    if (!identity.capabilities.includes(capability)) {
      return deny('CAPABILITY_NOT_GRANTED', 403, identity.subject);
    }
    if (capability === 'PROVISIONING_MUTATE') {
      const decision = this.rollout.mutationFor(identity.subject);
      if (decision === 'DISABLED') return deny('PROVISIONING_DISABLED', 503, identity.subject);
      if (decision === 'NOT_ALLOWLISTED') {
        return deny('ROLLOUT_NOT_ALLOWLISTED', 403, identity.subject);
      }
    }

    request.platformIdentity = identity;
    this.diagnostics.write({
      event: 'platform.request.authorized',
      correlationId,
      capability,
      subject: identity.subject,
    });
    return true;
  }
}

export interface PlatformErrorEnvelope {
  status: number;
  /** Stable machine code — auth uses the generic set, domain errors use `PlatformProvisioningErrorCode` */
  code: string;
  title: string;
  correlationId: string | null;
  requestId?: string;
  retryable: boolean;
  fieldErrors?: Readonly<Record<string, string>>;
}

const ENVELOPES: Record<number, Pick<PlatformErrorEnvelope, 'code' | 'title'>> = {
  400: { code: 'BAD_REQUEST', title: 'Invalid request' },
  401: { code: 'UNAUTHENTICATED', title: 'Sign in to Platform Console again' },
  403: { code: 'FORBIDDEN', title: 'You do not have permission for this action' },
  404: { code: 'NOT_FOUND', title: 'Not found' },
};

/** #388 checkpoint 1: safe status + title for each domain error code */
const DOMAIN_ERRORS: Record<PlatformProvisioningErrorCode, { status: number; title: string }> = {
  VALIDATION_FAILED: { status: 400, title: 'Invalid data' },
  NOT_FOUND: { status: 404, title: 'Not found' },
  TENANT_SLUG_CONFLICT: { status: 409, title: 'This slug is already in use' },
  TENANT_DOMAIN_CONFLICT: { status: 409, title: 'This domain is already in use' },
  FIRST_ADMIN_EMAIL_CONFLICT: { status: 409, title: 'The first admin email is already in use' },
  IDEMPOTENCY_KEY_REUSED: {
    status: 409,
    title: 'This Idempotency-Key was used for another request',
  },
  REVISION_CONFLICT: { status: 409, title: 'The data has changed. Please reload' },
  INVALID_STATE_TRANSITION: {
    status: 409,
    title: 'This action is not allowed in the current state',
  },
  BOOTSTRAP_TEMPLATE_UNAVAILABLE: {
    status: 409,
    title: 'This bootstrap template is no longer available',
  },
  PLAN_UNAVAILABLE: { status: 409, title: 'This plan is no longer available' },
  PREVIEW_STALE: { status: 409, title: 'The preview is out of date. Please preview again' },
  RECOVERY_PRECONDITION_FAILED: {
    status: 409,
    title: 'The preconditions for this action are not met',
  },
  FIELD_LOCKED: { status: 409, title: 'This field can no longer be changed' },
  COMMAND_IN_PROGRESS: { status: 409, title: 'Another command for this request is in progress' },
  INVITATION_RESEND_LIMITED: { status: 429, title: 'Invitation resend limit reached' },
  SERVICE_UNAVAILABLE: {
    status: 503,
    title: 'The service is temporarily unavailable. Please try again',
  },
  PROVISIONING_DISABLED: {
    status: 503,
    title: 'Creating and editing are temporarily disabled; status is still available',
  },
};

/** Prisma cannot connect/commit = control plane unavailable (503) — not a downstream dependency failure */
function databaseUnavailable(exception: unknown): boolean {
  const name = (exception as { name?: string } | null)?.name ?? '';
  const code = (exception as { code?: string } | null)?.code ?? '';
  return (
    name === 'PrismaClientInitializationError' ||
    (name === 'PrismaClientKnownRequestError' &&
      ['P1001', 'P1002', 'P1008', 'P1017', 'P2024'].includes(code))
  );
}

/**
 * The same envelope for every error — never sends Nest's message/stack, a raw dependency error or the
 * internal reason for an auth rejection (#388 checkpoint 1)
 */
@Catch()
export class PlatformErrorFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const request = host.switchToHttp().getRequest<AuthenticatedPlatformRequest>();
    const response = host.switchToHttp().getResponse<ServerResponse>();
    const correlationId = request.correlationId ?? null;
    let body: PlatformErrorEnvelope;
    if (exception instanceof PlatformProvisioningError) {
      const mapped = DOMAIN_ERRORS[exception.code];
      body = {
        status: mapped.status,
        code: exception.code,
        title: mapped.title,
        correlationId,
        ...(request.platformRequestId && mapped.status !== 404
          ? { requestId: request.platformRequestId }
          : {}),
        // PROVISIONING_DISABLED is a deliberate shutdown — a client retry will not help
        retryable:
          (mapped.status === 503 || mapped.status === 429) &&
          exception.code !== 'PROVISIONING_DISABLED',
        ...(exception.fieldErrors ? { fieldErrors: exception.fieldErrors } : {}),
      };
      const retryAfter = (exception as { retryAfterSeconds?: number }).retryAfterSeconds;
      if (mapped.status === 429 && retryAfter)
        response.setHeader('retry-after', String(retryAfter));
    } else if (databaseUnavailable(exception)) {
      body = {
        status: 503,
        code: 'SERVICE_UNAVAILABLE',
        title: DOMAIN_ERRORS.SERVICE_UNAVAILABLE.title,
        correlationId,
        retryable: true,
      };
    } else {
      const status = exception instanceof HttpException ? exception.getStatus() : 500;
      const known = ENVELOPES[status];
      body = {
        status: known ? status : 500,
        code: known?.code ?? 'INTERNAL',
        title: known?.title ?? 'Internal error',
        correlationId,
        retryable: !known,
      };
    }
    response.statusCode = body.status;
    response.setHeader('content-type', 'application/json; charset=utf-8');
    response.setHeader('cache-control', 'no-store');
    response.end(JSON.stringify(body));
  }
}
