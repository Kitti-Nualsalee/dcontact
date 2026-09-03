import 'reflect-metadata';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  Controller,
  type CanActivate,
  type ExecutionContext,
  Injectable,
  Module,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  KeycloakAccessTokenVerifier,
  toVerifiedWorkspaceIdentity,
  WorkspaceSessionGateway,
  WorkspaceSessionHttpAdapter,
  WorkspaceSessionRegistry,
  WorkspaceSessionWebSocketAdapter,
} from '@d-contact/workspace-session';
import { createWorkspaceSessionHandler } from './workspace-session-api.js';
import { attachWorkspaceSessionWebSocket } from './workspace-session-websocket.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const prisma = new PrismaClient();
const verifier = new KeycloakAccessTokenVerifier({
  issuer: required('KEYCLOAK_ISSUER'),
  audience: required('KEYCLOAK_AUDIENCE'),
  jwksUri: required('KEYCLOAK_JWKS_URI'),
});
const gateway = new WorkspaceSessionGateway(verifier, new WorkspaceSessionRegistry());
const httpAdapter = new WorkspaceSessionHttpAdapter(gateway);
const socketAdapter = new WorkspaceSessionWebSocketAdapter(gateway);
const handleWorkspaceSession = createWorkspaceSessionHandler(httpAdapter, (tenantId, work) =>
  withTenantDatabaseTransaction(prisma, tenantId, async () => work()),
);

@Injectable()
class OidcGlobalGuard implements CanActivate {
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<IncomingMessage>();
    const authorization = request.headers.authorization;
    if (!authorization?.startsWith('Bearer ')) throw new UnauthorizedException();
    try {
      const claims = await verifier.verifyAccessToken(authorization.slice('Bearer '.length).trim());
      toVerifiedWorkspaceIdentity(claims);
      return true;
    } catch {
      throw new UnauthorizedException();
    }
  }
}

@Controller('api/v1/workspace-session')
class WorkspaceSessionController {
  @Post('connect')
  async connect(@Req() request: IncomingMessage, @Res() response: ServerResponse): Promise<void> {
    await handleWorkspaceSession(request, response);
  }
}

@Module({
  controllers: [WorkspaceSessionController],
  providers: [{ provide: APP_GUARD, useClass: OidcGlobalGuard }],
})
class AppModule {}

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  attachWorkspaceSessionWebSocket(app.getHttpServer(), socketAdapter);
  await app.listen(Number(process.env.PORT ?? 3000));
}

void bootstrap();
