/** C5: Keycloak 26.7.5 จริง → confidential introspection → PostgreSQL/RLS auth epoch */
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import test from 'node:test';
import { withTenantDatabaseTransaction } from '@d-contact/db';
import { KeycloakAccessTokenVerifier } from '@d-contact/workspace-session';
import { coreIdentitySandbox } from './tenant-core-identity-sandbox.js';
import { C360WorkAuthService, KeycloakC360TokenIntrospector } from './customer-360-work-auth.js';
import { WorkSessionLeases } from './work-session.js';

const sandbox = process.env.CORE_IDENTITY_SANDBOX_URL;
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
