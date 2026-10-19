/** ทดสอบ Keycloak/native Organization + verified proof + HTTP/PostgreSQL จริง ไม่ใช้ verifier stub */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import test from 'node:test';
import { KeycloakAccessTokenVerifier } from '@d-contact/workspace-session';
import { coreFixture } from './tenant-core-test-fixtures.js';

const sandbox = process.env.CORE_IDENTITY_SANDBOX_URL;
interface Scope {
  id: string;
  name: string;
  protocolMappers?: { id: string; protocolMapper: string; config: Record<string, string> }[];
}
interface KcUser {
  id: string;
  username: string;
}
interface KcOrg {
  id: string;
  alias: string;
}
interface KcRole {
  id: string;
  name: string;
}

test(
  'Core real identity boundary: Keycloak 26.7.5/native Organizations → JWKS → proof → HTTP/RLS',
  {
    skip: !sandbox ? 'NOT_RUN: ต้องระบุ CORE_IDENTITY_SANDBOX_URL ของ sandbox แยก' : false,
    timeout: 120_000,
  },
  async (t) => {
    assert.ok(sandbox);
    const origin = new URL(sandbox);
    assert.ok(
      ['127.0.0.1', 'localhost'].includes(origin.hostname),
      'ใช้เฉพาะ isolated loopback sandbox; ไม่เขียน realm บน VM',
    );
    const realm = `core725-${randomUUID()}`;
    const issuer = `${origin.origin}/realms/${realm}`;
    const password = `Core-${randomBytes(16).toString('hex')}`;
    const adminPassword = process.env.CORE_IDENTITY_SANDBOX_ADMIN_PASSWORD;
    assert.ok(adminPassword, 'ต้องมี sandbox admin password; ไม่ใช้ค่าของระบบจริง');
    const loginResponse = await fetch(
      `${origin.origin}/realms/master/protocol/openid-connect/token`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: 'admin-cli',
          grant_type: 'password',
          username: 'admin',
          password: adminPassword,
        }),
      },
    );
    assert.equal(loginResponse.status, 200, 'sandbox admin token');
    const { access_token: adminToken } = (await loginResponse.json()) as { access_token: string };
    let operatorSubject = '';
    async function admin<T = unknown>(method: string, path: string, body?: unknown) {
      const response = await fetch(`${origin.origin}/admin/${path}`, {
        method,
        headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.ok(response.ok, `sandbox ${method} ${path} → ${response.status}`);
      const text = await response.text();
      return (text ? JSON.parse(text) : undefined) as T;
    }
    const server = await admin<{ systemInfo: { version: string } }>('GET', 'serverinfo');
    assert.equal(
      server.systemInfo.version,
      '26.7.5',
      'identity boundary ต้องตรง pinned Keycloak version',
    );
    operatorSubject =
      (await admin<{ id: string }[]>('GET', 'realms/master/users?username=admin&exact=true'))[0]
        ?.id ?? '';
    assert.ok(operatorSubject, 'operator evidence ใช้identityที่อ่านจากadminAPIจริง');
    await admin('POST', 'realms', {
      realm,
      enabled: true,
      organizationsEnabled: true,
      sslRequired: 'none',
    });
    t.after(async () => {
      await admin('DELETE', `realms/${realm}`);
    });
    const prefix = `realms/${realm}`;
    const profile = await admin<{ attributes: Record<string, unknown>[] }>(
      'GET',
      `${prefix}/users/profile`,
    );
    await admin('PUT', `${prefix}/users/profile`, {
      ...profile,
      attributes: [
        ...profile.attributes,
        ...['tenant_id', 'tenant_slug', 'dc_user_id'].map((name) => ({
          name,
          multivalued: false,
          permissions: { view: ['admin'], edit: ['admin'] },
        })),
      ],
    });
    for (const name of ['agent', 'supervisor', 'admin'])
      await admin('POST', `${prefix}/roles`, { name });
    const roles = new Map(
      (await admin<KcRole[]>('GET', `${prefix}/roles`)).map((role) => [role.name, role]),
    );
    await admin('POST', `${prefix}/roles/admin/composites`, [
      roles.get('supervisor'),
      roles.get('agent'),
    ]);
    const scopes = await admin<Scope[]>('GET', `${prefix}/client-scopes`);
    const orgScope = scopes.find((s) => s.name === 'organization')!;
    assert.ok(orgScope, 'native Organization client scope ต้องมีจริง');
    const orgMapper = orgScope.protocolMappers?.find(
      (m) => m.protocolMapper === 'oidc-organization-membership-mapper',
    )!;
    assert.ok(orgMapper);
    await admin(
      'PUT',
      `${prefix}/client-scopes/${orgScope.id}/protocol-mappers/models/${orgMapper.id}`,
      {
        ...orgMapper,
        config: {
          ...orgMapper.config,
          addOrganizationAttributes: 'true',
          addOrganizationId: 'true',
          'jsonType.label': 'JSON',
        },
      },
    );
    await admin('POST', `${prefix}/clients`, {
      clientId: 'dcontact-api',
      protocol: 'openid-connect',
      bearerOnly: true,
    });
    for (const clientId of ['dcontact-console', 'unbound-console', 'platform-console']) {
      await admin('POST', `${prefix}/clients`, {
        clientId,
        enabled: true,
        protocol: 'openid-connect',
        publicClient: true,
        standardFlowEnabled: false,
        directAccessGrantsEnabled: true,
        defaultClientScopes: ['basic', 'roles'],
        protocolMappers: [
          {
            name: 'api audience',
            protocol: 'openid-connect',
            protocolMapper: 'oidc-audience-mapper',
            config: { 'included.client.audience': 'dcontact-api', 'access.token.claim': 'true' },
          },
          ...['tenant_id', 'tenant_slug', 'dc_user_id'].map((name) => ({
            name,
            protocol: 'openid-connect',
            protocolMapper: 'oidc-usermodel-attribute-mapper',
            config: {
              'user.attribute': name,
              'claim.name': name,
              'jsonType.label': 'String',
              'access.token.claim': 'true',
              multivalued: 'false',
            },
          })),
        ],
      });
      const [client] = await admin<{ id: string }[]>(
        'GET',
        `${prefix}/clients?clientId=${clientId}`,
      );
      assert.ok(client);
      await admin('PUT', `${prefix}/clients/${client.id}/optional-client-scopes/${orgScope.id}`);
    }
    const verifier = new KeycloakAccessTokenVerifier({
      issuer,
      audience: 'dcontact-api',
      jwksUri: `${issuer}/protocol/openid-connect/certs`,
    });
    const f = await coreFixture([], verifier);
    t.after(() => f.close());
    const orgs = new Map<string, KcOrg>();
    for (const tenantId of [f.tenantId, f.otherTenantId]) {
      await admin('POST', `${prefix}/organizations`, {
        name: `Core sandbox ${tenantId}`,
        alias: `core-${tenantId}`,
        enabled: true,
        attributes: { tenant_id: [tenantId], tenant_slug: [`core-${tenantId}`] },
      });
      const org = (await admin<KcOrg[]>('GET', `${prefix}/organizations`)).find(
        (o) => o.alias === `core-${tenantId}`,
      )!;
      assert.ok(org);
      orgs.set(tenantId, org);
    }
    const keycloakUsers = new Map<string, KcUser>();
    for (const [token, actor] of f.actors) {
      await admin('POST', `${prefix}/users`, {
        username: actor.id,
        email: `${actor.id}@core.test`,
        emailVerified: true,
        firstName: 'Core',
        lastName: 'Sandbox',
        enabled: true,
        requiredActions: [],
        credentials: [{ type: 'password', value: password, temporary: false }],
        attributes: {
          tenant_id: [actor.tenantId],
          tenant_slug: [`core-${actor.tenantId}`],
          dc_user_id: [actor.id],
        },
      });
      const [user] = await admin<KcUser[]>(
        'GET',
        `${prefix}/users?username=${actor.id}&exact=true`,
      );
      assert.ok(user);
      keycloakUsers.set(token, user);
      await admin('POST', `${prefix}/users/${user.id}/role-mappings/realm`, [
        roles.get(actor.role.toLowerCase()),
      ]);
      const org = orgs.get(actor.tenantId)!;
      await admin('POST', `${prefix}/organizations/${org.id}/members`, user.id);
      await f.owner.user.update({ where: { id: actor.id }, data: { keycloakId: user.id } });
      const evidence = createHash('sha256')
        .update(JSON.stringify([issuer, user.id, org.id, actor.id]))
        .digest('hex');
      await f.owner
        .$executeRaw`UPDATE tenant_voice_identity_bindings SET issuer=${issuer},subject_id=${user.id},organization_id=${org.id}::uuid,
      evidence_ref=${`sandbox-native-membership:${realm}:${org.id}`},evidence_digest=${evidence},verified_by_operator_subject=${operatorSubject},
      verified_at=now(),revision=revision+1 WHERE tenant_id=${actor.tenantId}::uuid AND user_id=${actor.id}::uuid`;
    }
    async function tokenFor(actorToken: string, clientId = 'dcontact-console', scope?: string) {
      const actor = f.actors.get(actorToken)!;
      const response = await fetch(`${issuer}/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: clientId,
          grant_type: 'password',
          username: actor.id,
          password,
          scope: scope ?? `openid organization:core-${actor.tenantId}`,
        }),
        signal: AbortSignal.timeout(10_000),
      });
      assert.equal(response.status, 200, `sandbox issue token ${actorToken}/${clientId}`);
      return ((await response.json()) as { access_token: string }).access_token;
    }
    const token = await tokenFor('admin');
    const verified = await verifier.verifyAccessToken(token);
    const orgClaim = verified.organization as Record<string, { tenant_id: string[] }>;
    assert.deepEqual(
      orgClaim[`core-${f.tenantId}`]?.tenant_id,
      [f.tenantId],
      'native claimมีtenantattributeจริง',
    );
    assert.equal((await f.request('tenant/core-settings/capabilities', token)).status, 200);
    assert.deepEqual(
      (await f.request('tenant-voice/capabilities', token)).body.configuration.reasons,
      ['RESOURCE_POLICY_NOT_READY'],
    );
    const commandId = randomUUID();
    assert.equal(
      (await f.request(`tenant/core-settings/commands/${commandId}/reconcile`, token, {})).body
        .command.outcome,
      'NOT_APPLIED',
    );
    const foreignToken = await tokenFor('foreign');
    assert.equal((await f.request('tenant/core-settings/capabilities', foreignToken)).status, 200);
    assert.equal(
      (await f.request(`tenant/core-settings/commands/${commandId}`, foreignToken)).status,
      404,
      'foreign authenticated identityต้องไม่เห็นreceipt',
    );
    assert.equal(
      (await f.request(`tenant/core-settings/commands/${commandId}`, await tokenFor('admin-two')))
        .status,
      404,
      'Adminอื่นในtenantเดียวกันต้องไม่เห็นreceipt',
    );
    for (const name of ['unbound', 'disabled', 'agent'])
      assert.equal(
        (await f.request('tenant/core-settings/capabilities', await tokenFor(name))).status,
        403,
        name,
      );
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', await tokenFor('supervisor'))).body
        .organization.write,
      false,
    );
    for (const client of ['unbound-console', 'platform-console'])
      assert.equal(
        (await f.request('tenant/core-settings/capabilities', await tokenFor('admin', client)))
          .status,
        403,
        client,
      );
    const signature = token.split('.');
    signature[2] = `${signature[2]![0] === 'a' ? 'b' : 'a'}${signature[2]!.slice(1)}`;
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', signature.join('.'))).status,
      401,
      'invalid signature',
    );
    const actor = f.actors.get('admin')!;
    await f.owner.user.update({ where: { id: actor.id }, data: { role: 'AGENT' } });
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', token)).status,
      403,
      'live domainrole beats still-valid admin JWT',
    );
    await f.owner.user.update({ where: { id: actor.id }, data: { role: 'ADMIN' } });
    await f.owner
      .$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=false,revision=revision+1 WHERE tenant_id=${f.tenantId}::uuid AND user_id=${actor.id}::uuid`;
    assert.equal(
      (await f.request('tenant/core-settings/capabilities', token)).status,
      403,
      'proofrevocation beats still-valid JWT',
    );
    await f.owner
      .$executeRaw`UPDATE tenant_voice_identity_bindings SET is_active=true,revision=revision+1 WHERE tenant_id=${f.tenantId}::uuid AND user_id=${actor.id}::uuid`;
    await admin(
      'POST',
      `${prefix}/organizations/${orgs.get(f.otherTenantId)!.id}/members`,
      keycloakUsers.get('admin')!.id,
    );
    const multiple = await tokenFor('admin', 'dcontact-console', 'openid organization:*');
    const response = await f.request('tenant/core-settings/capabilities', multiple);
    assert.ok(
      [401, 403].includes(response.status),
      'multiple native Organizationsห้าม self-select authority',
    );
    t.diagnostic(
      'PASS: real Keycloak/native Organization, JWKS, verified proof, role/proof drift และ B1 parity; ไม่มี token/secret ใน evidence',
    );
  },
);
