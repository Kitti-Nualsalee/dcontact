import { createServer } from 'node:http';
import {
  KeycloakAccessTokenVerifier,
  WorkspaceSessionGateway,
  WorkspaceSessionHttpAdapter,
  WorkspaceSessionRegistry,
} from '@d-contact/workspace-session';
import { createWorkspaceSessionHandler } from './workspace-session-api.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const adapter = new WorkspaceSessionHttpAdapter(
  new WorkspaceSessionGateway(
    new KeycloakAccessTokenVerifier({
      issuer: required('KEYCLOAK_ISSUER'),
      audience: required('KEYCLOAK_AUDIENCE'),
      jwksUri: required('KEYCLOAK_JWKS_URI'),
    }),
    new WorkspaceSessionRegistry(),
  ),
);

const handleWorkspaceSession = createWorkspaceSessionHandler(adapter);

createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/api/v1/workspace-session/connect') {
    void handleWorkspaceSession(request, response);
    return;
  }
  response.writeHead(404).end();
}).listen(Number(process.env.PORT ?? 3000));
