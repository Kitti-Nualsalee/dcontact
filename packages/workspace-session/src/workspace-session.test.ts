import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

import {
  KeycloakAccessTokenVerifier,
  WorkspaceSessionRegistry,
  WorkspaceSessionGateway,
  toVerifiedWorkspaceIdentity,
  type VerifiedWorkspaceIdentity,
} from './workspace-session.js';
import { WorkspaceSessionHttpAdapter } from './http-session-adapter.js';
import { WorkspaceSessionWebSocketAdapter } from './websocket-session-adapter.js';

const agent: VerifiedWorkspaceIdentity = {
  tenantId: '4e342ec5-d35b-41ed-bd44-1cf47a41af4b',
  userId: '619b9c43-8495-420d-b3d3-34d9fd0b5b89',
  sessionId: 'keycloak-session-1',
  roles: ['agent'],
  expiresAt: new Date('2026-09-03T10:10:00.000Z'),
};

test('only the elected working tab can receive routing work', () => {
  const registry = new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z'));

  const first = registry.connect(agent, 'tab-a');
  const second = registry.connect(agent, 'tab-b');

  assert.equal(first.routingEnabled, true);
  assert.equal(first.availability, 'AVAILABLE');
  assert.equal(second.routingEnabled, false);
  assert.equal(second.availability, 'OFFLINE');
  assert.equal(registry.canReceiveRoutingWork(agent.tenantId, agent.userId, 'tab-a'), true);
  assert.equal(registry.canReceiveRoutingWork(agent.tenantId, agent.userId, 'tab-b'), false);
});

test('a user can move the working session to another tab without two leaders', () => {
  const registry = new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z'));

  registry.connect(agent, 'tab-a');
  const moved = registry.claimWorkingTab(agent, 'tab-b');

  assert.equal(moved.routingEnabled, true);
  assert.equal(moved.availability, 'AVAILABLE');
  assert.equal(registry.canReceiveRoutingWork(agent.tenantId, agent.userId, 'tab-a'), false);
  assert.equal(registry.canReceiveRoutingWork(agent.tenantId, agent.userId, 'tab-b'), true);
});

test('an expired refresh revokes routing work but preserves the visible session', () => {
  const registry = new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z'));

  registry.connect(agent, 'tab-a');
  const result = registry.refresh(
    { ...agent, expiresAt: new Date('2026-09-03T09:59:59.000Z') },
    'tab-a',
  );

  assert.equal(result.routingEnabled, false);
  assert.equal(result.status, 'reauthentication-required');
  assert.equal(result.availability, 'OFFLINE');
  assert.equal(registry.canReceiveRoutingWork(agent.tenantId, agent.userId, 'tab-a'), false);
});

test('failed reauthentication blocks new work without dropping an interaction already held', () => {
  const registry = new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z'));
  registry.connect(agent, 'tab-a');
  registry.holdInteraction(agent.tenantId, agent.userId, 'tab-a', 'interaction-42');

  const result = registry.requireReauthentication(agent.tenantId, agent.userId, 'tab-a');

  assert.equal(result.routingEnabled, false);
  assert.equal(result.availability, 'OFFLINE');
  assert.equal(result.activeInteractionId, 'interaction-42');
});

test('a token cannot change the tenant of an established workspace session', () => {
  const registry = new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z'));

  registry.connect(agent, 'tab-a');

  assert.throws(
    () => registry.refresh({ ...agent, tenantId: '4d600b19-f7cf-437f-9b2a-e4d5d3f2646e' }, 'tab-a'),
    /tenant context/i,
  );
});

test('only verified OIDC claims can establish a tenant-bound workspace identity', () => {
  const identity = toVerifiedWorkspaceIdentity(
    {
      tenant_id: agent.tenantId,
      tenant_slug: 'demo',
      organization: { demo: { tenant_id: [agent.tenantId] } },
      dc_user_id: agent.userId,
      sid: agent.sessionId,
      exp: 1_788_430_200,
      realm_access: { roles: ['agent'] },
    },
    new Date('2026-09-03T10:00:00.000Z'),
  );

  assert.deepEqual(identity, agent);
});

