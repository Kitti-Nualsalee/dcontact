import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * E1.13 (#487): the Keycloak public client `dphone-embedded` for a dphone embedded in another system (E1.4 #460)
 *
 * - the redirect is exactly `<dphone-origin>/dphone/auth/callback` (the dphone origin = the origin of the API that serves
 *   `/dphone/embed`), PKCE S256, with implicit/direct grant/service account disabled
 * - the same token contract as the template client (default `agent-desktop`) - copies the mappers and client scopes
 *   from that client on every run so they do not drift; UAT names `dcontact-uat-console` explicitly
 * - access token 5 minutes, client session idle 30 minutes / max 10 hours
 * - refresh token is single-use + reuse detection: Keycloak 26 can set this only at the realm level - the owner chose
 *   to enable it for the whole realm (#487, 2026-09-28), using `revokeRefreshToken=true`, `refreshTokenMaxReuse=0`
 *
 * idempotent - can be re-run; `DPHONE_EMBED_ORIGIN` sets the real production origin
 */
export const DPHONE_EMBEDDED_CLIENT = 'dphone-embedded';
export const DPHONE_EMBEDDED_LIFESPANS = Object.freeze({
  accessTokenSeconds: 300,
  sessionIdleSeconds: 1800,
  sessionMaxSeconds: 36000,
});

const realm = process.env.KEYCLOAK_REALM ?? 'dcontact';
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername =
  process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? process.env.KEYCLOAK_ADMIN_USERNAME ?? 'admin';
const adminPassword =
  process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? process.env.KEYCLOAK_ADMIN_PASSWORD ?? 'admin';
export const dphoneTemplateClientId = process.env.DPHONE_EMBED_TEMPLATE_CLIENT ?? 'agent-desktop';
export const dphoneOrigin = (process.env.DPHONE_EMBED_ORIGIN ?? 'http://localhost:3000').replace(
  /\/$/,
  '',
);
const realmPath = `/admin/realms/${realm}`;

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
  if (!response.ok) throw new Error(`${method} ${path.split('?')[0]} failed (${response.status})`);
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

async function adminToken() {
  const body = await request('/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    form: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUsername,
      password: adminPassword,
    }),
  });
  return body.access_token;
}

/** The client representation - a separate function so it can be tested without Keycloak */
export function dphoneEmbeddedClient(template, origin = dphoneOrigin) {
  return {
    clientId: DPHONE_EMBEDDED_CLIENT,
    name: 'dphone (embedded)',
    protocol: 'openid-connect',
    publicClient: true,
    standardFlowEnabled: true,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
    serviceAccountsEnabled: false,
    frontchannelLogout: false,
    redirectUris: [`${origin}/dphone/auth/callback`],
    webOrigins: [origin],
    fullScopeAllowed: template.fullScopeAllowed ?? true,
    attributes: {
      'pkce.code.challenge.method': 'S256',
      'access.token.lifespan': String(DPHONE_EMBEDDED_LIFESPANS.accessTokenSeconds),
      'client.session.idle.timeout': String(DPHONE_EMBEDDED_LIFESPANS.sessionIdleSeconds),
      'client.session.max.lifespan': String(DPHONE_EMBEDDED_LIFESPANS.sessionMaxSeconds),
      'post.logout.redirect.uris': '',
      'oauth2.device.authorization.grant.enabled': 'false',
      'oidc.ciba.grant.enabled': 'false',
    },
    protocolMappers: (template.protocolMappers ?? []).map(({ id: _id, ...mapper }) => mapper),
  };
}

export async function setupDphoneEmbedded() {
  const token = await adminToken();
  const clients = await request(`${realmPath}/clients`, { token });
  const template = clients.find((client) => client.clientId === dphoneTemplateClientId);
  if (!template) {
    throw new Error(
      `client ${dphoneTemplateClientId} used as the token contract template not found`,
    );
  }
  const representation = dphoneEmbeddedClient(template);

  let client = clients.find((candidate) => candidate.clientId === DPHONE_EMBEDDED_CLIENT);
  if (client) {
    await request(`${realmPath}/clients/${client.id}`, {
      method: 'PUT',
      token,
      body: { ...client, ...representation, protocolMappers: undefined },
    });
    // mappers: delete the existing ones and recreate them from the template - guards against drift from the template client
    for (const mapper of client.protocolMappers ?? []) {
      await request(`${realmPath}/clients/${client.id}/protocol-mappers/models/${mapper.id}`, {
        method: 'DELETE',
        token,
      });
    }
    for (const mapper of representation.protocolMappers) {
      await request(`${realmPath}/clients/${client.id}/protocol-mappers/models`, {
        method: 'POST',
        token,
        body: mapper,
      });
    }
  } else {
    await request(`${realmPath}/clients`, { method: 'POST', token, body: representation });
    [client] = await request(`${realmPath}/clients?clientId=${DPHONE_EMBEDDED_CLIENT}`, { token });
  }

  // the same client scopes as the template client (default + optional)
  for (const kind of ['default-client-scopes', 'optional-client-scopes']) {
    const wanted = await request(`${realmPath}/clients/${template.id}/${kind}`, { token });
    const current = await request(`${realmPath}/clients/${client.id}/${kind}`, { token });
    for (const scope of current.filter((scope) => !wanted.some((w) => w.id === scope.id))) {
      await request(`${realmPath}/clients/${client.id}/${kind}/${scope.id}`, {
        method: 'DELETE',
        token,
      });
    }
    for (const scope of wanted.filter((scope) => !current.some((c) => c.id === scope.id))) {
      await request(`${realmPath}/clients/${client.id}/${kind}/${scope.id}`, {
        method: 'PUT',
        token,
      });
    }
  }

  // realm-level rotation + reuse detection (decision #487)
  const realmRepresentation = await request(realmPath, { token });
  await request(realmPath, {
    method: 'PUT',
    token,
    body: { ...realmRepresentation, revokeRefreshToken: true, refreshTokenMaxReuse: 0 },
  });
  return { client: DPHONE_EMBEDDED_CLIENT, redirectUri: representation.redirectUris[0] };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = await setupDphoneEmbedded();
    console.log(
      JSON.stringify({ type: 'keycloak.dphone_embedded.setup', status: 'PASS', ...result }),
    );
  } catch (error) {
    console.error(
      JSON.stringify({
        type: 'keycloak.dphone_embedded.setup',
        status: 'FAIL',
        error: String(error.message),
      }),
    );
    process.exitCode = 1;
  }
}
