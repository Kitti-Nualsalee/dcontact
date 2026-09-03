import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { WebSocket } from 'ws';
import { attachWorkspaceSessionWebSocket } from './workspace-session-websocket.js';

test('workspace WebSocket runtime forwards the authenticated handshake without client tenant data', async () => {
  let received: unknown;
  const server = createServer();
  const sockets = attachWorkspaceSessionWebSocket(server, {
    handle: async (socket, message) => {
      received = message;
      socket.send(JSON.stringify({ type: 'workspace.session', routingEnabled: true }));
    },
    disconnect: () => undefined,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert(address && typeof address === 'object');

  const client = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/workspace-session`);
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
  assert.match(response, /routingEnabled/);

  client.close();
  sockets.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
