import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * U1.6 (#434): ตั้งค่า Keycloak realm ของ UAT และสร้างบัญชี maker/reviewer จาก secret input
 *
 * - `--config`: render `infra/keycloak/realm-dcontact.uat.json` ด้วย env (`${env.NAME}`) แล้วสร้าง realm
 *   ถ้ายังไม่มี หรือ reconcile ส่วนที่ UAT ต้องการ (client ของ Console, OTP, Organization, user profile)
 * - `--users <file>`: สร้าง/อัปเดตบัญชีจากไฟล์ JSON ที่ operator วางจาก secret store — ไม่ commit ลง Git
 *
 * เรียก admin REST ผ่าน network ภายในของ compose เท่านั้น (proxy ปิด `/auth/admin` และ realm master)
 * ไม่พิมพ์รหัสผ่าน token หรือค่าจากไฟล์บัญชีออก log; ขัด stop condition (#434) = หยุดทันที
 */

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const UAT_REALM = 'dcontact';
export const UAT_CONSOLE_CLIENT_ID = 'dcontact-uat-console';
export const UAT_REALM_TEMPLATE = 'infra/keycloak/realm-dcontact.uat.json';
export const UAT_REALM_ENV = Object.freeze([
  'UAT_HOST',
  'UAT_TENANT_ID',
  'UAT_TENANT_SLUG',
  'UAT_TENANT_NAME',
  'UAT_ORGANIZATION_DOMAIN',
]);
const IDENTITY_ATTRIBUTES = Object.freeze(['tenant_id', 'tenant_slug', 'dc_user_id']);
/** credential ที่รู้กันใน dev/seed — UAT ใช้ซ้ำไม่ได้ (stop condition: shared credentials) */
export const KNOWN_DEV_PASSWORDS = Object.freeze([
  'admin',
  'admin1234',
  'agent1234',
  'dcontact',
  'dcontact-secret',
  'dcontact_app',
  'dcontact_platform',
  'dcontact_provisioner',
  'ClueCon',
]);
/** บัญชี seed ของ dev ใช้โดเมน `.local` (เช่น `admin@demo.local`) */
const DEV_ACCOUNT_DOMAIN = /\.local$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class UatKeycloakError extends Error {
  constructor(code, detail = '') {
    super(detail ? `${code}: ${detail}` : code);
    this.code = code;
    this.name = 'UatKeycloakError';
  }
}

/** แทน `${env.NAME}` ด้วยค่าจาก env — ขาดตัวใด = fail closed; ห้ามมี placeholder เหลือ */
export function renderRealm(template, environment) {
  const missing = new Set();
  const rendered = JSON.parse(JSON.stringify(template), (_key, value) =>
    typeof value === 'string'
      ? value.replace(/\$\{env\.([A-Z0-9_]+)\}/g, (_match, name) => {
          const resolved = environment[name];
          if (!resolved) {
            missing.add(name);
            return '';
          }
          return resolved;
        })
      : value,
  );
  if (missing.size > 0) {
    throw new UatKeycloakError('REALM_ENV_MISSING', [...missing].sort().join(', '));
  }
  if (!/^[a-z0-9.-]+$/i.test(environment.UAT_HOST) || /localhost/i.test(environment.UAT_HOST)) {
    throw new UatKeycloakError('REALM_ENV_INVALID', 'UAT_HOST');
  }
  if (!UUID.test(environment.UAT_TENANT_ID)) {
    throw new UatKeycloakError('REALM_ENV_INVALID', 'UAT_TENANT_ID');
  }
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(environment.UAT_TENANT_SLUG)) {
    throw new UatKeycloakError('REALM_ENV_INVALID', 'UAT_TENANT_SLUG');
  }
  return rendered;
}

/** digest ของ realm config ที่ render แล้ว (ไม่มี secret) — บันทึกลง deployment record */
export function realmConfigDigest(rendered) {
  return `sha256:${createHash('sha256').update(canonicalJson(rendered)).digest('hex')}`;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function assertNotDevCredential(name, value) {
  if (!value) throw new UatKeycloakError('CREDENTIAL_MISSING', name);
  if (KNOWN_DEV_PASSWORDS.includes(value)) {
    throw new UatKeycloakError('SHARED_CREDENTIAL_WITH_DEV', name);
  }
}

/**
 * ตรวจไฟล์บัญชี: ต้องมี maker และ reviewer อย่างน้อยหนึ่งคน, คนละบัญชี/คนละ dc_user_id (maker-checker),
 * ไม่ใช้บัญชีหรือรหัสผ่านของ dev และรหัสผ่านเริ่มต้นเป็น temporary เสมอ
 */
export function validateAccounts(input) {
  if (!input || typeof input !== 'object' || !Array.isArray(input.accounts)) {
    throw new UatKeycloakError('ACCOUNTS_INVALID', 'accounts');
  }
  const accounts = input.accounts.map((account, index) => {
    const field = (name) => `accounts.${index}.${name}`;
    if (!account || typeof account !== 'object') {
      throw new UatKeycloakError('ACCOUNTS_INVALID', `accounts.${index}`);
    }
    for (const name of ['username', 'email', 'firstName', 'lastName', 'dcUserId', 'role']) {
      if (typeof account[name] !== 'string' || account[name].trim() === '') {
        throw new UatKeycloakError('ACCOUNTS_INVALID', field(name));
      }
    }
    if (!['maker', 'reviewer'].includes(account.role)) {
      throw new UatKeycloakError('ACCOUNTS_INVALID', field('role'));
    }
    if (!UUID.test(account.dcUserId))
      throw new UatKeycloakError('ACCOUNTS_INVALID', field('dcUserId'));
    if (DEV_ACCOUNT_DOMAIN.test(account.username) || DEV_ACCOUNT_DOMAIN.test(account.email)) {
      throw new UatKeycloakError('SHARED_CREDENTIAL_WITH_DEV', field('username'));
    }
    if (account.temporaryPassword !== undefined) {
      assertNotDevCredential(field('temporaryPassword'), account.temporaryPassword);
      if (String(account.temporaryPassword).length < 12) {
        throw new UatKeycloakError('ACCOUNTS_INVALID', field('temporaryPassword'));
      }
    }
    return { ...account, username: account.username.trim().toLowerCase() };
  });
  const roles = new Set(accounts.map((account) => account.role));
  if (!roles.has('maker') || !roles.has('reviewer')) {
    throw new UatKeycloakError('ACCOUNTS_INVALID', 'ต้องมีทั้ง maker และ reviewer');
  }
  for (const key of ['username', 'email', 'dcUserId']) {
    const values = accounts.map((account) => account[key].toLowerCase());
    if (new Set(values).size !== values.length) {
      throw new UatKeycloakError(
        'ACCOUNTS_INVALID',
        `${key} ซ้ำ — maker/reviewer ต้องเป็นคนละบัญชี`,
      );
    }
  }
  return accounts;
}

export function createKeycloakAdmin({ baseUrl, username, password, fetchImpl = fetch }) {
  let token;
  async function call(path, { method = 'GET', body, rawBody, form, allow404 = false } = {}) {
    const headers = {};
    if (token) headers.authorization = `Bearer ${token}`;
    if (body !== undefined || rawBody !== undefined) headers['content-type'] = 'application/json';
    if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: rawBody ?? form ?? (body === undefined ? undefined : JSON.stringify(body)),
    });
    if (allow404 && response.status === 404) return undefined;
    if (!response.ok) {
      // ไม่สะท้อน body กลับ — อาจมีค่าที่ส่งไป
      throw new UatKeycloakError('KEYCLOAK_ADMIN_FAILED', `${method} ${path} → ${response.status}`);
    }
    const text = await response.text();
    return text ? JSON.parse(text) : undefined;
  }
  return {
    call,
    async login() {
      const result = await call('/realms/master/protocol/openid-connect/token', {
        method: 'POST',
        form: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username,
          password,
        }),
      });
      token = result.access_token;
    },
  };
}

