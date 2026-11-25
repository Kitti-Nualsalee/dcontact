import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * A1.2 (#407): the identity plane of the Platform Admin on the existing `dcontact` realm (#387) - idempotent through the Admin API
 * so it works on both a new realm and an already imported one (`--import-realm` does not import again)
 *
 * - `dcontact-platform-api`: a bearer-only resource that holds the client roles `platform_operator | platform_auditor`
 *   separate from the tenant realm roles (`admin/agent/supervisor`), so they can never mix into a tenant token
 * - `platform-console`: a public client + PKCE, with no direct grant/offline scope, no tenant/organization
 *   mapper, `fullScopeAllowed=false` so it sees only the platform roles, the audience `dcontact-platform-api` and the AMR claim
 * - the Platform browser flow: the Cookie restores an existing session; a new login must pass password + OTP
 * - a platform-only dev user (not a member of any Organization, no tenant attributes) with a TOTP whose secret is known
 *   for the real-boundary test only - the dev values are the same as the password in realm-dcontact.dev.json
 */
export const PLATFORM_REALM = 'dcontact';
export const PLATFORM_API_CLIENT = 'dcontact-platform-api';
export const PLATFORM_CONSOLE_CLIENT = 'platform-console';
export const PLATFORM_ROLES = Object.freeze(['platform_operator', 'platform_auditor']);
export const PLATFORM_BROWSER_FLOW = 'platform-browser-sso';
export const PLATFORM_BROWSER_FORMS_FLOW = 'platform-browser-sso-forms';
const platformConsoleRedirect = process.env.PLATFORM_CONSOLE_REDIRECT ?? 'http://localhost:5180';
const platformConsoleUrl = new URL(platformConsoleRedirect);
if (
  platformConsoleUrl.origin !== platformConsoleRedirect ||
  (platformConsoleUrl.protocol !== 'https:' && platformConsoleRedirect !== 'http://localhost:5180')
) {
  throw new Error(
    'PLATFORM_CONSOLE_REDIRECT must be an HTTPS origin only (except localhost for dev)',
  );
}
export const PLATFORM_CONSOLE_REDIRECT = platformConsoleRedirect;

export const PLATFORM_DEV_USERS = Object.freeze([
  {
    username: 'platform-operator@platform.local',
    password: 'platform-operator-1234',
    totpSecret: 'dcontact-dev-platform-operator-totp',
    role: 'platform_operator',
  },
  {
    username: 'platform-auditor@platform.local',
    password: 'platform-auditor-1234',
    totpSecret: 'dcontact-dev-platform-auditor-totp',
    role: 'platform_auditor',
  },
]);

const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin';

async function request(path, { method = 'GET', token, body, form } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(`${keycloakBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? form : JSON.stringify(body),
  });
  if (!response.ok) {
    throw new Error(`${method} ${path} failed (${response.status}): ${await response.text()}`);
  }
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

const realmPath = `/admin/realms/${PLATFORM_REALM}`;

async function findClient(token, clientId) {
  const [client] = await request(`${realmPath}/clients?clientId=${encodeURIComponent(clientId)}`, {
    token,
  });
  return client;
}

/** Create or update a client to match the representation (idempotent) and return the internal id */
async function ensureClient(token, representation) {
  const existing = await findClient(token, representation.clientId);
  if (existing) {
    await request(`${realmPath}/clients/${existing.id}`, {
      method: 'PUT',
      token,
      body: { ...existing, ...representation, id: existing.id },
    });
    return existing.id;
  }
  await request(`${realmPath}/clients`, { method: 'POST', token, body: representation });
  return (await findClient(token, representation.clientId)).id;
}

async function ensureClientRole(token, clientUuid, name, description) {
  const roles = await request(`${realmPath}/clients/${clientUuid}/roles`, { token });
  if (!roles.some((role) => role.name === name)) {
    await request(`${realmPath}/clients/${clientUuid}/roles`, {
      method: 'POST',
      token,
      body: { name, description },
    });
  }
  return request(`${realmPath}/clients/${clientUuid}/roles/${encodeURIComponent(name)}`, { token });
}

const AMR_REFERENCES = Object.freeze({
  'auth-username-password-form': 'pwd',
  'auth-otp-form': 'otp',
});
/**
 * equals ssoSessionMaxLifespan of the dev realm (10 hours) - the UAT realm must not be longer
 * (`PLATFORM_AMR_MAX_AGE_SECONDS` in u1-uat-readiness.mjs, UAT-S08 #645) - change both together
 */
const AMR_MAX_AGE_SECONDS = '36000';

/** The Cookie restores an existing session; when there is no session both username/password and OTP must pass */
async function ensureBrowserFlow(token) {
  const flows = await request(`${realmPath}/authentication/flows`, { token });
  let flow = flows.find((candidate) => candidate.alias === PLATFORM_BROWSER_FLOW);
  if (!flow) {
    await request(`${realmPath}/authentication/flows`, {
      method: 'POST',
      token,
      body: {
        alias: PLATFORM_BROWSER_FLOW,
        description: 'Platform Console: SSO cookie หรือ password + TOTP (A1.2 #407)', // allow-thai: description is persisted in the Keycloak realm
        providerId: 'basic-flow',
        topLevel: true,
        builtIn: false,
      },
    });
    flow = (await request(`${realmPath}/authentication/flows`, { token })).find(
      (candidate) => candidate.alias === PLATFORM_BROWSER_FLOW,
    );
  }
  const executionsPath = `${realmPath}/authentication/flows/${PLATFORM_BROWSER_FLOW}/executions`;
  let executions = await request(executionsPath, { token });
  if (!executions.some((execution) => execution.providerId === 'auth-cookie')) {
    await request(`${executionsPath}/execution`, {
      method: 'POST',
      token,
      body: { provider: 'auth-cookie' },
    });
  }
  if (!executions.some((execution) => execution.displayName === PLATFORM_BROWSER_FORMS_FLOW)) {
    await request(`${executionsPath}/flow`, {
      method: 'POST',
      token,
      body: {
        alias: PLATFORM_BROWSER_FORMS_FLOW,
        description: 'Platform Console: password แล้ว TOTP บังคับทั้งคู่', // allow-thai: description is persisted in the Keycloak realm
        provider: 'registration-page-form',
        type: 'basic-flow',
      },
    });
  }
  executions = await request(executionsPath, { token });
  for (const execution of executions) {
    if (
      execution.providerId !== 'auth-cookie' &&
      execution.displayName !== PLATFORM_BROWSER_FORMS_FLOW
    )
      continue;
    if (execution.requirement !== 'ALTERNATIVE') {
      await request(executionsPath, {
        method: 'PUT',
        token,
        body: { ...execution, requirement: 'ALTERNATIVE' },
      });
    }
  }

  const formsExecutionsPath = `${realmPath}/authentication/flows/${PLATFORM_BROWSER_FORMS_FLOW}/executions`;
  executions = await request(formsExecutionsPath, { token });
  for (const provider of ['auth-username-password-form', 'auth-otp-form']) {
    if (!executions.some((execution) => execution.providerId === provider)) {
      await request(`${formsExecutionsPath}/execution`, {
        method: 'POST',
        token,
        body: { provider },
      });
    }
  }
  executions = await request(formsExecutionsPath, { token });
  for (const execution of executions) {
    if (execution.requirement !== 'REQUIRED') {
      await request(formsExecutionsPath, {
        method: 'PUT',
        token,
        body: { ...execution, requirement: 'REQUIRED' },
      });
    }
    // the AMR mapper can set a value only for an execution that has a reference value - the API checks that `amr` really has pwd+otp
    // maxAge must cover the whole SSO session: a value of 0 makes `pwd` drop out of amr when the password step and the OTP step are more than a second apart
    const reference = AMR_REFERENCES[execution.providerId];
    if (!reference) continue;
    const amrConfig = {
      alias: `${PLATFORM_BROWSER_FLOW}-${reference}`,
      config: {
        'default.reference.value': reference,
        'default.reference.maxAge': AMR_MAX_AGE_SECONDS,
      },
    };
    if (!execution.authenticationConfig) {
      await request(`${realmPath}/authentication/executions/${execution.id}/config`, {
        method: 'POST',
        token,
        body: amrConfig,
      });
    } else {
      await request(`${realmPath}/authentication/config/${execution.authenticationConfig}`, {
        method: 'PUT',
        token,
        body: { ...amrConfig, id: execution.authenticationConfig },
      });
    }
  }
  return flow.id;
}

async function ensureUser(token, user, roleRepresentation, apiClientUuid) {
  const [existing] = await request(
    `${realmPath}/users?exact=true&username=${encodeURIComponent(user.username)}`,
    { token },
  );
  let userId = existing?.id;
  if (!userId) {
    await request(`${realmPath}/users`, {
      method: 'POST',
      token,
      body: {
        username: user.username,
        email: user.username,
        emailVerified: true,
        enabled: true,
        firstName: 'Platform',
        lastName: user.role === 'platform_operator' ? 'Operator' : 'Auditor',
        credentials: [
          { type: 'password', value: user.password, temporary: false },
          {
            type: 'otp',
            userLabel: 'dev authenticator',
            secretData: JSON.stringify({ value: user.totpSecret }),
            credentialData: JSON.stringify({
              subType: 'totp',
              digits: 6,
              counter: 0,
              period: 30,
              algorithm: 'HmacSHA1',
            }),
          },
        ],
      },
    });
    [{ id: userId }] = await request(
      `${realmPath}/users?exact=true&username=${encodeURIComponent(user.username)}`,
      { token },
    );
  }
  // a platform-only identity: must not be a member of any Organization (#387 account separation)
  const organizations = await request(
    `${realmPath}/organizations/members/${userId}/organizations`,
    {
      token,
    },
  ).catch(() => []);
  if (organizations.length > 0) {
    throw new Error(
      `${user.username} is a member of an Organization - a platform identity must be separate from tenants`,
    );
  }
  await request(`${realmPath}/users/${userId}/role-mappings/clients/${apiClientUuid}`, {
    method: 'POST',
    token,
    body: [roleRepresentation],
  });
  return userId;
}

export async function setupKeycloakPlatform({ withDevUsers = true } = {}) {
  const token = await adminToken();
  const apiClientUuid = await ensureClient(token, {
    clientId: PLATFORM_API_CLIENT,
    name: 'D-Contact Platform API',
    enabled: true,
    bearerOnly: true,
    publicClient: false,
    protocol: 'openid-connect',
    standardFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
  });
  const roles = {};
  for (const name of PLATFORM_ROLES) {
    roles[name] = await ensureClientRole(
      token,
      apiClientUuid,
      name,
      name === 'platform_operator'
        ? 'provisioning/recovery mutation ของ control plane' // allow-thai: description is persisted in the Keycloak realm
        : 'อ่าน control-plane metadata/audit แบบ read-only', // allow-thai: description is persisted in the Keycloak realm
    );
  }

  const flowId = await ensureBrowserFlow(token);
  const consoleUuid = await ensureClient(token, {
    clientId: PLATFORM_CONSOLE_CLIENT,
    name: 'D-Contact Platform Console',
    enabled: true,
    publicClient: true,
    protocol: 'openid-connect',
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    fullScopeAllowed: false,
    redirectUris: [`${PLATFORM_CONSOLE_REDIRECT}/*`],
    webOrigins: [PLATFORM_CONSOLE_REDIRECT],
    // #515: the Platform Console login page uses a child theme that has the Internal · Platform Operations badge
    attributes: { 'pkce.code.challenge.method': 'S256', login_theme: 'dcontact-platform' },
    authenticationFlowBindingOverrides: { browser: flowId },
    // no profile/email/organization/offline_access - the token has only the identity + the platform roles
    defaultClientScopes: ['roles', 'acr', 'basic'],
    optionalClientScopes: [],
    protocolMappers: [
      {
        name: 'dcontact-platform-api audience',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-audience-mapper',
        config: {
          'included.client.audience': PLATFORM_API_CLIENT,
          'access.token.claim': 'true',
        },
      },
      {
        name: 'authentication method reference',
        protocol: 'openid-connect',
        protocolMapper: 'oidc-amr-mapper',
        config: { 'access.token.claim': 'true', 'id.token.claim': 'true' },
      },
    ],
  });
  // fullScopeAllowed=false: the only roles that can go into the token are the platform roles of the API client
  await request(`${realmPath}/clients/${consoleUuid}/scope-mappings/clients/${apiClientUuid}`, {
    method: 'POST',
    token,
    body: Object.values(roles),
  });

  const users = [];
  if (withDevUsers) {
    for (const user of PLATFORM_DEV_USERS) {
      users.push({
        username: user.username,
        id: await ensureUser(token, user, roles[user.role], apiClientUuid),
      });
    }
  }
  return { apiClientUuid, consoleUuid, flowId, users };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = await setupKeycloakPlatform({
      withDevUsers: !process.argv.includes('--no-dev-users'),
    });
    process.stdout.write(
      `${JSON.stringify({ type: 'keycloak.platform.setup', status: 'PASS', users: result.users.map(({ username }) => username) })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
