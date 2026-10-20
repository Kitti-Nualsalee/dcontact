/** ทดสอบ Keycloak/native Organization + verified proof + HTTP/PostgreSQL จริง ไม่ใช้ verifier stub */
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

export async function coreIdentitySandbox(
  registerCleanup: (cleanup: () => Promise<unknown>) => void,
) {
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
  registerCleanup(async () => {
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
  for (const name of ['agent', 'supervisor', 'admin', 'compliance'])
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
      standardFlowEnabled: true,
      redirectUris: ['http://127.0.0.1:5188/*'],
      webOrigins: ['http://127.0.0.1:5188'],
      attributes: { 'post.logout.redirect.uris': 'http://127.0.0.1:5188/*' },
      directAccessGrantsEnabled: true,
      defaultClientScopes: ['basic', 'roles', 'profile', 'email'],
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
            'id.token.claim': 'true',
            multivalued: 'false',
          },
        })),
      ],
    });
    const [client] = await admin<{ id: string }[]>('GET', `${prefix}/clients?clientId=${clientId}`);
    assert.ok(client);
    await admin('PUT', `${prefix}/clients/${client.id}/optional-client-scopes/${orgScope.id}`);
  }
  const verifier = new KeycloakAccessTokenVerifier({
    issuer,
    audience: 'dcontact-api',
    jwksUri: `${issuer}/protocol/openid-connect/certs`,
  });
  const f = await coreFixture([], verifier);
  registerCleanup(() => f.close());
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
    const [user] = await admin<KcUser[]>('GET', `${prefix}/users?username=${actor.id}&exact=true`);
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

  return { f, admin, prefix, issuer, password, keycloakUsers, roles, orgs, verifier, tokenFor };
}