const REALM_LEVEL_EXCLUDED = new Set([
  'clients',
  'roles',
  'organizations',
  'users',
  'authenticationFlows',
  'requiredActions',
]);

async function upsertClient(admin, realm, desired, scopes) {
  const base = `/admin/realms/${realm}`;
  let [client] = await admin.call(
    `${base}/clients?clientId=${encodeURIComponent(desired.clientId)}`,
  );
  if (!client) {
    await admin.call(`${base}/clients`, { method: 'POST', body: desired });
    [client] = await admin.call(`${base}/clients?clientId=${encodeURIComponent(desired.clientId)}`);
  } else {
    const { protocolMappers: _mappers, ...settings } = desired;
    await admin.call(`${base}/clients/${client.id}`, {
      method: 'PUT',
      body: { ...client, ...settings, id: client.id },
    });
  }
  if (!client) throw new UatKeycloakError('KEYCLOAK_CLIENT_MISSING', desired.clientId);
  const existingMappers = await admin.call(`${base}/clients/${client.id}/protocol-mappers/models`);
  for (const mapper of desired.protocolMappers ?? []) {
    const current = existingMappers.find((candidate) => candidate.name === mapper.name);
    if (!current) {
      await admin.call(`${base}/clients/${client.id}/protocol-mappers/models`, {
        method: 'POST',
        body: mapper,
      });
    } else {
      await admin.call(`${base}/clients/${client.id}/protocol-mappers/models/${current.id}`, {
        method: 'PUT',
        body: { ...current, ...mapper, id: current.id },
      });
    }
  }
  for (const [kind, names] of [
    ['default-client-scopes', desired.defaultClientScopes ?? []],
    ['optional-client-scopes', desired.optionalClientScopes ?? []],
  ]) {
    for (const name of names) {
      const scope = scopes.find((candidate) => candidate.name === name);
      if (!scope) throw new UatKeycloakError('KEYCLOAK_SCOPE_MISSING', name);
      await admin.call(`${base}/clients/${client.id}/${kind}/${scope.id}`, { method: 'PUT' });
    }
  }
}

