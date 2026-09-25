import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { Body, Controller, Module, Post, Req } from '@nestjs/common';
import { APP_GUARD, NestFactory } from '@nestjs/core';
import type { VerifiedOidcClaims } from '@d-contact/workspace-session';
import {
  GATEWAY_DIAGNOSTICS,
  GatewayRoles,
  GatewayServiceScopes,
  OIDC_ACCESS_TOKEN_VERIFIER,
  OidcGlobalGuard,
  type AuthenticatedGatewayRequest,
  type GatewayDiagnostic,
  TENANT_LIFECYCLE,
} from './gateway-auth.js';

const tenantId = '4e342ec5-d35b-41ed-bd44-1cf47a41af4b';
const userId = '619b9c43-8495-420d-b3d3-34d9fd0b5b89';

function claims(roles: string[], exp = 2_000_000_000): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: 'demo',
    organization: { demo: { tenant_id: [tenantId] } },
    dc_user_id: userId,
    sid: 'keycloak-session-1',
    exp,
    realm_access: { roles },
  };
}

function serviceClaims(scope: string): VerifiedOidcClaims {
  return {
    tenant_id: tenantId,
    tenant_slug: 'demo',
    organization: { demo: { tenant_id: [tenantId] } },
    exp: 2_000_000_000,
    realm_access: { roles: ['contact-governance-source'] },
    azp: 'governance-reader',
    preferred_username: 'service-account-governance-reader',
    sub: 'service-subject-1',
    scope,
  };
}

@Controller('service-probe')
class ServiceProbeController {
  @Post()
  @GatewayServiceScopes('governance:read')
  probe(@Req() request: AuthenticatedGatewayRequest) {
    return {
      tenantId: request.gatewayServiceIdentity?.tenantId,
      clientId: request.gatewayServiceIdentity?.clientId,
    };
  }
}

@Controller('probe')
class ProbeController {
  @Post()
  @GatewayRoles('agent', 'supervisor', 'admin')
  probe(@Req() request: AuthenticatedGatewayRequest, @Body() _body: unknown) {
    return {
      tenantId: request.gatewayIdentity?.tenantId,
      correlationId: request.correlationId,
    };
  }
}

