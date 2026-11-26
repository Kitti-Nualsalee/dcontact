import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * A1.4 (#409): the provisioning side of Keycloak for the `dcontact` realm - idempotent through the Admin API
 *
 * - `dcontact-provisioner`: a confidential client + service account the saga worker uses to create Organizations,
 *   the first admin and to send the execute-actions invitation; no browser/direct grant
 *   Keycloak 26.0 needs `manage-realm` for the Organization API (there is no fine-grained admin
 *   permission yet), so the secret must be kept only for the worker
 * - user profile: the correlation attributes are editable only by admin (a user cannot edit them through the account console)
 * - the dev SMTP points at mailpit (nothing is sent externally) - UAT passes the same `SMTP_*` set as the D-Contact API in as
 *   `KEYCLOAK_SMTP_*` (AC3 #596); the sender name is always "D-Contact" and Keycloak cannot set HELO itself
 */
export const PROVISIONER_CLIENT = 'dcontact-provisioner';
export const PROVISIONER_REALM_MANAGEMENT_ROLES = Object.freeze([
  'manage-users',
  'view-users',
  'query-users',
  'view-realm',
  // the Organization admin API of Keycloak 26.0 (see the PR of #409)
  'manage-realm',
  // #592 (Keycloak 26.7): when fine-grained admin permissions v2 is on, listing/searching Organizations skips the filtering
  // only for holders of `view-organizations`/`manage-organizations` - `manage-realm` alone gets an empty list
  'manage-organizations',
  // A1.8 (#413): read the user events of the first admin to put into the Action history
  'view-events',
  // #907: look up the tenant Console client by clientId - with fine-grained permission v2 on, the search result is filtered
  // down to only the clients the provisioner has `view` on (it sees no other client); edits use a per-client permission
  'query-clients',
]);
/** Must match `FIRST_ADMIN_KEYCLOAK_EVENT_TYPES` in platform-control (checked by the boundary test) */
export const FIRST_ADMIN_EVENT_TYPES = Object.freeze([
  'VERIFY_EMAIL',
  'CUSTOM_REQUIRED_ACTION',
  'UPDATE_PASSWORD',
  'UPDATE_TOTP',
  'UPDATE_CREDENTIAL',
]);
const EVENTS_EXPIRATION_SECONDS = 30 * 24 * 60 * 60;
export const PROTECTED_USER_ATTRIBUTES = Object.freeze([
  'tenant_id',
  'tenant_slug',
  'dc_user_id',
  'dc_provisioning_request_id',
  // A1.4b (#436): set by the control plane at resend - a link issued before this time is unusable
  'dc_invitation_not_before',
]);
export const INVITATION_GUARD_FACTORY = 'io.dcontact.keycloak.InvitationGuardActionTokenHandler';

const realm = 'dcontact';
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin';
export const provisionerSecret =
  process.env.KEYCLOAK_PROVISIONER_SECRET ?? 'dcontact-provisioner-dev-secret';
/**
 * `KEYCLOAK_SMTP_*` (the view from the network of the Keycloak container - dev points at `mailpit`, not localhost)
 * FROM accepts both `"name" <address>` and an address alone - the displayed name is always "D-Contact" (#589 Q2)
 */
export function smtpServerRepresentation(environment = process.env) {
  const from = environment.KEYCLOAK_SMTP_FROM ?? 'no-reply@dcontact.local';
  const address = (/<([^<>]+)>\s*$/.exec(from)?.[1] ?? from).trim();
  const secure = (environment.KEYCLOAK_SMTP_SECURE ?? 'false').trim().toLowerCase() === 'true';
  const user = environment.KEYCLOAK_SMTP_USER?.trim();
  return {
    host: environment.KEYCLOAK_SMTP_HOST ?? 'mailpit',
    port: environment.KEYCLOAK_SMTP_PORT ?? '1025',
    from: address,
    fromDisplayName: 'D-Contact',
    ssl: String(secure),
    // not TLS from the start = STARTTLS when the server supports it (JavaMail starttls.enable is not mandatory), the same as the API
    starttls: String(!secure),
    auth: String(Boolean(user)),
    ...(user ? { user, password: environment.KEYCLOAK_SMTP_PASSWORD ?? '' } : {}),
  };
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
    throw new Error(`${method} ${path.split('?')[0]} failed (${response.status})`);
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

const realmPath = `/admin/realms/${realm}`;

async function ensureProvisionerClient(token) {
  const representation = {
    clientId: PROVISIONER_CLIENT,
    name: 'D-Contact Provisioning Worker',
    enabled: true,
    publicClient: false,
    bearerOnly: false,
    protocol: 'openid-connect',
    secret: provisionerSecret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
  };
  let [client] = await request(`${realmPath}/clients?clientId=${PROVISIONER_CLIENT}`, { token });
  if (client) {
    await request(`${realmPath}/clients/${client.id}`, {
      method: 'PUT',
      token,
      body: { ...client, ...representation, id: client.id },
    });
  } else {
    await request(`${realmPath}/clients`, { method: 'POST', token, body: representation });
    [client] = await request(`${realmPath}/clients?clientId=${PROVISIONER_CLIENT}`, { token });
  }
  const serviceAccount = await request(`${realmPath}/clients/${client.id}/service-account-user`, {
    token,
  });
  const [realmManagement] = await request(`${realmPath}/clients?clientId=realm-management`, {
    token,
  });
  const available = await request(`${realmPath}/clients/${realmManagement.id}/roles`, { token });
  const wanted = available.filter((role) => PROVISIONER_REALM_MANAGEMENT_ROLES.includes(role.name));
  if (wanted.length !== PROVISIONER_REALM_MANAGEMENT_ROLES.length) {
    throw new Error('realm-management does not have every role the provisioner needs');
  }
  await request(
    `${realmPath}/users/${serviceAccount.id}/role-mappings/clients/${realmManagement.id}`,
    { method: 'POST', token, body: wanted },
  );
  // remove roles beyond the list (e.g. from manual configuration) so the permissions always match the contract
  const current = await request(
    `${realmPath}/users/${serviceAccount.id}/role-mappings/clients/${realmManagement.id}`,
    { token },
  );
  const extra = current.filter((role) => !PROVISIONER_REALM_MANAGEMENT_ROLES.includes(role.name));
  if (extra.length > 0) {
    await request(
      `${realmPath}/users/${serviceAccount.id}/role-mappings/clients/${realmManagement.id}`,
      { method: 'DELETE', token, body: extra },
    );
  }
}

async function ensureUserProfile(token) {
  const profile = await request(`${realmPath}/users/profile`, { token });
  const existing = new Set(profile.attributes.map((attribute) => attribute.name));
  const missing = PROTECTED_USER_ATTRIBUTES.filter((name) => !existing.has(name));
  if (missing.length === 0) return;
  // add only what does not exist yet - tenant attributes that the link script already set keep their existing permissions
  await request(`${realmPath}/users/profile`, {
    method: 'PUT',
    token,
    body: {
      ...profile,
      attributes: [
        ...profile.attributes,
        ...missing.map((name) => ({
          name,
          displayName: name,
          permissions: {
            // AC6 (#599): internal attributes are not shown to the user on the identity provider page
            view: ['admin'],
            edit: ['admin'],
          },
          multivalued: false,
        })),
      ],
    },
  });
}

async function ensureSmtp(token) {
  const current = await request(realmPath, { token });
  await request(realmPath, {
    method: 'PUT',
    token,
    body: {
      ...current,
      smtpServer: smtpServerRepresentation(),
    },
  });
}

/**
 * A1.8: the realm must keep the user events the worker uses to build the timeline of the first admin
 * merged with the values other teams have set (existing listeners/types are not removed and the lifetime of events kept longer is not reduced)
 */
async function ensureUserEvents(token) {
  const current = await request(`${realmPath}/events/config`, { token });
  const types = current.enabledEventTypes ?? [];
  await request(`${realmPath}/events/config`, {
    method: 'PUT',
    token,
    body: {
      ...current,
      eventsEnabled: true,
      // an empty list = Keycloak already keeps every type
      enabledEventTypes:
        types.length === 0 ? [] : [...new Set([...types, ...FIRST_ADMIN_EVENT_TYPES])],
      eventsExpiration: Math.max(current.eventsExpiration ?? 0, EVENTS_EXPIRATION_SECONDS),
    },
  });
}

/**
 * fail closed: the invitation guard (#436) must really be loaded, otherwise old-generation links stay usable
 * Keycloak does not expose the class name of a provider in serverinfo, so check that there is an `execute-actions` provider
 * with an order higher than the default (present only when our jar is loaded)
 */
async function verifyInvitationGuard(token) {
  const info = await request('/admin/serverinfo', { token });
  const handlers = info.providers?.actionTokenHandler?.providers ?? {};
  const executeActions = handlers['execute-actions'];
  if (!executeActions || !(executeActions.order > 0)) {
    throw new Error(
      'Keycloak did not load the invitation guard (#436) - run pnpm infra:keycloak:extensions and then restart keycloak',
    );
  }
  return executeActions.order;
}

export const TENANT_CONSOLE_POLICY = 'dcontact-provisioner (tenant console redirects)';
export const TENANT_CONSOLE_PERMISSION = 'dcontact-provisioner: tenant console redirects';
export const TENANT_CONSOLE_SCOPES = Object.freeze(['view', 'manage']);

async function upsertAuthz(server, kind, name, representation, token) {
  const existing = await request(
    `${server}/${kind === 'policy' ? 'policy' : 'permission'}?name=${encodeURIComponent(name)}`,
    {
      token,
    },
  );
  const current = (existing ?? []).find((item) => item.name === name);
  const path = kind === 'policy' ? `${server}/policy/client` : `${server}/permission/scope`;
  if (current) {
    await request(`${path}/${current.id}`, {
      method: 'PUT',
      token,
      body: { ...representation, id: current.id },
    });
    return current.id;
  }
  return (await request(path, { method: 'POST', token, body: representation })).id;
}

/**
 * #907: the provisioner gets `view`/`manage` through fine-grained admin permission v2 only on the tenant Console client
 * to add per-tenant redirects - not realm-management `manage-clients` for the whole realm
 * set only when a client is specified (UAT: `PLATFORM_TENANT_CONSOLE_CLIENT_ID`); the existing permission is replaced so it points at this single client
 */
export async function ensureTenantConsolePermission(consoleClientId, token) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(consoleClientId ?? '')) {
    throw new Error('the tenant Console client is invalid');
  }
  const accessToken = token ?? (await adminToken());
  const current = await request(realmPath, { token: accessToken });
  if (!current.adminPermissionsEnabled) {
    await request(realmPath, {
      method: 'PUT',
      token: accessToken,
      body: { ...current, adminPermissionsEnabled: true },
    });
  }
  const [consoleClient] = await request(
    `${realmPath}/clients?clientId=${encodeURIComponent(consoleClientId)}`,
    { token: accessToken },
  );
  if (
    !consoleClient ||
    consoleClient.clientId !== consoleClientId ||
    consoleClient.publicClient !== true
  ) {
    throw new Error(`public tenant Console client not found: ${consoleClientId}`);
  }
  const [provisioner] = await request(`${realmPath}/clients?clientId=${PROVISIONER_CLIENT}`, {
    token: accessToken,
  });
  const [adminPermissions] = await request(`${realmPath}/clients?clientId=admin-permissions`, {
    token: accessToken,
  });
  if (!provisioner || !adminPermissions) {
    throw new Error(
      'dcontact-provisioner or admin-permissions not found - Keycloak must be >= 26.2',
    );
  }
  const server = `${realmPath}/clients/${adminPermissions.id}/authz/resource-server`;
  const policyId = await upsertAuthz(
    server,
    'policy',
    TENANT_CONSOLE_POLICY,
    {
      name: TENANT_CONSOLE_POLICY,
      type: 'client',
      logic: 'POSITIVE',
      decisionStrategy: 'UNANIMOUS',
      clients: [provisioner.id],
    },
    accessToken,
  );
  await upsertAuthz(
    server,
    'permission',
    TENANT_CONSOLE_PERMISSION,
    {
      name: TENANT_CONSOLE_PERMISSION,
      description: '#907: เพิ่ม redirect ราย tenant ให้ tenant Console client เท่านั้น', // allow-thai: description is persisted in the Keycloak realm
      resourceType: 'Clients',
      resources: [consoleClient.id],
      scopes: [...TENANT_CONSOLE_SCOPES],
      policies: [policyId],
      decisionStrategy: 'UNANIMOUS',
    },
    accessToken,
  );
  return { consoleClient: consoleClientId, scopes: [...TENANT_CONSOLE_SCOPES] };
}

export async function setupKeycloakProvisioning() {
  const token = await adminToken();
  await verifyInvitationGuard(token);
  await ensureProvisionerClient(token);
  await ensureUserProfile(token);
  await ensureSmtp(token);
  await ensureUserEvents(token);
  const consoleClientId = process.env.PLATFORM_TENANT_CONSOLE_CLIENT_ID;
  const tenantConsole = consoleClientId
    ? await ensureTenantConsolePermission(consoleClientId, token)
    : null;
  return {
    client: PROVISIONER_CLIENT,
    roles: [...PROVISIONER_REALM_MANAGEMENT_ROLES],
    tenantConsole,
  };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const result = await setupKeycloakProvisioning();
    process.stdout.write(
      `${JSON.stringify({ type: 'keycloak.provisioning.setup', status: 'PASS', ...result })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
