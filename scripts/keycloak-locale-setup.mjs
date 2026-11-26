import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * D1.11 (#450): the language and timezone of users on the `dcontact` realm - idempotent through the Admin API
 * so it works on both a new realm and an already imported one (`--import-realm` does not import again)
 *
 * - enable internationalization: `th` (the default) and `en` - so Keycloak stores the user `locale` attribute,
 *   puts the `locale` claim in the token (scope `profile`) and shows the login pages/emails in the user language
 * - declare the `zoneinfo` attribute in the user profile (Keycloak 24+ drops attributes that are not declared)
 *   so the `zoneinfo` mapper of the `profile` scope sends the user timezone (IANA) out in the token
 *   the user can see it but only an admin can edit it - D1 has no page to set a user timezone yet
 *
 * users change their own language through the Account REST API with their own token (`@d-contact/i18n`)
 * the D-Contact API does not need to hold realm admin rights - it needs `account/manage-account`, which comes with
 * `default-roles-dcontact`; users created through the Admin API (provisioning) get this role automatically, but dev users
 * imported from the realm JSON cannot name it in `realmRoles` themselves, so the script adds it (disable with `--no-dev-users`)
 * the tenant attributes (`tenant_id`, `tenant_slug`, `dc_user_id`) remain read-only for users
 */
export const LOCALE_REALM = 'dcontact';
export const REALM_LOCALES = Object.freeze(['th', 'en']);
export const REALM_DEFAULT_LOCALE = 'th';
export const REALM_DEFAULT_ROLE = 'default-roles-dcontact';
/** Matches `users` in infra/keycloak/realm-dcontact.dev.json */
export const LOCALE_DEV_USERS = Object.freeze([
  'admin@demo.local',
  'agent1000@demo.local',
  'agent1001@demo.local',
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

const realmPath = `/admin/realms/${LOCALE_REALM}`;

export const ZONEINFO_ATTRIBUTE = Object.freeze({
  name: 'zoneinfo',
  displayName: 'Time zone',
  // AC6 (#599): the user does not see this attribute (the required action page of the identity provider would show it as a form field)
  // - the `zoneinfo` claim in the token comes from a mapper, which reads the attribute directly and not through the user view permission
  permissions: { view: ['admin'], edit: ['admin'] },
  multivalued: false,
});

/** Return the user profile config that has `zoneinfo` - does not touch other existing attributes */
export function withZoneinfoAttribute(profile) {
  const attributes = profile.attributes ?? [];
  if (attributes.some((attribute) => attribute.name === ZONEINFO_ATTRIBUTE.name)) return profile;
  return { ...profile, attributes: [...attributes, ZONEINFO_ATTRIBUTE] };
}

async function ensureDefaultRole(token, username, defaultRole) {
  const [user] = await request(
    `${realmPath}/users?username=${encodeURIComponent(username)}&exact=true`,
    { token },
  );
  if (!user) return false;
  const mapped = await request(`${realmPath}/users/${user.id}/role-mappings/realm`, { token });
  if (mapped.some((role) => role.name === defaultRole.name)) return false;
  await request(`${realmPath}/users/${user.id}/role-mappings/realm`, {
    method: 'POST',
    token,
    body: [defaultRole],
  });
  return true;
}

export async function setupKeycloakLocale({ withDevUsers = true } = {}) {
  const token = await adminToken();

  await request(realmPath, {
    method: 'PUT',
    token,
    body: {
      internationalizationEnabled: true,
      supportedLocales: [...REALM_LOCALES],
      defaultLocale: REALM_DEFAULT_LOCALE,
    },
  });

  const profile = await request(`${realmPath}/users/profile`, { token });
  const next = withZoneinfoAttribute(profile);
  if (next !== profile) {
    await request(`${realmPath}/users/profile`, { method: 'PUT', token, body: next });
  }

  const devUsersGranted = [];
  if (withDevUsers) {
    const defaultRole = await request(`${realmPath}/roles/${REALM_DEFAULT_ROLE}`, { token });
    for (const username of LOCALE_DEV_USERS) {
      if (await ensureDefaultRole(token, username, defaultRole)) devUsersGranted.push(username);
    }
  }
  return { zoneinfoAdded: next !== profile, devUsersGranted };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = await setupKeycloakLocale({
      withDevUsers: !process.argv.includes('--no-dev-users'),
    });
    process.stdout.write(
      `${JSON.stringify({ type: 'keycloak.locale.setup', status: 'PASS', locales: REALM_LOCALES, ...result })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
