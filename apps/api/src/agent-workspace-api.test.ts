import assert from 'node:assert/strict';
import test from 'node:test';
import { configuredAgentSipLeaseProvider } from './agent-workspace-api.js';

test('dev browser softphone receives the documented localhost WebSocket endpoint', async () => {
  const provider = configuredAgentSipLeaseProvider({
    SIP_BROWSER_NODES_JSON: JSON.stringify([
      { telephonyNodeId: 'fs-local', wssUrl: 'ws://localhost:5066' },
    ]),
  });

  const lease = await provider.issue({
    tenantId: 'tenant-demo',
    userId: 'agent-1000',
    extension: '1000',
    authorizationPassword: 'not-a-real-password',
    sipDomain: 'demo.local',
  });

  assert.equal(lease.wssUrl, 'ws://localhost:5066');
});
