import { createServer } from 'node:http';
import { PrismaClient, withTenantDatabaseTransaction } from '@d-contact/db';
import {
  KeycloakAccessTokenVerifier,
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
const gateway = new WorkspaceSessionGateway(
  new KeycloakAccessTokenVerifier({
    issuer: required('KEYCLOAK_ISSUER'),
    audience: required('KEYCLOAK_AUDIENCE'),
    jwksUri: required('KEYCLOAK_JWKS_URI'),
  }),
  new WorkspaceSessionRegistry(),
);
const adapter = new WorkspaceSessionHttpAdapter(gateway);
const socketAdapter = new WorkspaceSessionWebSocketAdapter(gateway);

const handleWorkspaceSession = createWorkspaceSessionHandler(adapter, (tenantId, work) =>
  withTenantDatabaseTransaction(prisma, tenantId, async () => work()),
);

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/api/v1/workspace-session/connect') {
    void handleWorkspaceSession(request, response);
    return;
  }
  response.writeHead(404).end();
});

attachWorkspaceSessionWebSocket(server, socketAdapter);

server.listen(Number(process.env.PORT ?? 3000));
