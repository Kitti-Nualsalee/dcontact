import { execFileSync } from 'node:child_process';
import { compose } from './dev-infra-compose.mjs';
import { PHASE_ONE_TENANT_IDENTITIES } from './phase-one-tenants.mjs';

const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin';
const realm = 'dcontact';
const fallbackOnly = process.argv.includes('--fallback-only');
// #923 UAT Solo: runs in the ops container that connects to PostgreSQL directly with this URL, with no dev docker compose
// not set = the original dev behavior (psql through compose and enabling HTTP on the master realm with kcadm)
const directDatabaseUrl = process.env.DCONTACT_LINK_DATABASE_URL;
const adminPasswordForUsers = process.env.DCONTACT_LINK_ADMIN_PASSWORD ?? 'admin1234';
const agentPasswordForUsers = process.env.DCONTACT_LINK_AGENT_PASSWORD ?? 'agent1234';

/** Pass the connection through PG* env, not a URL in argv - the error message of execFileSync then has no password */
function postgresEnvironment(url) {
  const parsed = new URL(url);
  return {
    ...process.env,
    PGHOST: parsed.hostname,
    PGPORT: parsed.port || '5432',
    PGUSER: decodeURIComponent(parsed.username),
    PGPASSWORD: decodeURIComponent(parsed.password),
    PGDATABASE: parsed.pathname.replace(/^\//, ''),
  };
}

function psql(...arguments_) {
  if (directDatabaseUrl) {
    return execFileSync('psql', ['-X', ...arguments_], {
      encoding: 'utf8',
      env: postgresEnvironment(directDatabaseUrl),
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  }
  return compose(
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'dcontact',
    '-d',
    'dcontact',
    ...arguments_,
  );
}

function eventClientRepresentation(identity) {
  return {
    clientId: identity.eventClientId,
    name: `D-Contact Event Ingress — ${identity.slug} (development)`,
    enabled: true,
    publicClient: false,
    secret: identity.eventClientSecret,
    protocol: 'openid-connect',
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: true,
    protocolMappers: [
      {
        name: 'dcontact-api audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: { 'included.client.audience': 'dcontact-api', 'access.token.claim': 'true' },
      },
      ...['tenant_id', 'tenant_slug'].map((attribute) => ({
        name: attribute,
        protocol: 'openid-connect',
        protocolMapper: 'oidc-usermodel-attribute-mapper',
        config: {
          'user.attribute': attribute,
          'claim.name': attribute,
          'jsonType.label': 'String',
          'access.token.claim': 'true',
          multivalued: 'false',
        },
      })),
    ],
  };
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
    throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
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
  // Solo calls the admin API from the internal network, where the master realm already accepts it (sslRequired=external)
  if (directDatabaseUrl) return;
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
  const output = psql(
    '-At',
    '-F',
    '|',
    '-c',
    // #977: a user the Admin invited through Tenant People (has a lifecycle) sets their own password/TOTP - never override the password or role
    "SELECT u.id, u.tenant_id, u.email, lower(u.role::text), t.slug FROM users u JOIN tenants t ON t.id = u.tenant_id WHERE t.slug IN ('demo', 'demo-two') AND NOT EXISTS (SELECT 1 FROM tenant_user_lifecycles l WHERE l.tenant_id = u.tenant_id AND l.user_id = u.id) ORDER BY t.slug, u.email;",
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
    throw new Error('the Keycloak/Postgres identity id is not a UUID');
  }
  psql(
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
  if (users.length === 0) throw new Error('Phase 1 dev users not found; run pnpm db:seed first');

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
          // AC6 (#599): the user does not see internal attributes on the identity provider page (the claims in the token come from a mapper)
          permissions: { view: ['admin'], edit: ['admin'] },
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
  if (!basicScope)
    throw new Error('Keycloak has no basic client scope that the token contract needs');
  let clients = await request(`/admin/realms/${realm}/clients`, { token });
  for (const clientId of ['agent-desktop', 'dcontact-dev-readiness']) {
    const client = clients.find((candidate) => candidate.clientId === clientId);
    if (!client) throw new Error(`Keycloak client ${clientId} not found`);
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
    console.warn(
      'native Organization mapper not found; using flat user-attribute claims as the fallback',
    );
  }

  let realmRoles = await request(`/admin/realms/${realm}/roles`, { token });
  if (!realmRoles.some((role) => role.name === 'journey-ingress')) {
    await request(`/admin/realms/${realm}/roles`, {
      method: 'POST',
      token,
      body: {
        name: 'journey-ingress',
        description: 'รับ external business events สำหรับ Journey ของ tenant', // allow-thai: description is persisted in the Keycloak realm
      },
    });
    realmRoles = await request(`/admin/realms/${realm}/roles`, { token });
  }
  const journeyIngressRole = realmRoles.find((role) => role.name === 'journey-ingress');
  if (!journeyIngressRole) throw new Error('failed to create the Keycloak role journey-ingress');

  const mode = fallbackOnly ? 'fallback user attributes' : 'native Organization + fallback';
  for (const tenantIdentity of PHASE_ONE_TENANT_IDENTITIES) {
    const tenantUsers = users.filter((user) => user.tenantSlug === tenantIdentity.slug);
    if (tenantUsers.length === 0) {
      throw new Error(
        `dev users of tenant ${tenantIdentity.slug} not found; run pnpm db:seed first`,
      );
    }
    const tenantId = tenantUsers[0].tenantId;
    if (tenantUsers.some((user) => user.tenantId !== tenantId)) {
      throw new Error(`the dev users of ${tenantIdentity.slug} have mismatched tenant_id values`);
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
      throw new Error(`failed to create the Keycloak Organization ${tenantIdentity.slug}`);
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

    let eventClient = clients.find(
      (candidate) => candidate.clientId === tenantIdentity.eventClientId,
    );
    if (!eventClient) {
      await request(`/admin/realms/${realm}/clients`, {
        method: 'POST',
        token,
        body: eventClientRepresentation(tenantIdentity),
      });
      clients = await request(`/admin/realms/${realm}/clients`, { token });
      eventClient = clients.find(
        (candidate) => candidate.clientId === tenantIdentity.eventClientId,
      );
    }
    if (!eventClient) {
      throw new Error(`failed to create the Keycloak client ${tenantIdentity.eventClientId}`);
    }
    const fullEventClient = await request(`/admin/realms/${realm}/clients/${eventClient.id}`, {
      token,
    });
    await request(`/admin/realms/${realm}/clients/${eventClient.id}`, {
      method: 'PUT',
      token,
      body: { ...fullEventClient, ...eventClientRepresentation(tenantIdentity) },
    });
    await request(
      `/admin/realms/${realm}/clients/${eventClient.id}/default-client-scopes/${basicScope.id}`,
      { method: 'PUT', token },
    );
    if (organizationScope) {
      await request(
        `/admin/realms/${realm}/clients/${eventClient.id}/optional-client-scopes/${organizationScope.id}`,
        { method: 'PUT', token },
      );
    }

    const serviceAccount = await request(
      `/admin/realms/${realm}/clients/${eventClient.id}/service-account-user`,
      { token },
    );
    await request(`/admin/realms/${realm}/users/${serviceAccount.id}`, {
      method: 'PUT',
      token,
      body: {
        ...serviceAccount,
        enabled: true,
        attributes: {
          ...serviceAccount.attributes,
          tenant_id: [tenantId],
          tenant_slug: [tenantIdentity.slug],
        },
      },
    });
    await request(`/admin/realms/${realm}/users/${serviceAccount.id}/role-mappings/realm`, {
      method: 'POST',
      token,
      body: [journeyIngressRole],
    });
    const organizationMembers = await request(
      `/admin/realms/${realm}/organizations/${organization.id}/members?max=100`,
      { token },
    );
    if (!organizationMembers.some((member) => member.id === serviceAccount.id)) {
      await request(`/admin/realms/${realm}/organizations/${organization.id}/members`, {
        method: 'POST',
        token,
        rawBody: serviceAccount.id,
      });
    }

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
        throw new Error(`Keycloak user ${databaseUser.email} must have exactly one entry`);
      }
      const keycloakUser = matches[0];
      // a user with the realm role platform-operator (operator@demo.local of solo-uat-seed / sales-demo-stack)
      // has their own random password - never set it to the Agent password and never add tenant roles
      const currentRoles = await request(
        `/admin/realms/${realm}/users/${keycloakUser.id}/role-mappings/realm`,
        { token },
      );
      if (currentRoles.some((role) => role.name === 'platform-operator')) {
        console.log(
          `skipping ${databaseUser.email}: a platform-operator, no new password or role is set`,
        );
        continue;
      }
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
          value: databaseUser.role === 'admin' ? adminPasswordForUsers : agentPasswordForUsers,
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
      `linked the Keycloak Organization ${tenantIdentity.slug} with ${tenantUsers.length} dev users (${mode})`,
    );
    console.log(
      `linked the service client ${tenantIdentity.eventClientId} with ${tenantIdentity.slug}`,
    );
  }
}

main().catch((error) => {
  console.error(`failed to link the dev identity: ${error.message}`);
  process.exitCode = 1;
});