export async function applyRealmConfig(admin, rendered) {
  const realm = rendered.realm;
  const base = `/admin/realms/${realm}`;
  const existing = await admin.call(base, { allow404: true });
  let created = false;
  if (!existing) {
    await admin.call('/admin/realms', { method: 'POST', body: rendered });
    created = true;
  } else {
    const flows = await admin.call(`${base}/authentication/flows`);
    for (const flow of rendered.authenticationFlows.filter((candidate) => candidate.topLevel)) {
      if (!flows.some((candidate) => candidate.alias === flow.alias)) {
        // flow สร้างได้ตอนสร้าง realm เท่านั้น — realm เดิมที่ไม่มี flow นี้ต้องให้ operator ตรวจ
        throw new UatKeycloakError('UAT_BROWSER_FLOW_MISSING', flow.alias);
      }
    }
    const settings = Object.fromEntries(
      Object.entries(rendered).filter(([key]) => !REALM_LEVEL_EXCLUDED.has(key)),
    );
    await admin.call(base, { method: 'PUT', body: { ...existing, ...settings } });
    for (const action of rendered.requiredActions) {
      const current = await admin.call(`${base}/authentication/required-actions/${action.alias}`, {
        allow404: true,
      });
      if (!current) throw new UatKeycloakError('REQUIRED_ACTION_MISSING', action.alias);
      await admin.call(`${base}/authentication/required-actions/${action.alias}`, {
        method: 'PUT',
        body: { ...current, enabled: action.enabled, defaultAction: action.defaultAction },
      });
    }
  }

  const scopes = await admin.call(`${base}/client-scopes`);
  for (const client of rendered.clients) await upsertClient(admin, realm, client, scopes);

  // tenant_id/tenant_slug/dc_user_id ต้องอยู่ใน user profile ไม่เช่นนั้น Keycloak ทิ้ง attribute
  const profile = await admin.call(`${base}/users/profile`);
  await admin.call(`${base}/users/profile`, {
    method: 'PUT',
    body: {
      ...profile,
      attributes: [
        ...profile.attributes.filter((attribute) => !IDENTITY_ATTRIBUTES.includes(attribute.name)),
        ...IDENTITY_ATTRIBUTES.map((name) => ({
          name,
          displayName: name,
          permissions: { view: ['admin', 'user'], edit: ['admin'] },
          multivalued: false,
        })),
      ],
    },
  });

  // organization claim ต้องมี attribute tenant_id ให้ gateway เทียบกับ tenant_id ของผู้ใช้
  const organizationScope = scopes.find(
    (scope) => scope.name === 'organization' && scope.protocol === 'openid-connect',
  );
  const organizationMapper = organizationScope?.protocolMappers?.find(
    (mapper) => mapper.protocolMapper === 'oidc-organization-membership-mapper',
  );
  if (!organizationScope || !organizationMapper) {
    throw new UatKeycloakError('ORGANIZATION_SCOPE_MISSING');
  }
  await admin.call(
    `${base}/client-scopes/${organizationScope.id}/protocol-mappers/models/${organizationMapper.id}`,
    {
      method: 'PUT',
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

  for (const desired of rendered.organizations) {
    const organizations = await admin.call(`${base}/organizations?max=1000`);
    let organization = organizations.find((candidate) => candidate.alias === desired.alias);
    if (!organization) {
      await admin.call(`${base}/organizations`, { method: 'POST', body: desired });
    } else {
      organization = await admin.call(`${base}/organizations/${organization.id}`);
      if (
        organization.attributes?.tenant_id?.[0] &&
        organization.attributes.tenant_id[0] !== desired.attributes.tenant_id[0]
      ) {
        // ห้ามผูก Organization เดิมกับ tenant อื่นเงียบ ๆ
        throw new UatKeycloakError('ORGANIZATION_TENANT_MISMATCH', desired.alias);
      }
      await admin.call(`${base}/organizations/${organization.id}`, {
        method: 'PUT',
        body: { ...organization, ...desired, id: organization.id },
      });
    }
  }
  return { realm, created, realmConfigDigest: realmConfigDigest(rendered) };
}

export async function applyAccounts(admin, { realm, tenantId, tenantSlug, accounts }) {
  const base = `/admin/realms/${realm}`;
  const organizations = await admin.call(`${base}/organizations?max=1000`);
  const organization = organizations.find((candidate) => candidate.alias === tenantSlug);
  if (!organization) throw new UatKeycloakError('ORGANIZATION_MISSING', tenantSlug);
  const results = [];
  for (const account of accounts) {
    const query = new URLSearchParams({ username: account.username, exact: 'true' });
    let [user] = await admin.call(`${base}/users?${query}`);
    const attributes = {
      tenant_id: [tenantId],
      tenant_slug: [tenantSlug],
      dc_user_id: [account.dcUserId],
    };
    let status = 'UPDATED';
    if (!user) {
      if (!account.temporaryPassword) {
        throw new UatKeycloakError('ACCOUNTS_INVALID', 'บัญชีใหม่ต้องมี temporaryPassword');
      }
      await admin.call(`${base}/users`, {
        method: 'POST',
        body: {
          username: account.username,
          email: account.email,
          firstName: account.firstName,
          lastName: account.lastName,
          enabled: true,
          emailVerified: true,
          attributes,
          // ครั้งแรกต้องเปลี่ยนรหัสผ่านและผูก TOTP ก่อนใช้งาน
          requiredActions: ['UPDATE_PASSWORD', 'CONFIGURE_TOTP'],
        },
      });
      [user] = await admin.call(`${base}/users?${query}`);
      if (!user) throw new UatKeycloakError('KEYCLOAK_USER_MISSING', account.role);
      await admin.call(`${base}/users/${user.id}/reset-password`, {
        method: 'PUT',
        body: { type: 'password', value: account.temporaryPassword, temporary: true },
      });
      status = 'CREATED';
    } else {
      const bound = user.attributes?.dc_user_id?.[0];
      if (bound && bound !== account.dcUserId) {
        // ห้ามย้ายบัญชี Keycloak ไปผูก subject อื่นเงียบ ๆ
        throw new UatKeycloakError('ACCOUNT_SUBJECT_MISMATCH', account.role);
      }
      await admin.call(`${base}/users/${user.id}`, {
        method: 'PUT',
        body: {
          ...user,
          email: account.email,
          firstName: account.firstName,
          lastName: account.lastName,
          enabled: true,
          attributes: { ...user.attributes, ...attributes },
        },
      });
    }
    const members = await admin.call(`${base}/organizations/${organization.id}/members?max=1000`);
    if (!members.some((member) => member.id === user.id)) {
      await admin.call(`${base}/organizations/${organization.id}/members`, {
        method: 'POST',
        rawBody: user.id,
      });
    }
    results.push({ role: account.role, keycloakId: user.id, dcUserId: account.dcUserId, status });
  }
  return results;
}

function required(environment, name) {
  const value = environment[name];
  if (!value) throw new UatKeycloakError('ENV_MISSING', name);
  return value;
}

export async function runUatKeycloak(argv = process.argv.slice(2), environment = process.env) {
  const mode = argv.includes('--config') ? 'config' : argv.includes('--users') ? 'users' : null;
  if (!mode) throw new UatKeycloakError('USAGE', '--config | --users <accounts.json>');
  const adminPassword = required(environment, 'KEYCLOAK_ADMIN_PASSWORD');
  assertNotDevCredential('KEYCLOAK_ADMIN_PASSWORD', adminPassword);
  const admin = createKeycloakAdmin({
    baseUrl: required(environment, 'KEYCLOAK_ADMIN_URL').replace(/\/$/, ''),
    username: required(environment, 'KEYCLOAK_ADMIN_USERNAME'),
    password: adminPassword,
  });
  const template = JSON.parse(
    readFileSync(
      resolve(environment.UAT_REALM_TEMPLATE ?? resolve(repositoryRoot, UAT_REALM_TEMPLATE)),
      'utf8',
    ),
  );
  const rendered = renderRealm(template, environment);
  await admin.login();
  if (mode === 'config') {
    return { type: 'u1.uat.keycloak', mode, ...(await applyRealmConfig(admin, rendered)) };
  }
  const file = argv[argv.indexOf('--users') + 1];
  if (!file || file.startsWith('--'))
    throw new UatKeycloakError('USAGE', '--users <accounts.json>');
  const accounts = validateAccounts(JSON.parse(readFileSync(file, 'utf8')));
  const results = await applyAccounts(admin, {
    realm: rendered.realm,
    tenantId: environment.UAT_TENANT_ID,
    tenantSlug: environment.UAT_TENANT_SLUG,
    accounts,
  });
  return { type: 'u1.uat.keycloak', mode, realm: rendered.realm, accounts: results };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  runUatKeycloak()
    .then((summary) => process.stdout.write(`${JSON.stringify(summary)}\n`))
    .catch((error) => {
      process.stderr.write(
        `${JSON.stringify({ type: 'u1.uat.keycloak', status: 'FAIL', code: error.code ?? 'UNEXPECTED', message: error.message })}\n`,
      );
      process.exitCode = 1;
    });
}
