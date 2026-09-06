import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentWorkspaceApi } from './agent-api.js';

test('Agent API ส่งเฉพาะ bearer token และไม่รับ tenant/user จาก browser', async () => {
  const requests: { input: string; init?: RequestInit }[] = [];
  const api = createAgentWorkspaceApi({
    baseUrl: 'https://api.example',
    accessToken: () => 'access-token-in-memory',
    fetch: async (input, init) => {
      requests.push({ input: input.toString(), init });
      return new Response(
        JSON.stringify({
          agent: { id: 'agent-1', displayName: 'Agent One', extension: '1000', state: 'OFFLINE' },
          interaction: null,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    },
  });

  const snapshot = await api.snapshot();
  await api.sipCredentials();
  await api.submitWrapup({
    interactionId: '9a8a5477-aa53-4254-ae68-a21ab64cc2bb',
    disposition: 'CUSTOMER_ASSISTED',
    commandId: '04e5b24d-f298-4e5e-83d9-2cadfd7ed204',
  });

  assert.equal(snapshot.agent.id, 'agent-1');
  assert.equal(requests[0]?.input, 'https://api.example/api/v1/workspace/agent/snapshot');
  assert.deepEqual(requests[0]?.init?.headers, { authorization: 'Bearer access-token-in-memory' });
  assert.equal(requests[1]?.input, 'https://api.example/api/v1/workspace/agent/sip-credentials');
  assert.equal(
    requests[2]?.input,
    'https://api.example/api/v1/workspace/agent/interactions/9a8a5477-aa53-4254-ae68-a21ab64cc2bb/wrapup',
  );
  assert.equal(requests[2]?.init?.method, 'POST');
  assert.deepEqual(JSON.parse(requests[2]?.init?.body as string), {
    disposition: 'CUSTOMER_ASSISTED',
    commandId: '04e5b24d-f298-4e5e-83d9-2cadfd7ed204',
  });
});

test('Agent API ปฏิเสธการเรียกเมื่อไม่มี access token ใน memory', async () => {
  const api = createAgentWorkspaceApi({
    baseUrl: 'https://api.example',
    accessToken: () => undefined,
    fetch: async () => new Response(),
  });

  await assert.rejects(api.snapshot(), /authenticated access token/);
});
