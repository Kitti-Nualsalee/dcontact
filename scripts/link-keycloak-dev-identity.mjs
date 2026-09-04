import { execFileSync } from 'node:child_process';

const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin';
const realm = 'dcontact';

function compose(...arguments_) {
  return execFileSync(
    'docker',
    ['compose', '-f', 'infra/docker/docker-compose.dev.yml', ...arguments_],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  ).trim();
}

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
    "SELECT u.id, u.tenant_id, u.email FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug = 'demo' ORDER BY u.email;",
  );
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [id, tenantId, email] = line.split('|');
      return { id, tenantId, email };
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
  if (users.length === 0) throw new Error('ไม่พบ dev users ของ tenant demo; รัน pnpm db:seed ก่อน');
  const tenantId = users[0].tenantId;
  if (users.some((user) => user.tenantId !== tenantId))
    throw new Error('dev users ไม่ได้อยู่ tenant เดียวกัน');

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
  if (!basicScope || !organizationScope || !organizationMapper) {
    throw new Error('Keycloak 26 ไม่มี native Organization mapper ตาม contract ที่ pin');
  }
  const clients = await request(`/admin/realms/${realm}/clients`, { token });
  for (const clientId of ['agent-desktop', 'dcontact-dev-readiness']) {
    const client = clients.find((candidate) => candidate.clientId === clientId);
    if (!client) throw new Error(`ไม่พบ Keycloak client ${clientId}`);
    await request(
      `/admin/realms/${realm}/clients/${client.id}/default-client-scopes/${basicScope.id}`,
      { method: 'PUT', token },
    );
    await request(
      `/admin/realms/${realm}/clients/${client.id}/default-client-scopes/${organizationScope.id}`,
      { method: 'DELETE', token },
    );
    await request(
      `/admin/realms/${realm}/clients/${client.id}/optional-client-scopes/${organizationScope.id}`,
      { method: 'PUT', token },
    );
  }
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

  let organizations = await request(`/admin/realms/${realm}/organizations`, { token });
  let organization = organizations.find((candidate) => candidate.alias === 'demo');
  if (!organization) {
    await request(`/admin/realms/${realm}/organizations`, {
      method: 'POST',
      token,
      body: {
        name: 'Demo Company',
        alias: 'demo',
        enabled: true,
        domains: [{ name: 'demo.d-contact.local', verified: true }],
        attributes: { tenant_id: [tenantId], tenant_slug: ['demo'] },
      },
    });
    organizations = await request(`/admin/realms/${realm}/organizations`, { token });
    organization = organizations.find((candidate) => candidate.alias === 'demo');
  }
  if (!organization) throw new Error('สร้าง Keycloak Organization demo ไม่สำเร็จ');

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
      attributes: { ...fullOrganization.attributes, tenant_id: [tenantId], tenant_slug: ['demo'] },
    },
  });

  for (const databaseUser of users) {
    const matches = await request(
      `/admin/realms/${realm}/users?${new URLSearchParams({ username: databaseUser.email, exact: 'true' })}`,
      { token },
    );
    if (matches.length !== 1)
      throw new Error(`Keycloak user ${databaseUser.email} ต้องมีหนึ่งรายการ`);
    const keycloakUser = matches[0];
    await request(`/admin/realms/${realm}/users/${keycloakUser.id}`, {
      method: 'PUT',
      token,
      body: {
        ...keycloakUser,
        attributes: {
          ...keycloakUser.attributes,
          tenant_id: [tenantId],
          tenant_slug: ['demo'],
          dc_user_id: [databaseUser.id],
        },
      },
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

  console.log(`เชื่อม Keycloak Organization demo กับ dev users ${users.length} คนแล้ว`);
}

main().catch((error) => {
  console.error(`เชื่อม dev identity ไม่สำเร็จ: ${error.message}`);
  process.exitCode = 1;
});
