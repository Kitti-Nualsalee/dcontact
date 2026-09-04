import assert from 'node:assert/strict';
import test from 'node:test';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WorkspaceSessionHttpRequest } from '@d-contact/workspace-session';
import { createWorkspaceSessionHandler } from './workspace-session-api.js';

test('workspace session endpoint forwards bearer token and tab id without browser tenant context', async () => {
  let received: unknown;
  const handler = createWorkspaceSessionHandler(
    {
      connect: async (request: WorkspaceSessionHttpRequest) => {
        received = request;
        return {
          status: 200 as const,
          body: {
            tenantId: 'tenant-a',
            userId: 'agent-a',
            tabId: 'tab-a',
            routingEnabled: true,
            status: 'active' as const,
            availability: 'AVAILABLE' as const,
          },
        };
      },
    } as never,
    async (_tenantId, work) => work(),
  );
  const response = { writeHead: () => response, end: () => undefined } as unknown as ServerResponse;

  await handler(
    {
      headers: {
        authorization: 'Bearer token',
        'x-workspace-tab-id': 'tab-a',
        'x-tenant-id': 'attacker-tenant',
      },
      url: '/api/v1/workspace-session/connect?tenantId=attacker-tenant',
    } as unknown as IncomingMessage,
    response,
  );

  assert.deepEqual(received, { authorization: 'Bearer token', tabId: 'tab-a' });
});
