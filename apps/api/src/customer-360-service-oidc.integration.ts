import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { Controller, Get, Inject, Req, UseFilters } from '@nestjs/common';
import { withTenantDatabaseTransaction, type PrismaClient } from '@d-contact/db';
import {
  KeycloakAccessTokenVerifier,
  toVerifiedServiceIdentity,
  type VerifiedOidcClaims,
} from '@d-contact/workspace-session';
import {
  GatewayServiceRoles,
  GatewayServiceScopes,
  type AuthenticatedGatewayRequest,
} from './gateway-auth.js';
import { CUSTOMER_360_DATABASE, Customer360Errors } from './customer-360-api.js';
import { currentC360ServicePrincipal } from './customer-360-service-identity.js';
import { Customer360OperatorController } from './customer-360-operator-api.js';
import { coreFixture } from './tenant-core-test-fixtures.js';

/** Test-only probe: ใช้ global gateway และ shared principal guard จริง ไม่เปิด customer CRUD ของ slice B */
@Controller('api/v1/m3-test-probe')
@GatewayServiceRoles('service')
@GatewayServiceScopes('customer360.contacts.read')
@UseFilters(Customer360Errors)
class ServiceProbe {
  constructor(@Inject(CUSTOMER_360_DATABASE) private readonly db: PrismaClient) {}
  @Get()
  async read(@Req() req: AuthenticatedGatewayRequest) {
    return withTenantDatabaseTransaction(
      this.db,
      req.gatewayServiceIdentity!.tenantId,
      async (tx) => {
        const p = await currentC360ServicePrincipal(tx, req);
        return { principalId: p.id, authzEpoch: p.authz_epoch.toString() };
      },
    );
  }
}