test('OIDC claims without a tenant context cannot open a workspace session', () => {
  assert.throws(
    () =>
      toVerifiedWorkspaceIdentity(
        {
          dc_user_id: agent.userId,
          sid: agent.sessionId,
          exp: 1_788_430_200,
          realm_access: { roles: ['agent'] },
        },
        new Date('2026-09-03T10:00:00.000Z'),
      ),
    /tenant_id/i,
  );
});

test('the handshake verifies an access token before it enables routing', async () => {
  const gateway = new WorkspaceSessionGateway(
    {
      verifyAccessToken: async (accessToken) => {
        assert.equal(accessToken, 'verified-access-token');
        return {
          tenant_id: agent.tenantId,
          tenant_slug: 'demo',
          organization: { demo: { tenant_id: [agent.tenantId] } },
          dc_user_id: agent.userId,
          sid: agent.sessionId,
          exp: 1_788_430_200,
          realm_access: { roles: ['agent'] },
        };
      },
    },
    new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z')),
    () => new Date('2026-09-03T10:00:00.000Z'),
  );

  const session = await gateway.connect({ accessToken: 'verified-access-token', tabId: 'tab-a' });

  assert.equal(session.routingEnabled, true);
  assert.equal(session.tenantId, agent.tenantId);
});

test('Keycloak verifier accepts a signed access token through its JWKS boundary', async (t) => {
  const issuer = 'http://127.0.0.1/keycloak/realms/d-contact';
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const publicJwk = { ...(await exportJWK(publicKey)), kid: 'test-key', use: 'sig', alg: 'RS256' };
  const jwksServer = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ keys: [publicJwk] }));
  });
  await new Promise<void>((resolve) => jwksServer.listen(0, '127.0.0.1', resolve));
  t.after(() => jwksServer.close());
  const address = jwksServer.address();
  assert.ok(address && typeof address !== 'string');
  const verifier = new KeycloakAccessTokenVerifier({
    issuer,
    audience: 'dcontact-api',
    jwksUri: `http://127.0.0.1:${address.port}/jwks`,
  });
  const token = await new SignJWT({
    tenant_id: agent.tenantId,
    tenant_slug: 'demo',
    organization: { demo: { tenant_id: [agent.tenantId] } },
    dc_user_id: agent.userId,
    sid: agent.sessionId,
    realm_access: { roles: ['agent'] },
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'Bearer' })
    .setIssuer(issuer)
    .setAudience('dcontact-api')
    .setExpirationTime('10m')
    .sign(privateKey);

  const claims = await verifier.verifyAccessToken(token);
  const identity = toVerifiedWorkspaceIdentity(claims);

  assert.equal(claims.tenant_id, agent.tenantId);
  assert.equal(identity.tenantId, agent.tenantId);
});

test('the transport adapter rejects a browser-supplied session without a bearer token', async () => {
  const adapter = new WorkspaceSessionHttpAdapter({} as WorkspaceSessionGateway);

  const response = await adapter.connect({ tabId: 'tab-a' });

  assert.deepEqual(response, { status: 401, body: { code: 'UNAUTHENTICATED' } });
});

test('WebSocket auth without a token is closed before it can receive routing events', async () => {
  const closed: unknown[] = [];
  const adapter = new WorkspaceSessionWebSocketAdapter({} as WorkspaceSessionGateway);

  await adapter.handle(
    { send: () => undefined, close: (code, reason) => closed.push({ code, reason }) },
    { type: 'auth:connect', tabId: 'tab-a' },
  );

  assert.deepEqual(closed, [{ code: 4401, reason: 'workspace authentication required' }]);
});

