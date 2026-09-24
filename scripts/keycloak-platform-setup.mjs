import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * A1.2 (#407): identity plane ของ Platform Admin บน realm `dcontact` เดิม (#387) — idempotent ผ่าน Admin API
 * จึงใช้ได้ทั้ง realm ใหม่และ realm ที่ import ไปแล้ว (`--import-realm` ไม่ import ซ้ำ)
 *
 * - `dcontact-platform-api`: bearer-only resource ถือ client roles `platform_operator | platform_auditor`
 *   แยกจาก realm roles ของ tenant (`admin/agent/supervisor`) จึงไม่มีทางปนใน tenant token
 * - `platform-console`: public client + PKCE, ไม่มี direct grant/offline scope, ไม่มี tenant/organization
 *   mapper, `fullScopeAllowed=false` เห็นเฉพาะ platform roles, audience `dcontact-platform-api` และ AMR claim
 * - browser flow `platform-browser`: รหัสผ่าน + OTP เป็น REQUIRED ทั้งคู่ ไม่มี cookie SSO ข้ามจาก tenant login
 * - ผู้ใช้ dev แบบ platform-only (ไม่เป็นสมาชิก Organization ไม่มี tenant attributes) พร้อม TOTP ที่รู้ secret
 *   สำหรับ real-boundary test เท่านั้น — ค่า dev เหมือนรหัสผ่านใน realm-dcontact.dev.json
 */
export const PLATFORM_REALM = 'dcontact';
export const PLATFORM_API_CLIENT = 'dcontact-platform-api';
export const PLATFORM_CONSOLE_CLIENT = 'platform-console';
export const PLATFORM_ROLES = Object.freeze(['platform_operator', 'platform_auditor']);
export const PLATFORM_BROWSER_FLOW = 'platform-browser';
export const PLATFORM_CONSOLE_REDIRECT = 'http://localhost:5180';

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
    throw new Error(`${method} ${path} ล้มเหลว (${response.status}): ${await response.text()}`);
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

/** สร้างหรืออัปเดต client ให้ตรง representation (idempotent) แล้วคืน internal id */
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
/** เท่ากับ ssoSessionMaxLifespan ของ realm dev (10 ชม.) */
const AMR_MAX_AGE_SECONDS = '36000';

/** flow ใหม่ทั้งหมด: username/password แล้ว OTP — ทั้งสองเป็น REQUIRED */
async function ensureBrowserFlow(token) {
  const flows = await request(`${realmPath}/authentication/flows`, { token });
  let flow = flows.find((candidate) => candidate.alias === PLATFORM_BROWSER_FLOW);
  if (!flow) {
    await request(`${realmPath}/authentication/flows`, {
      method: 'POST',
      token,
      body: {
        alias: PLATFORM_BROWSER_FLOW,
        description: 'Platform Console: password + TOTP (A1.2 #407)',
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
  for (const provider of ['auth-username-password-form', 'auth-otp-form']) {
    if (!executions.some((execution) => execution.providerId === provider)) {
      await request(`${executionsPath}/execution`, { method: 'POST', token, body: { provider } });
    }
  }
  executions = await request(executionsPath, { token });
  for (const execution of executions) {
    if (execution.requirement !== 'REQUIRED') {
      await request(executionsPath, {
        method: 'PUT',
        token,
        body: { ...execution, requirement: 'REQUIRED' },
      });
    }
    // AMR mapper ใส่ค่าได้เฉพาะ execution ที่มี reference value — API ตรวจ `amr` ว่ามี pwd+otp จริง
    // maxAge ต้องครอบทั้ง SSO session: ค่า 0 ทำให้ `pwd` หลุดจาก amr เมื่อขั้นรหัสผ่านกับ OTP ห่างกันข้ามวินาที
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
  // platform-only identity: ห้ามเป็นสมาชิก Organization ใด (#387 account separation)
  const organizations = await request(
    `${realmPath}/organizations/members/${userId}/organizations`,
    {
      token,
    },
  ).catch(() => []);
  if (organizations.length > 0) {
    throw new Error(
      `${user.username} เป็นสมาชิก Organization — platform identity ต้องแยกจาก tenant`,
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
        ? 'provisioning/recovery mutation ของ control plane'
        : 'อ่าน control-plane metadata/audit แบบ read-only',
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
    attributes: { 'pkce.code.challenge.method': 'S256' },
    authenticationFlowBindingOverrides: { browser: flowId },
    // ไม่มี profile/email/organization/offline_access — token มีแค่ identity + platform roles
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
  // fullScopeAllowed=false: role ที่ใส่ token ได้มีแค่ platform roles ของ API client เท่านั้น
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