const kc = process.env.M3_KEYCLOAK_URL;
test(
  'M3-A actual Keycloak client_credentials: audience/issuer/tenant/scopes/rotation และ mixed token operator denial',
  { skip: !kc },
  async () => {
    const realm = `m3-${randomUUID()}`,
      issuer = `${kc}/realms/${realm}`;
    const actual = new KeycloakAccessTokenVerifier({
      issuer,
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
      audience: 'dcontact-api',
    });
    let f: Awaited<ReturnType<typeof coreFixture>>;
    // Operator ของ test ยังคง synthetic trusted fixture; service tokens มาจาก Keycloak จริงทุกตัว
    const verifier = {
      verifyAccessToken: async (token: string): Promise<VerifiedOidcClaims> => {
        if (token !== 'operator') return actual.verifyAccessToken(token);
        const id = f.actors.get('operator')!.id;
        return {
          iss: 'https://core-idp.test/realms/dcontact',
          sub: id,
          azp: 'dcontact-console',
          tenant_id: f.tenantId,
          tenant_slug: `core-${f.tenantId}`,
          organization: { [`core-${f.tenantId}`]: { tenant_id: [f.tenantId] } },
          dc_user_id: id,
          sid: 'operator-session',
          exp: 2000000000,
          realm_access: { roles: ['platform-operator'] },
        } as VerifiedOidcClaims;
      },
    };
    f = await coreFixture([Customer360OperatorController, ServiceProbe], verifier);
    f.actors.set('operator', { id: randomUUID(), role: 'PLATFORM-OPERATOR', tenantId: f.tenantId });
    const adminResponse = await fetch(`${kc}/realms/master/protocol/openid-connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'password',
        client_id: 'admin-cli',
        username: 'fixture-admin',
        password: process.env.M3_KEYCLOAK_ADMIN_PASSWORD ?? 'fixture-admin-841',
      }),
    });
    assert.equal(adminResponse.status, 200);
    const admin = ((await adminResponse.json()) as { access_token: string }).access_token;
    const adminHeaders = { authorization: `Bearer ${admin}`, 'content-type': 'application/json' };
    const claim = (name: string, value: string, type = 'String') => ({
      name,
      protocol: 'openid-connect',
      protocolMapper: 'oidc-hardcoded-claim-mapper',
      config: {
        'claim.name': name,
        'claim.value': value,
        'jsonType.label': type,
        'access.token.claim': 'true',
        'id.token.claim': 'false',
      },
    });
    const client = (id: string, tenantId = f.tenantId, audience = true, mixed = false) => ({
      clientId: id,
      enabled: true,
      publicClient: false,
      secret: 'm3-841-synthetic',
      protocol: 'openid-connect',
      serviceAccountsEnabled: true,
      standardFlowEnabled: false,
      directAccessGrantsEnabled: false,
      defaultClientScopes: ['roles', 'profile', 'customer360.contacts.read'],
      protocolMappers: [
        {
          name: 'realm-roles',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-usermodel-realm-role-mapper',
          config: {
            'claim.name': 'realm_access.roles',
            multivalued: 'true',
            'jsonType.label': 'String',
            'access.token.claim': 'true',
          },
        },
        {
          name: 'username',
          protocol: 'openid-connect',
          protocolMapper: 'oidc-usermodel-property-mapper',
          config: {
            'user.attribute': 'username',
            'claim.name': 'preferred_username',
            'jsonType.label': 'String',
            'access.token.claim': 'true',
          },
        },
        claim('tenant_id', tenantId),
        claim('tenant_slug', `core-${tenantId}`),
        claim(
          'organization',
          JSON.stringify({ [`core-${tenantId}`]: { tenant_id: [tenantId] } }),
          'JSON',
        ),
        ...(audience
          ? [
              {
                name: 'api-audience',
                protocol: 'openid-connect',
                protocolMapper: 'oidc-audience-mapper',
                config: {
                  'included.custom.audience': 'dcontact-api',
                  'access.token.claim': 'true',
                },
              },
            ]
          : []),
        ...(mixed
          ? [claim('dc_user_id', f.actors.get('admin')!.id), claim('sid', 'mixed-session')]
          : []),
      ],
    });
    const clients = [
      client('reference-841'),
      client('foreign-841', f.otherTenantId),
      client('wrong-audience', f.tenantId, false),
      client('mixed-841', f.tenantId, true, true),
      { ...client('without-scope'), defaultClientScopes: ['roles', 'profile'] },
    ];
    const realmBody = {
      realm,
      enabled: true,
      roles: { realm: [{ name: 'service' }, { name: 'platform-operator' }] },
      clientScopes: [
        {
          name: 'customer360.contacts.read',
          protocol: 'openid-connect',
          attributes: { 'include.in.token.scope': 'true' },
        },
      ],
      clients,
      users: clients.map((c) => ({
        username: `service-account-${c.clientId}`,
        enabled: true,
        serviceAccountClientId: c.clientId,
        realmRoles: c.clientId === 'mixed-841' ? ['service', 'platform-operator'] : ['service'],
      })),
    };
    try {
      const created = await fetch(`${kc}/admin/realms`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify(realmBody),
      });
      assert.equal(created.status, 201, `realm creation status ${created.status}`);
      const token = async (id = 'reference-841', secret = 'm3-841-synthetic') => {
        const r = await fetch(`${issuer}/protocol/openid-connect/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            grant_type: 'client_credentials',
            client_id: id,
            client_secret: secret,
          }),
        });
        return { status: r.status, body: (await r.json()) as { access_token: string } };
      };
      const minted = await token();
      assert.equal(minted.status, 200);
      const claims = await actual.verifyAccessToken(minted.body.access_token);
      assert.doesNotThrow(() => toVerifiedServiceIdentity(claims));
      const before = await f.request('m3-test-probe', minted.body.access_token);
      assert.equal(before.status, 403);
      const command = {
        action: 'SERVICE_BIND_CREATE',
        issuer,
        subject: claims.sub,
        clientId: 'reference-841',
        custodianAdminId: f.actors.get('admin')!.id,
      };
      const createdBinding = await f.request(
        'customer-360/operator/commands',
        'operator',
        {
          commandId: randomUUID(),
          evidenceRef: 'ticket:M3-841-OIDC',
          reasonCode: 'APPROVED_INTEGRATION',
          command,
        },
        'POST',
      );
      assert.equal(createdBinding.status, 201);
      assert.equal((await f.request('m3-test-probe', minted.body.access_token)).status, 200);
      assert.equal(
        (await f.request('m3-test-probe', (await token('foreign-841')).body.access_token)).status,
        403,
      );
      assert.equal(
        (await f.request('m3-test-probe', (await token('wrong-audience')).body.access_token))
          .status,
        401,
      );
      assert.equal(
        (await f.request('m3-test-probe', (await token('without-scope')).body.access_token)).status,
        403,
      );
      const mixed = (await token('mixed-841')).body.access_token;
      assert.equal((await f.request('m3-test-probe', mixed)).status, 401);
      assert.equal(
        (
          await f.request(
            'customer-360/operator/commands',
            mixed,
            {
              commandId: randomUUID(),
              evidenceRef: 'ticket:M3-MIXED',
              reasonCode: 'APPROVED_INTEGRATION',
              command,
            },
            'POST',
          )
        ).status,
        403,
      );
      const wrongIssuer = new KeycloakAccessTokenVerifier({
        issuer: `${kc}/realms/not-this-realm`,
        jwksUri: `${issuer}/protocol/openid-connect/certs`,
        audience: 'dcontact-api',
      });
      await assert.rejects(() => wrongIssuer.verifyAccessToken(minted.body.access_token));
      const list = await fetch(`${kc}/admin/realms/${realm}/clients?clientId=reference-841`, {
        headers: adminHeaders,
      });
      const [{ id }] = (await list.json()) as { id: string }[];
      const rotated = await fetch(`${kc}/admin/realms/${realm}/clients/${id}/client-secret`, {
        method: 'POST',
        headers: adminHeaders,
      });
      assert.equal(rotated.status, 200);
      const newSecret = ((await rotated.json()) as { value: string }).value;
      assert.notEqual((await token('reference-841', 'm3-841-synthetic')).status, 200);
      const replacement = await token('reference-841', newSecret);
      assert.equal(replacement.status, 200);
      assert.equal((await actual.verifyAccessToken(replacement.body.access_token)).sub, claims.sub);
      assert.equal((await f.request('m3-test-probe', replacement.body.access_token)).status, 200);
      const binding = await f.owner.intServicePrincipal.findFirstOrThrow({
        where: { tenantId: f.tenantId },
      });
      const disabled = await f.request(
        'customer-360/operator/commands',
        'operator',
        {
          commandId: randomUUID(),
          evidenceRef: 'ticket:M3-841-DISABLE',
          reasonCode: 'APPROVED_DISABLE',
          command: {
            action: 'SERVICE_BIND_DISABLE',
            bindingId: binding.id,
            expectedAuthzEpoch: '0',
          },
        },
        'POST',
      );
      assert.equal(disabled.status, 201);
      assert.equal((await f.request('m3-test-probe', replacement.body.access_token)).status, 403);
    } finally {
      await fetch(`${kc}/admin/realms/${realm}`, { method: 'DELETE', headers: adminHeaders });
      await f.close();
    }
  },
);
