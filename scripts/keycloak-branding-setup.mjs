import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * AC6 (#599): hide the traces of the identity provider from customers (#589) on the `dcontact` realm - idempotent through the Admin API
 * so it works on both a new realm and one already imported/created (`--import-realm` does not import again)
 *
 * - `displayName` = "D-Contact" (the realm name appears in the title/heading/emails that use `${realmName}`)
 * - the account theme `dcontact`: the HTML page of `/realms/dcontact/account/` sends users to the D-Contact Console
 *   (the `dc-account` extension - `DcAccountLanding`); the Account REST API is not affected
 * - `baseUrl` of the clients `account-console` and `account` = the URL of the D-Contact Console
 *   - `account-console`: the target of the redirect above
 *   - `account`: the default client of the invitation email (`execute-actions-email` does not send a client_id) - the "back to app" link after setting the
 *     password therefore goes to D-Contact instead of the identity provider page; this client is not disabled because the invitation email needs it
 * - internal attributes (`tenant_id`, `tenant_slug`, `dc_user_id`, `zoneinfo`) are not visible/editable by the user - otherwise the
 *   required action page "edit account information" shows them as form fields (the claims in the token come from a mapper reading the attributes directly)
 *
 * Console URL: `CONSOLE_PUBLIC_URL` (the same as the API) -> `https://${UAT_HOST}/` (UAT) - with neither, this step is skipped
 * for baseUrl with a warning (not a failure, because displayName/profile still need to be set)
 */
export const BRANDING_REALM = 'dcontact';
export const BRAND_NAME = 'D-Contact';
export const ACCOUNT_THEME = 'dcontact';
export const HIDDEN_USER_ATTRIBUTES = Object.freeze([
  'tenant_id',
  'tenant_slug',
  'dc_user_id',
  'zoneinfo',
]);
export const ACCOUNT_CLIENTS = Object.freeze(['account-console', 'account']);

const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername =
  process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? process.env.KEYCLOAK_ADMIN_USERNAME ?? 'admin';
const adminPassword =
  process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';

/** An absolute http(s) URL of the Console (always ending with `/`) or `undefined` */
export function consoleUrl(env = process.env) {
  const raw =
    env.CONSOLE_PUBLIC_URL?.trim() || (env.UAT_HOST ? `https://${env.UAT_HOST.trim()}/` : '');
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('CONSOLE_PUBLIC_URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('CONSOLE_PUBLIC_URL must be http(s)');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('CONSOLE_PUBLIC_URL must not have a query/fragment/credential');
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/** A user profile whose internal attributes are not shown to the user - returns the original object if nothing needs to change */
export function withHiddenInternalAttributes(profile) {
  let changed = false;
  const attributes = (profile.attributes ?? []).map((attribute) => {
    if (!HIDDEN_USER_ATTRIBUTES.includes(attribute.name)) return attribute;
    const { view = [], edit = [] } = attribute.permissions ?? {};
    if (view.length === 1 && view[0] === 'admin' && edit.every((role) => role === 'admin')) {
      return attribute;
    }
    changed = true;
    return { ...attribute, permissions: { view: ['admin'], edit: ['admin'] } };
  });
  return changed ? { ...profile, attributes } : profile;
}

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
    throw new Error(`${method} ${path} failed (${response.status})`);
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

export async function setupKeycloakBranding({ consoleBaseUrl = consoleUrl() } = {}) {
  const token = await adminToken();
  const realmPath = `/admin/realms/${BRANDING_REALM}`;

  const realm = await request(realmPath, { token });
  const realmChanged = realm.displayName !== BRAND_NAME || realm.accountTheme !== ACCOUNT_THEME;
  if (realmChanged) {
    await request(realmPath, {
      method: 'PUT',
      token,
      body: {
        ...realm,
        displayName: BRAND_NAME,
        displayNameHtml: null,
        accountTheme: ACCOUNT_THEME,
      },
    });
  }

  const profile = await request(`${realmPath}/users/profile`, { token });
  const hidden = withHiddenInternalAttributes(profile);
  if (hidden !== profile) {
    await request(`${realmPath}/users/profile`, { method: 'PUT', token, body: hidden });
  }

  const clientsUpdated = [];
  if (consoleBaseUrl) {
    for (const clientId of ACCOUNT_CLIENTS) {
      const [client] = await request(
        `${realmPath}/clients?clientId=${encodeURIComponent(clientId)}`,
        { token },
      );
      if (!client || client.baseUrl === consoleBaseUrl) continue;
      await request(`${realmPath}/clients/${client.id}`, {
        method: 'PUT',
        token,
        body: { ...client, baseUrl: consoleBaseUrl },
      });
      clientsUpdated.push(clientId);
    }
  }

  return {
    realmChanged,
    profileChanged: hidden !== profile,
    clientsUpdated,
    consoleBaseUrlSet: Boolean(consoleBaseUrl),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  setupKeycloakBranding()
    .then((result) => {
      if (!result.consoleBaseUrlSet) {
        console.warn(
          'baseUrl of the clients account/account-console was not set: there is no CONSOLE_PUBLIC_URL (or UAT_HOST) - ' +
            '/realms/dcontact/account/ will answer 404 and the back-to-app link after an invitation will not go to the Console',
        );
      }
      console.log(JSON.stringify({ type: 'keycloak.branding', status: 'PASS', ...result }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
