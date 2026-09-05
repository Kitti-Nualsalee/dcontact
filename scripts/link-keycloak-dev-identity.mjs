import { compose } from './dev-infra-compose.mjs';
import { PHASE_ONE_TENANT_IDENTITIES } from './phase-one-tenants.mjs';

const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin';
const realm = 'dcontact';
const fallbackOnly = process.argv.includes('--fallback-only');

async function request(path, { method = 'GET', token, body, form, rawBody } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';

  const response = await fetch(`${keycloakBaseUrl}${path}`, {
    method,
    headers,
    body: rawBody ?? (body === undefined ? form : JSON.stringify(body)),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} ล้มเหลว (${response.status}): ${await response.text()}`);
  }
  if (response.status === 204 || response.headers.get('content-length') === '0') return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function adminToken() {
  const result = await request('/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    form: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUsername,
      password: adminPassword,
    }),
  });
  return result.access_token;
}

function allowDevHttpForAdminRealm() {
  const kcadm = '/opt/keycloak/bin/kcadm.sh';
  compose(
    'exec',
    '-T',
    'keycloak',
    kcadm,
    'config',
    'credentials',
    '--server',
    'http://localhost:8080',
    '--realm',
    'master',
    '--user',
    adminUsername,
    '--password',
    adminPassword,
  );
  compose('exec', '-T', 'keycloak', kcadm, 'update', 'realms/master', '-s', 'sslRequired=NONE');
}

function databaseUsers() {
  const output = compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact',
    '-At',
    '-F',
    '|',
    '-c',
    "SELECT u.id, u.tenant_id, u.email, lower(u.role::text), t.slug FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug IN ('demo', 'demo-two') ORDER BY t.slug, u.email;",
  );
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, tenantId, email, role, tenantSlug] = line.split('|');
      return { id, tenantId, email, role, tenantSlug };
    });
}

function updateDatabaseIdentity(userId, keycloakId) {
  if (!/^[0-9a-f-]{36}$/i.test(userId) || !/^[0-9a-f-]{36}$/i.test(keycloakId)) {
    throw new Error('Keycloak/Postgres identity id ไม่ใช่ UUID');
  }
  compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact',
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    `UPDATE users SET keycloak_id = '${keycloakId}' WHERE id = '${userId}';`,
  );
}

async function main() {
  allowDevHttpForAdminRealm();
  const token = await adminToken();
  const users = databaseUsers();
  if (users.length === 0) throw new Error('ไม่พบ dev users ของ Phase 1; รัน pnpm db:seed ก่อน');

  const userProfile = await request(`/admin/realms/${realm}/users/profile`, { token });
  const protectedAttributes = ['tenant_id', 'tenant_slug', 'dc_user_id'];
  const otherAttributes = userProfile.attributes.filter(
    (attribute) => !protectedAttributes.includes(attribute.name),
  );
  await request(`/admin/realms/${realm}/users/profile`, {
    method: 'PUT',
    token,
    body: {
      ...userProfile,
      attributes: [
        ...otherAttributes,
        ...protectedAttributes.map((name) => ({
          name,
          displayName: name,
          permissions: { view: ['admin', 'user'], edit: ['admin'] },
          multivalued: false,
        })),
      ],
    },
  });

  const clientScopes = await request(`/admin/realms/${realm}/client-scopes`, { token });
  const basicScope = clientScopes.find(
    (scope) => scope.name === 'basic' && scope.protocol === 'openid-connect',
  );
  const organizationScope = clientScopes.find(
    (scope) => scope.name === 'organization' && scope.protocol === 'openid-connect',
  );
  const organizationMapper = organizationScope?.protocolMappers?.find(
    (mapper) => mapper.protocolMapper === 'oidc-organization-membership-mapper',
  );
  if (!basicScope) throw new Error('Keycloak ไม่มี basic client scope ที่ token contract ต้องใช้');
  const clients = await request(`/admin/realms/${realm}/clients`, { token });
  for (const clientId of ['agent-desktop', 'dcontact-dev-readiness']) {
    const client = clients.find((candidate) => candidate.clientId === clientId);
    if (!client) throw new Error(`ไม่พบ Keycloak client ${clientId}`);
    await request(
      `/admin/realms/${realm}/clients/${client.id}/default-client-scopes/${basicScope.id}`,
      { method: 'PUT', token },
    );
    if (!fallbackOnly && organizationScope) {
      await request(
        `/admin/realms/${realm}/clients/${client.id}/default-client-scopes/${organizationScope.id}`,
        { method: 'DELETE', token },
      );
      await request(
        `/admin/realms/${realm}/clients/${client.id}/optional-client-scopes/${organizationScope.id}`,
        { method: 'PUT', token },
      );
    }
  }
  if (!fallbackOnly && organizationScope && organizationMapper) {
    await request(
      `/admin/realms/${realm}/client-scopes/${organizationScope.id}/protocol-mappers/models/${organizationMapper.id}`,
      {
        method: 'PUT',
        token,
        body: {
          ...organizationMapper,
          config: {
            ...organizationMapper.config,
            addOrganizationAttributes: 'true',
            addOrganizationId: 'true',
            'jsonType.label': 'JSON',
          },
        },
      },
    );
  } else if (!fallbackOnly) {
    console.warn('ไม่พบ native Organization mapper; ใช้ flat user-attribute claims เป็น fallback');
  }

  const mode = fallbackOnly ? 'fallback user attributes' : 'native Organization + fallback';
  for (const tenantIdentity of PHASE_ONE_TENANT_IDENTITIES) {
    const tenantUsers = users.filter((user) => user.tenantSlug === tenantIdentity.slug);
    if (tenantUsers.length === 0) {
      throw new Error(`ไม่พบ dev users ของ tenant ${tenantIdentity.slug}; รัน pnpm db:seed ก่อน`);
    }
    const tenantId = tenantUsers[0].tenantId;
    if (tenantUsers.some((user) => user.tenantId !== tenantId)) {
      throw new Error(`dev users ของ ${tenantIdentity.slug} มี tenant_id ไม่ตรงกัน`);
    }

    let organizations = await request(`/admin/realms/${realm}/organizations`, { token });
    let organization = organizations.find((candidate) => candidate.alias === tenantIdentity.slug);
    if (!organization) {
      await request(`/admin/realms/${realm}/organizations`, {
        method: 'POST',
        token,
        body: {
          name: tenantIdentity.name,
          alias: tenantIdentity.slug,
          enabled: true,
          domains: [{ name: tenantIdentity.domain, verified: true }],
          attributes: { tenant_id: [tenantId], tenant_slug: [tenantIdentity.slug] },
        },
      });
      organizations = await request(`/admin/realms/${realm}/organizations`, { token });
      organization = organizations.find((candidate) => candidate.alias === tenantIdentity.slug);
    }
    if (!organization) {
      throw new Error(`สร้าง Keycloak Organization ${tenantIdentity.slug} ไม่สำเร็จ`);
    }

    const fullOrganization = await request(
      `/admin/realms/${realm}/organizations/${organization.id}`,
      { token },
    );
    await request(`/admin/realms/${realm}/organizations/${organization.id}`, {
      method: 'PUT',
      token,
      body: {
        ...fullOrganization,
        enabled: true,
        attributes: {
          ...fullOrganization.attributes,
          tenant_id: [tenantId],
          tenant_slug: [tenantIdentity.slug],
        },
      },
    });

    for (const databaseUser of tenantUsers) {
      let matches = await request(
        `/admin/realms/${realm}/users?${new URLSearchParams({ username: databaseUser.email, exact: 'true' })}`,
        { token },
      );
      if (matches.length === 0) {
        await request(`/admin/realms/${realm}/users`, {
          method: 'POST',
          token,
          body: {
            username: databaseUser.email,
            email: databaseUser.email,
            firstName: databaseUser.email.split('@')[0],
            lastName: tenantIdentity.name,
            enabled: true,
            emailVerified: true,
          },
        });
        matches = await request(
          `/admin/realms/${realm}/users?${new URLSearchParams({ username: databaseUser.email, exact: 'true' })}`,
          { token },
        );
      }
      if (matches.length !== 1) {
        throw new Error(`Keycloak user ${databaseUser.email} ต้องมีหนึ่งรายการ`);
      }
      const keycloakUser = matches[0];
      await request(`/admin/realms/${realm}/users/${keycloakUser.id}`, {
        method: 'PUT',
        token,
        body: {
          ...keycloakUser,
          firstName: keycloakUser.firstName || databaseUser.email.split('@')[0],
          lastName: keycloakUser.lastName || tenantIdentity.name,
          enabled: true,
          emailVerified: true,
          attributes: {
            ...keycloakUser.attributes,
            tenant_id: [tenantId],
            tenant_slug: [tenantIdentity.slug],
            dc_user_id: [databaseUser.id],
          },
        },
      });
      await request(`/admin/realms/${realm}/users/${keycloakUser.id}/reset-password`, {
        method: 'PUT',
        token,
        body: {
          type: 'password',
          value: databaseUser.role === 'admin' ? 'admin1234' : 'agent1234',
          temporary: false,
        },
      });
      const realmRole = await request(
        `/admin/realms/${realm}/roles/${encodeURIComponent(databaseUser.role)}`,
        { token },
      );
      await request(`/admin/realms/${realm}/users/${keycloakUser.id}/role-mappings/realm`, {
        method: 'POST',
        token,
        body: [realmRole],
      });

      const members = await request(
        `/admin/realms/${realm}/organizations/${organization.id}/members?max=100`,
        { token },
      );
      if (!members.some((member) => member.id === keycloakUser.id)) {
        await request(`/admin/realms/${realm}/organizations/${organization.id}/members`, {
          method: 'POST',
          token,
          rawBody: keycloakUser.id,
        });
      }
      updateDatabaseIdentity(databaseUser.id, keycloakUser.id);
    }

    console.log(
      `เชื่อม Keycloak Organization ${tenantIdentity.slug} กับ dev users ${tenantUsers.length} คนแล้ว (${mode})`,
    );
  }
}

main().catch((error) => {
  console.error(`เชื่อม dev identity ไม่สำเร็จ: ${error.message}`);
  process.exitCode = 1;
});
