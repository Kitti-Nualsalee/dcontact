import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ForbiddenException,
  Inject,
  Injectable,
  SetMetadata,
  type CanActivate,
  type ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import {
  toVerifiedServiceIdentity,
  toVerifiedWorkspaceIdentity,
  type OidcAccessTokenVerifier,
  type VerifiedOidcClaims,
  type VerifiedServiceIdentity,
  type VerifiedWorkspaceIdentity,
} from '@d-contact/workspace-session';

export const OIDC_ACCESS_TOKEN_VERIFIER = Symbol('OIDC_ACCESS_TOKEN_VERIFIER');
export const GATEWAY_DIAGNOSTICS = Symbol('GATEWAY_DIAGNOSTICS');
const GATEWAY_ROLES = Symbol('GATEWAY_ROLES');
const GATEWAY_SERVICE_ROLES = Symbol('GATEWAY_SERVICE_ROLES');

export interface AuthenticatedGatewayRequest extends IncomingMessage {
  gatewayIdentity?: VerifiedWorkspaceIdentity;
  gatewayServiceIdentity?: VerifiedServiceIdentity;
  correlationId?: string;
}

export interface GatewayDiagnostic {
  event: 'gateway.request.authorized' | 'gateway.request.denied';
  correlationId: string;
  reason?: 'unauthenticated' | 'forbidden';
  tenantId?: string;
  userId?: string;
  clientId?: string;
}

export interface GatewayDiagnosticSink {
  write(diagnostic: GatewayDiagnostic): void;
}

export const GatewayRoles = (...roles: string[]) => SetMetadata(GATEWAY_ROLES, roles);
export const GatewayServiceRoles = (...roles: string[]) =>
  SetMetadata(GATEWAY_SERVICE_ROLES, roles);

function requestCorrelationId(request: IncomingMessage): string {
  const supplied = request.headers['x-correlation-id'];
  if (typeof supplied === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return randomUUID();
}

@Injectable()
export class OidcGlobalGuard implements CanActivate {
  constructor(
    @Inject(OIDC_ACCESS_TOKEN_VERIFIER)
    private readonly verifier: OidcAccessTokenVerifier,
    @Inject(GATEWAY_DIAGNOSTICS)
    private readonly diagnostics: GatewayDiagnosticSink,
    @Inject(Reflector)
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<AuthenticatedGatewayRequest>();
    const response = context.switchToHttp().getResponse<ServerResponse>();
    const correlationId = requestCorrelationId(request);
    request.correlationId = correlationId;
    response.setHeader('x-correlation-id', correlationId);

    const authorization = request.headers.authorization;
    let claims: VerifiedOidcClaims;
    try {
      if (!authorization?.startsWith('Bearer ')) throw new Error('missing bearer token');
      const accessToken = authorization.slice('Bearer '.length).trim();
      if (!accessToken) throw new Error('missing bearer token');
      claims = await this.verifier.verifyAccessToken(accessToken);
    } catch {
      this.diagnostics.write({
        event: 'gateway.request.denied',
        correlationId,
        reason: 'unauthenticated',
      });
      throw new UnauthorizedException();
    }

    const requiredServiceRoles = this.reflector.getAllAndOverride<readonly string[]>(
      GATEWAY_SERVICE_ROLES,
      [context.getHandler(), context.getClass()],
    );
    const requiredWorkspaceRoles = this.reflector.getAllAndOverride<readonly string[]>(
      GATEWAY_ROLES,
      [context.getHandler(), context.getClass()],
    );

    if (requiredServiceRoles) {
      let serviceIdentity: VerifiedServiceIdentity | undefined;
      try {
        serviceIdentity = toVerifiedServiceIdentity(claims);
      } catch {
        // token ไม่ใช่ service principal shape; ถ้า route รองรับ workspace ด้วยให้ fallback
        // ไปลอง workspace ต่อ (dual-mode route) ไม่เช่นนั้นคงพฤติกรรมเดิม: unauthenticated
        if (requiredWorkspaceRoles === undefined) {
          this.diagnostics.write({
            event: 'gateway.request.denied',
            correlationId,
            reason: 'unauthenticated',
          });
          throw new UnauthorizedException();
        }
      }
      if (serviceIdentity) {
        if (!serviceIdentity.roles.some((role) => requiredServiceRoles.includes(role))) {
          this.diagnostics.write({
            event: 'gateway.request.denied',
            correlationId,
            reason: 'forbidden',
            tenantId: serviceIdentity.tenantId,
            clientId: serviceIdentity.clientId,
          });
          throw new ForbiddenException();
        }
        request.gatewayServiceIdentity = serviceIdentity;
        this.diagnostics.write({
          event: 'gateway.request.authorized',
          correlationId,
          tenantId: serviceIdentity.tenantId,
          clientId: serviceIdentity.clientId,
        });
        return true;
      }
    }

    let identity: VerifiedWorkspaceIdentity;
    try {
      identity = toVerifiedWorkspaceIdentity(claims);
    } catch {
      this.diagnostics.write({
        event: 'gateway.request.denied',
        correlationId,
        reason: 'unauthenticated',
      });
      throw new UnauthorizedException();
    }

    const requiredRoles = requiredWorkspaceRoles ?? [];
    if (requiredRoles.length > 0 && !identity.roles.some((role) => requiredRoles.includes(role))) {
      this.diagnostics.write({
        event: 'gateway.request.denied',
        correlationId,
        reason: 'forbidden',
        tenantId: identity.tenantId,
        userId: identity.userId,
      });
      throw new ForbiddenException();
    }

    request.gatewayIdentity = identity;
    this.diagnostics.write({
      event: 'gateway.request.authorized',
      correlationId,
      tenantId: identity.tenantId,
      userId: identity.userId,
    });
    return true;
  }
}