test('API Gateway exposes 401/403 and derives tenant context only from verified claims', async (t) => {
  const diagnostics: GatewayDiagnostic[] = [];
  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'invalid-token') throw new Error('invalid signature');
      if (token === 'expired-token') return claims(['agent'], 1);
      if (token === 'viewer-token') return claims(['viewer']);
      if (token === 'agent-token') return claims(['agent']);
      if (token === 'service-read-token')
        return serviceClaims('governance:read governance:evidence');
      if (token === 'service-no-scope-token') return serviceClaims('governance:evidence');
      throw new Error('unknown token');
    },
  };

  @Module({
    controllers: [ProbeController, ServiceProbeController],
    providers: [
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      {
        provide: GATEWAY_DIAGNOSTICS,
        useValue: { write: (event: GatewayDiagnostic) => diagnostics.push(event) },
      },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class TestModule {}

  const app = await NestFactory.create(TestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/probe?tenantId=attacker-tenant`;
  const request = (token?: string, correlationId?: string) =>
    fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(correlationId ? { 'x-correlation-id': correlationId } : {}),
        'x-tenant-id': 'attacker-tenant',
      },
      body: JSON.stringify({ tenantId: 'attacker-tenant', credential: 'must-not-be-logged' }),
    });

  assert.equal((await request()).status, 401);
  assert.equal((await request('invalid-token')).status, 401);
  assert.equal((await request('expired-token')).status, 401);
  assert.equal((await request('viewer-token')).status, 403);

  const accepted = await request('agent-token', 'correlation-test-33');
  assert.equal(accepted.status, 201);
  assert.equal(accepted.headers.get('x-correlation-id'), 'correlation-test-33');
  assert.deepEqual(await accepted.json(), {
    tenantId,
    correlationId: 'correlation-test-33',
  });

  assert.deepEqual(
    diagnostics.map(({ event, reason }) => ({ event, reason })),
    [
      { event: 'gateway.request.denied', reason: 'unauthenticated' },
      { event: 'gateway.request.denied', reason: 'unauthenticated' },
      { event: 'gateway.request.denied', reason: 'unauthenticated' },
      { event: 'gateway.request.denied', reason: 'forbidden' },
      { event: 'gateway.request.authorized', reason: undefined },
    ],
  );
  const serializedDiagnostics = JSON.stringify(diagnostics);
  assert.doesNotMatch(serializedDiagnostics, /agent-token|invalid-token|must-not-be-logged/);
});

test('service route ต้องมี governance:read scope และ derivation tenant/client มาจาก token', async (t) => {
  const verifier = {
    verifyAccessToken: async (token: string) => {
      if (token === 'read') return serviceClaims('governance:read');
      if (token === 'evidence-only') return serviceClaims('governance:evidence');
      throw new Error('unknown token');
    },
  };
  @Module({
    controllers: [ServiceProbeController],
    providers: [
      { provide: OIDC_ACCESS_TOKEN_VERIFIER, useValue: verifier },
      { provide: TENANT_LIFECYCLE, useValue: { isActive: async () => true } },
      { provide: GATEWAY_DIAGNOSTICS, useValue: { write: () => undefined } },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class ServiceTestModule {}
  const app = await NestFactory.create(ServiceTestModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address() as AddressInfo;
  const endpoint = `http://127.0.0.1:${address.port}/service-probe?tenantId=attacker`;
  const call = (token: string) =>
    fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${token}` } });

  assert.equal((await call('evidence-only')).status, 403);
  const accepted = await call('read');
  assert.equal(accepted.status, 201);
  assert.deepEqual(await accepted.json(), { tenantId, clientId: 'governance-reader' });
});

test('A1.8a (#447): tenant ที่ยังไม่ ACTIVE ถูกปฏิเสธ 401 ทั้ง workspace และ service identity', async (t) => {
  const diagnostics: GatewayDiagnostic[] = [];
  let active = false;
  const checked: string[] = [];
  @Module({
    controllers: [ProbeController, ServiceProbeController],
    providers: [
      {
        provide: OIDC_ACCESS_TOKEN_VERIFIER,
        useValue: {
          verifyAccessToken: async (token: string) =>
            token === 'service-token' ? serviceClaims('governance:read') : claims(['admin']),
        },
      },
      {
        provide: TENANT_LIFECYCLE,
        useValue: {
          isActive: async (id: string) => {
            checked.push(id);
            return active;
          },
        },
      },
      {
        provide: GATEWAY_DIAGNOSTICS,
        useValue: { write: (event: GatewayDiagnostic) => diagnostics.push(event) },
      },
      { provide: APP_GUARD, useClass: OidcGlobalGuard },
    ],
  })
  class LifecycleModule {}

  const app = await NestFactory.create(LifecycleModule, { logger: false });
  await app.listen(0, '127.0.0.1');
  t.after(() => app.close());
  const address = app.getHttpServer().address() as AddressInfo;
  const call = (path: string, token: string, method = 'POST') =>
    fetch(`http://127.0.0.1:${address.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
      ...(method === 'POST' ? { body: '{}' } : {}),
    });

  // first admin ของ tenant ที่ยัง PROVISIONING: token ถูกต้องแต่เข้าไม่ได้ และตอบเหมือน token ใช้ไม่ได้
  const denied = await call('/probe', 'first-admin-token');
  assert.equal(denied.status, 401);
  assert.deepEqual(checked, [tenantId]);
  assert.deepEqual(
    diagnostics.map(({ event, reason }) => ({ event, reason })),
    [{ event: 'gateway.request.denied', reason: 'unauthenticated' }],
  );

  // service identity (client_credentials) ของ tenant ที่ยังไม่ ACTIVE ก็เข้าไม่ได้
  assert.equal((await call('/service-probe', 'service-token')).status, 401);

  active = true;
  assert.equal((await call('/probe', 'first-admin-token')).status, 201);
  assert.equal((await call('/service-probe', 'service-token')).status, 201);
});
