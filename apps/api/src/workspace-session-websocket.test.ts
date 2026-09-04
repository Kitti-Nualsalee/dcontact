import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import {
  WorkspaceSessionGateway,
  WorkspaceSessionRegistry,
  WorkspaceSessionWebSocketAdapter,
} from '@d-contact/workspace-session';
import { attachWorkspaceSessionWebSocket } from './workspace-session-websocket.js';

test('workspace WebSocket runtime forwards the authenticated handshake without client tenant data', async () => {
  let received: unknown;
  let receivedCorrelationId: string | undefined;
  const server = createServer();
  const sockets = attachWorkspaceSessionWebSocket(server, {
    handle: async (socket, message, correlationId) => {
      received = message;
      receivedCorrelationId = correlationId;
      socket.send(JSON.stringify({ type: 'workspace.session', routingEnabled: true }));
    },
    disconnect: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/workspace-session`, {
    headers: { 'x-correlation-id': 'correlation-ws-33' },
  });
  await new Promise<void>((resolve, reject) => {
    client.once('open', () => resolve());
    client.once('error', reject);
  });
  client.send(
    JSON.stringify({ type: 'auth:connect', accessToken: 'verified-token', tabId: 'tab-a' }),
  );
  const response = await new Promise<string>((resolve) =>
    client.once('message', (data) => resolve(data.toString())),
  );

  assert.deepEqual(received, {
    type: 'auth:connect',
    accessToken: 'verified-token',
    tabId: 'tab-a',
  });
  assert.equal(receivedCorrelationId, 'correlation-ws-33');
  assert.match(response, /routingEnabled/);

  client.close();
  sockets.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test('workspace WebSocket ignores caller tenant data and uses the verified token tenant', async () => {
  const tenantId = '4e342ec5-d35b-41ed-bd44-1cf47a41af4b';
  const gateway = new WorkspaceSessionGateway(
    {
      verifyAccessToken: async () => ({
        tenant_id: tenantId,
        tenant_slug: 'demo',
        organization: { demo: { tenant_id: [tenantId] } },
        dc_user_id: '619b9c43-8495-420d-b3d3-34d9fd0b5b89',
        sid: 'keycloak-session-1',
        exp: 2_000_000_000,
        realm_access: { roles: ['agent'] },
      }),
    },
    new WorkspaceSessionRegistry(),
  );
  const server = createServer();
  const sockets = attachWorkspaceSessionWebSocket(
    server,
    new WorkspaceSessionWebSocketAdapter(gateway),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/workspace-session`);
  await new Promise<void>((resolve, reject) => {
    client.once('open', resolve);
    client.once('error', reject);
  });
  client.send(
    JSON.stringify({
      type: 'auth:connect',
      accessToken: 'verified-token',
      tabId: 'tab-a',
      tenantId: 'attacker-tenant',
    }),
  );
  const response = JSON.parse(
    await new Promise<string>((resolve) =>
      client.once('message', (data) => resolve(data.toString())),
    ),
  );

  assert.equal(response.session.tenantId, tenantId);
  assert.notEqual(response.session.tenantId, 'attacker-tenant');

  client.close();
  sockets.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