test('a failed silent refresh disables new routing work without closing the visible session', async () => {
  const sent: string[] = [];
  const closed: unknown[] = [];
  const registry = new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z'));
  const gateway = new WorkspaceSessionGateway(
    {
      verifyAccessToken: async (token) => {
        if (token === 'expired-refresh') throw new Error('expired');
        return {
          tenant_id: agent.tenantId,
          tenant_slug: 'demo',
          organization: { demo: { tenant_id: [agent.tenantId] } },
          dc_user_id: agent.userId,
          sid: agent.sessionId,
          exp: 1_788_430_200,
          realm_access: { roles: ['agent'] },
        };
      },
    },
    registry,
    () => new Date('2026-09-03T10:00:00.000Z'),
  );
  const adapter = new WorkspaceSessionWebSocketAdapter(gateway);
  const socket = {
    send: (message: string) => sent.push(message),
    close: (code: number, reason: string) => closed.push({ code, reason }),
  };

  await adapter.handle(socket, { type: 'auth:connect', accessToken: 'valid', tabId: 'tab-a' });
  await adapter.handle(socket, {
    type: 'auth:refresh',
    accessToken: 'expired-refresh',
    tabId: 'tab-a',
  });

  assert.equal(closed.length, 0);
  assert.equal(registry.canReceiveRoutingWork(agent.tenantId, agent.userId, 'tab-a'), false);
  assert.match(sent.at(-1) ?? '', /reauthentication-required/);
});

test('routing events are delivered only to the authenticated working tab', async () => {
  const registry = new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z'));
  const gateway = new WorkspaceSessionGateway(
    {
      verifyAccessToken: async () => ({
        tenant_id: agent.tenantId,
        tenant_slug: 'demo',
        organization: { demo: { tenant_id: [agent.tenantId] } },
        dc_user_id: agent.userId,
        sid: agent.sessionId,
        exp: 1_788_430_200,
        realm_access: { roles: ['agent'] },
      }),
    },
    registry,
    () => new Date('2026-09-03T10:00:00.000Z'),
  );
  const adapter = new WorkspaceSessionWebSocketAdapter(gateway);
  const leaderMessages: string[] = [];
  const followerMessages: string[] = [];
  const leader = {
    send: (message: string) => leaderMessages.push(message),
    close: () => undefined,
  };
  const follower = {
    send: (message: string) => followerMessages.push(message),
    close: () => undefined,
  };
  await adapter.handle(leader, { type: 'auth:connect', accessToken: 'valid', tabId: 'tab-a' });
  await adapter.handle(follower, { type: 'auth:connect', accessToken: 'valid', tabId: 'tab-b' });

  const delivered = await adapter.deliverRoutingEvent({
    type: 'routing.offered',
    interactionId: 'interaction-42',
    tenantId: agent.tenantId,
    userId: agent.userId,
  });

  assert.equal(delivered, 1);
  assert.match(leaderMessages.at(-1) ?? '', /routing\.offered/);
  assert.doesNotMatch(followerMessages.at(-1) ?? '', /routing\.offered/);
});

test('an authenticated WebSocket claim moves the server working tab within tenant scope', async () => {
  const registry = new WorkspaceSessionRegistry(() => new Date('2026-09-03T10:00:00.000Z'));
  const gateway = new WorkspaceSessionGateway(
    {
      verifyAccessToken: async () => ({
        tenant_id: agent.tenantId,
        tenant_slug: 'demo',
        organization: { demo: { tenant_id: [agent.tenantId] } },
        dc_user_id: agent.userId,
        sid: agent.sessionId,
        exp: 1_788_430_200,
        realm_access: { roles: ['agent'] },
      }),
    },
    registry,
    () => new Date('2026-09-03T10:00:00.000Z'),
  );
  const scopedTenants: string[] = [];
  const adapter = new WorkspaceSessionWebSocketAdapter(gateway, async (tenantId, work) => {
    scopedTenants.push(tenantId);
    return work();
  });
  const first = { send: () => undefined, close: () => undefined };
  const secondMessages: string[] = [];
  const second = {
    send: (message: string) => secondMessages.push(message),
    close: () => undefined,
  };
  await adapter.handle(first, { type: 'auth:connect', accessToken: 'valid', tabId: 'tab-a' });
  await adapter.handle(second, { type: 'auth:connect', accessToken: 'valid', tabId: 'tab-b' });

  await adapter.handle(second, { type: 'auth:claim', accessToken: 'valid', tabId: 'tab-b' });

  assert.equal(registry.canReceiveRoutingWork(agent.tenantId, agent.userId, 'tab-a'), false);
  assert.equal(registry.canReceiveRoutingWork(agent.tenantId, agent.userId, 'tab-b'), true);
  assert.match(secondMessages.at(-1) ?? '', /"availability":"AVAILABLE"/);
  assert.deepEqual(scopedTenants, [agent.tenantId, agent.tenantId, agent.tenantId]);
});
