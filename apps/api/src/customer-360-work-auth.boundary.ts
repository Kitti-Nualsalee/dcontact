/** C5: Keycloak 26.7.5 จริง → confidential introspection → PostgreSQL/RLS auth epoch */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import {
  C360SegmentEvaluator,
  C360SegmentMembershipRepository,
  C360SegmentRepository,
} from '@d-contact/customer-360';
import { DcExprEvaluator } from '@d-contact/expression';
import { IamTeamSegmentScopeRepository } from '@d-contact/iam';
import {
  KeycloakAccessTokenVerifier,
  WorkspaceSessionGateway,
  WorkspaceSessionRegistry,
  WorkspaceSessionWebSocketAdapter,
} from '@d-contact/workspace-session';
import WebSocket from 'ws';
import { attachWorkspaceSessionWebSocket } from './workspace-session-websocket.js';
import { CUSTOMER_360_WORK_AUTH, Customer360WorkController } from './customer-360-work-api.js';
import { ownerCommit, deliverToIam } from './customer-360-test-fixtures.js';
import { coreIdentitySandbox } from './tenant-core-identity-sandbox.js';
import { C360WorkAuthService, KeycloakC360TokenIntrospector } from './customer-360-work-auth.js';
import { WorkSessionLeases } from './work-session.js';

const sandbox = process.env.CORE_IDENTITY_SANDBOX_URL;
test(
  'C5 gateway WebSocket และ Keycloak จริง: refresh sid เดิมและ state หลัง expiry',
  { skip: !sandbox ? 'NOT_RUN: ต้องมี isolated Keycloak sandbox' : false, timeout: 180_000 },
  async (t) => {
    let workAuth!: C360WorkAuthService;
    const authProvider = new Proxy({} as C360WorkAuthService, {
      get: (_target, property) => {
        if (!workAuth) return undefined;
        const value = Reflect.get(workAuth, property, workAuth);
        return typeof value === 'function' ? value.bind(workAuth) : value;
      },
    });
    const { f, admin, prefix, issuer, verifier, password } = await coreIdentitySandbox(
      (cleanup) => t.after(cleanup),
      [Customer360WorkController],
      undefined,
      [{ provide: CUSTOMER_360_WORK_AUTH, useValue: authProvider }],
    );
    const realm = await admin<Record<string, unknown>>('GET', prefix);
    await admin('PUT', prefix, { ...realm, accessTokenLifespan: 12 });
    const [backend] = await admin<{ id: string }[]>(
      'GET',
      `${prefix}/clients?clientId=dcontact-api`,
    );
    assert.ok(backend);
    const existing = await admin<Record<string, unknown>>('GET', `${prefix}/clients/${backend.id}`);
    const secret = randomBytes(24).toString('hex');
    await admin('PUT', `${prefix}/clients/${backend.id}`, {
      ...existing,
      bearerOnly: false,
      publicClient: false,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      clientAuthenticatorType: 'client-secret',
      secret,
    });
    const service = new C360WorkAuthService(
      f.db,
      verifier,
      new KeycloakC360TokenIntrospector({ issuer, clientId: 'dcontact-api', clientSecret: secret }),
    );
    workAuth = service;
    const actor = { tenantId: f.tenantId, userId: f.actors.get('agent')!.id };
    const contactId = randomUUID();
    await f.owner.contact.create({
      data: { id: contactId, tenantId: f.tenantId, displayName: 'ลูกค้าทดลอง recovery' },
    });
    const segmentId = `segment:recovery-${f.tenantId.slice(0, 8)}`;
    const evaluator = new C360SegmentEvaluator(new DcExprEvaluator());
    const segments = new C360SegmentRepository(f.db, evaluator);
    const draft = await segments.createVersion({
      tenantId: f.tenantId,
      segmentId,
      version: 1,
      definition: {
        contractVersion: 1,
        name: 'Recovery',
        expression: {
          language: 'DC_EXPR',
          version: 1,
          expression: {
            type: 'comparison',
            operator: 'eq',
            left: { type: 'ref', path: ['contact', 'tier'] },
            right: { type: 'literal', value: 'GOLD' },
          },
        },
      },
      correlationId: 'recovery-segment',
    });
    await segments.publishVersion({
      tenantId: f.tenantId,
      segmentId,
      version: 1,
      expectedContentDigest: draft.contentDigest,
      expectedHeadVersion: 0,
    });
    const c360 = {
      ...f,
      contactId,
      segmentId,
      segments,
      memberships: new C360SegmentMembershipRepository(f.db, evaluator),
      scopes: new IamTeamSegmentScopeRepository(f.db),
      snapshotVersion: 0,
      membershipRevision: 0,
    };
    for (const permission of ['WORK', 'VIEW'] as const)
      await c360.scopes.grant({
        tenantId: f.tenantId,
        teamId: f.teamId,
        segmentId,
        permission,
        correlationId: 'recovery-grant',
      });
    await ownerCommit(c360, 'GOLD');
    await deliverToIam(c360);
    const leases = new WorkSessionLeases(f.db);
    const lease = await leases.acquire(
      actor,
      { surface: 'workspace', hostOrigin: null },
      'gateway-expiry',
    );
    const interactionId = randomUUID();
    await f.owner.interaction.create({
      data: {
        id: interactionId,
        tenantId: actor.tenantId,
        agentId: actor.userId,
        contactId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'ACTIVE',
      },
    });
    const gateway = new WorkspaceSessionGateway(verifier, new WorkspaceSessionRegistry(), {
      isActive: async () => true,
    });
    const adapter = new WorkspaceSessionWebSocketAdapter(
      gateway,
      undefined,
      undefined,
      leases,
      service,
    );
    const server = createServer();
    const wss = attachWorkspaceSessionWebSocket(server, adapter);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/api/v1/workspace-session`);
    t.after(async () => {
      socket.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => server.close(() => resolve()));
    });
    const messages: Record<string, unknown>[] = [];
    socket.on('message', (data) => messages.push(JSON.parse(data.toString())));
    await new Promise<void>((resolve, reject) => {
      socket.once('open', resolve);
      socket.once('error', reject);
    });
    async function token(body: URLSearchParams) {
      const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200);
      return (await response.json()) as { access_token: string; refresh_token: string };
    }
    const first = await token(
      new URLSearchParams({
        client_id: 'dcontact-console',
        grant_type: 'password',
        username: actor.userId,
        password,
        scope: `openid organization:core-${actor.tenantId}`,
      }),
    );
    const send = (accessToken: string, type: 'auth:connect' | 'auth:refresh') =>
      socket.send(JSON.stringify({ type, accessToken, tabId: 'a', leaseId: lease.leaseId }));
    async function waitMessages(count: number) {
      for (
        let n = 0;
        n < 200 && messages.filter((m) => m.type === 'workspace.session').length < count;
        n++
      )
        await delay(50);
      assert.equal(messages.filter((m) => m.type === 'workspace.session').length, count);
    }
    send(first.access_token, 'auth:connect');
    await waitMessages(1);
    const key = { tenantId_userId_leaseId: { ...actor, leaseId: lease.leaseId } };
    const original = await f.owner.c360WorkMutationAuth.findUniqueOrThrow({ where: key });
    const second = await token(
      new URLSearchParams({
        client_id: 'dcontact-console',
        grant_type: 'refresh_token',
        refresh_token: first.refresh_token,
      }),
    );
    send(second.access_token, 'auth:refresh');
    await waitMessages(2);
    const refreshed = await f.owner.c360WorkMutationAuth.findUniqueOrThrow({ where: key });
    assert.equal(refreshed.sid, original.sid);
    assert.equal(refreshed.authEpoch, original.authEpoch + 1n);
    assert.equal(refreshed.authState, 'ACTIVE');
    const payload = JSON.parse(
      Buffer.from(second.access_token.split('.')[1]!, 'base64url').toString(),
    ) as { exp: number };
    await delay(Math.max(0, payload.exp * 1000 + 1500 - Date.now()));
    send(second.access_token, 'auth:refresh');
    await waitMessages(3);
    const expired = await f.owner.c360WorkMutationAuth.findUniqueOrThrow({ where: key });
    assert.equal(expired.authState, 'REAUTH_REQUIRED');
    assert.equal(expired.authEpoch, refreshed.authEpoch + 1n);
    const session = messages.filter((m) => m.type === 'workspace.session').at(-1)!.session as {
      status: string;
    };
    assert.equal(session.status, 'reauthentication-required');
    assert.equal(
      (await f.owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: lease.leaseId } }))
        .releasedAt,
      null,
    );
    const fresh = await token(
      new URLSearchParams({
        client_id: 'dcontact-console',
        grant_type: 'refresh_token',
        refresh_token: second.refresh_token,
      }),
    );
    send(fresh.access_token, 'auth:refresh');
    await waitMessages(4);
    const recovered = await f.owner.c360WorkMutationAuth.findUniqueOrThrow({ where: key });
    assert.equal(recovered.authState, 'ACTIVE');
    assert.equal(recovered.sid, original.sid);
    assert.equal(recovered.authEpoch, expired.authEpoch + 1n);
    assert.equal(
      (messages.filter((m) => m.type === 'workspace.session').at(-1)!.session as { status: string })
        .status,
      'active',
    );
    assert.equal(
      (await f.owner.interaction.findUniqueOrThrow({ where: { id: interactionId } })).state,
      'ACTIVE',
    );
    const path = `${f.base}/api/v1/customer-360/work/${interactionId}/customer`;
    const headers = {
      authorization: `Bearer ${fresh.access_token}`,
      'content-type': 'application/json',
      'x-work-session-lease-id': lease.leaseId,
    };
    const read = await fetch(path, { headers });
    assert.equal(read.status, 200, await read.clone().text());
    const current = (await read.json()) as {
      revisions: { profile: string; lineage: string };
      canEdit: boolean;
    };
    assert.equal(current.canEdit, true);
    const mutation = await fetch(path, {
      method: 'PATCH',
      headers,
      body: JSON.stringify({
        commandId: randomUUID(),
        expectedLinkageRevision: '0',
        expectedProfileRevision: current.revisions.profile,
        expectedLineageRevision: current.revisions.lineage,
        displayName: 'แก้หลัง recovery',
      }),
    });
    assert.equal(mutation.status, 200, await mutation.clone().text());
    assert.equal(
      (await f.owner.contact.findUniqueOrThrow({ where: { id: contactId } })).displayName,
      'แก้หลัง recovery',
    );
    assert.ok(!JSON.stringify(messages).includes('tokenFingerprint'));
  },
);
test(
  'C5 Keycloak จริง: logout→inactive→fresh sid, audience และ introspection deadline',
  { skip: !sandbox ? 'NOT_RUN: ต้องมี isolated Keycloak sandbox' : false, timeout: 180_000 },
  async (t) => {
    const { f, admin, prefix, issuer, verifier, tokenFor, keycloakUsers } =
      await coreIdentitySandbox((cleanup) => t.after(cleanup));
    const [backend] = await admin<{ id: string }[]>(
      'GET',
      `${prefix}/clients?clientId=dcontact-api`,
    );
    assert.ok(backend);
    const existing = await admin<Record<string, unknown>>('GET', `${prefix}/clients/${backend.id}`);
    const clientSecret = randomBytes(24).toString('hex');
    await admin('PUT', `${prefix}/clients/${backend.id}`, {
      ...existing,
      bearerOnly: false,
      publicClient: false,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      clientAuthenticatorType: 'client-secret',
      secret: clientSecret,
    });
    const introspector = new KeycloakC360TokenIntrospector({
      issuer,
      clientId: 'dcontact-api',
      clientSecret,
    });
    const service = new C360WorkAuthService(f.db, verifier, introspector);
    const actor = { tenantId: f.tenantId, userId: f.actors.get('agent')!.id };
    const leases = new WorkSessionLeases(f.db);
    const lease = await leases.acquire(
      actor,
      { surface: 'workspace', hostOrigin: null },
      'c5-real-oidc',
    );
    await f.owner.interaction.create({
      data: {
        id: randomUUID(),
        tenantId: actor.tenantId,
        agentId: actor.userId,
        channel: 'VOICE',
        direction: 'INBOUND',
        state: 'ACTIVE',
      },
    });
    const first = await tokenFor('agent');
    const binding = await service.reauthenticate({ accessToken: first, leaseId: lease.leaseId });
    const proof = await service.verifyOnline({ accessToken: first, leaseId: lease.leaseId });
    await withTenantDatabaseTransaction(f.db, actor.tenantId, (tx) =>
      service.assertOnlineProof(tx, proof),
    );
    assert.equal((await introspector.introspect(first)).active, true);
    await admin('POST', `${prefix}/users/${keycloakUsers.get('agent')!.id}/logout`);
    assert.equal(
      (await introspector.introspect(first)).active,
      false,
      'logout จริงต้องทำให้ exact access token inactive',
    );
    await assert.rejects(
      () => service.verifyOnline({ accessToken: first, leaseId: lease.leaseId }),
      /WORK_REAUTH_REQUIRED/,
    );
    const second = await tokenFor('agent');
    const fresh = await service.reauthenticate({
      accessToken: second,
      leaseId: lease.leaseId,
      expected: binding,
    });
    assert.notEqual(fresh.sid, binding.sid);
    assert.equal(fresh.subject, binding.subject);
    assert.equal(await service.invalidateCaptured(binding, 'STALE_LOGOUT_CALLBACK'), false);
    assert.equal(
      (await f.owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: lease.leaseId } }))
        .releasedAt,
      null,
    );
    assert.equal(
      await f.owner.interaction.count({
        where: { tenantId: actor.tenantId, agentId: actor.userId, state: 'ACTIVE' },
      }),
      1,
    );

    const invalidAudience = new KeycloakAccessTokenVerifier({
      issuer,
      audience: 'not-the-backend-audience',
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
    });
    const wrongAudienceService = new C360WorkAuthService(f.db, invalidAudience, introspector);
    await assert.rejects(
      () => wrongAudienceService.verifyOnline({ accessToken: second, leaseId: lease.leaseId }),
      /WORK_REAUTH_REQUIRED/,
    );

    // Proxy ส่ง token ไป Keycloak จริง แต่หน่วง response เพื่อพิสูจน์ timeout โดยไม่ปลอม active=true
    let upstreamResult!: Record<string, unknown>;
    let finished!: () => void;
    const forwarded = new Promise<void>((resolve) => {
      finished = resolve;
    });
    const proxy = createServer(async (req, res) => {
      try {
        let body = '';
        for await (const chunk of req) body += chunk;
        const upstream = await fetch(`${issuer}/protocol/openid-connect/token/introspect`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body,
        });
        upstreamResult = (await upstream.json()) as Record<string, unknown>;
        finished();
        await delay(150);
        res.writeHead(upstream.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(upstreamResult));
      } catch {
        finished();
        res.destroy();
      }
    });
    await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise<void>((resolve) => proxy.close(() => resolve())));
    const address = proxy.address();
    assert.ok(address && typeof address === 'object');
    const timeoutService = new C360WorkAuthService(
      f.db,
      verifier,
      new KeycloakC360TokenIntrospector({
        issuer: `http://127.0.0.1:${address.port}/realms/deadline`,
        clientId: 'dcontact-api',
        clientSecret,
        timeoutMs: 50,
      }),
    );
    await assert.rejects(
      () => timeoutService.verifyOnline({ accessToken: second, leaseId: lease.leaseId }),
      /WORK_IDENTITY_UNAVAILABLE/,
    );
    await forwarded;
    assert.equal(
      upstreamResult.active,
      true,
      'upstream เป็นผล introspection จริงก่อน response timeout',
    );
    const auth = await f.owner.c360WorkMutationAuth.findUniqueOrThrow({
      where: { tenantId_userId_leaseId: { ...actor, leaseId: lease.leaseId } },
    });
    assert.equal(auth.authState, 'REAUTH_REQUIRED');
    assert.equal(
      (await f.owner.agentWorkSessionLease.findUniqueOrThrow({ where: { id: lease.leaseId } }))
        .releasedAt,
      null,
    );
  },
);
