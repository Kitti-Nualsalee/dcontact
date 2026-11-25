import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * AC0 (#592): the service account for account self-service (#589) on the `dcontact` realm - idempotent through the Admin API
 *
 * uses fine-grained admin permissions v2 (Keycloak >= 26.2) instead of the realm-wide realm-management role:
 * - `dcontact-account-service`: a confidential client + a service account with no realm-management role
 * - the `view`/`manage`/`reset-password` permissions on Users - only what the D-Contact API needs to edit name/email/password/OTP
 * - **deny every scope** for users who are not members of any Organization (platform operator/auditor, system service accounts,
 *   realm admins) - probe result on 26.7.5: a group-level deny does not cover `reset-password`,
 *   so the deny must be per user, which covers every scope
 * - holders of a client role of `dcontact-platform-api` are always denied even if they are in an Organization (#685, #387: a platform identity
 *   must not be a tenant member - guards against a wrong binding like the one found on UAT)
 * - the protected list is recomputed on every run - after adding a new platform user this script must be re-run (runbook)
 *   and the D-Contact API still checks that the target is the token owner in the same tenant (the second layer)
 *
 * side effect of enabling FGAP v2: listing Organizations is filtered by permission immediately, except for holders of
 * `view-organizations`/`manage-organizations` - so the provisioner gets `manage-organizations` in
 * keycloak-provisioning-setup.mjs (that script runs before this one in `infra:bootstrap`)
 *
 * AC2 (#595): the tenant browser flow `dcontact-browser` (a copy of Keycloak `browser`) enforces 2FA per
 * Organization with the `dc-account` extension (infra/keycloak/extensions/dc-account):
 * - a new subflow "Org 2FA" (CONDITIONAL): `dc-org-mfa-required` + `auth-otp-form` as REQUIRED -
 *   no OTP yet = the required action `CONFIGURE_TOTP`; already has one = ask for OTP
 * - the original 2FA subflow: adds `dc-org-mfa-required` as negate so OTP is not asked twice when the org enforces it
 * - bound as the browser flow of the realm - `platform-console` has its own flow (keycloak-platform-setup.mjs) so it is not affected
 * - evaluated at login only: once enforcement is on it takes effect at the next login and does not cut off a session in use (#589 D10)
 *
 * `--keep-realm-browser-flow` (#645): set up the whole flow but do not bind it to the realm - UAT uses the flow of the realm template
 * (`uat browser password otp`, which `u1-uat-keycloak-users.mjs --config` sets) as its single owner
 *
 * `--verify` checks with the token of the real service account: it can edit a tenant user, cannot touch a protected user,
 * cannot read the realm clients, can call the `dc-account` extension (another token = 403), and the flow is fully set up
 */
export const ACCOUNT_SERVICE_CLIENT = 'dcontact-account-service';
export const ALLOW_POLICY = 'dc-account-service';
export const DENY_POLICY = 'dc-account-service-deny';
export const USERS_PERMISSION = 'dc-account-service-users';
export const PROTECTED_PERMISSION = 'dc-account-service-protected-users';
export const TENANT_BROWSER_FLOW = 'dcontact-browser';
export const ORG_MFA_FLOW = `${TENANT_BROWSER_FLOW} Org 2FA`;
export const ORG_MFA_CONDITION = 'dc-org-mfa-required';
export const ORG_MFA_NEGATE_CONFIG = `${TENANT_BROWSER_FLOW}-org-mfa-negate`;
/**
 * #685: the client/roles of the platform (the same values as keycloak-platform-setup.mjs - not imported because that module checks env on load)
 * users with these roles are always protected, even if wrongly bound into a tenant Organization (#387)
 */
export const PLATFORM_API_CLIENT = 'dcontact-platform-api';
export const PLATFORM_ROLES = Object.freeze(['platform_operator', 'platform_auditor']);
export const ALLOWED_USER_SCOPES = Object.freeze(['view', 'manage', 'reset-password']);
export const ALL_USER_SCOPES = Object.freeze([
  'view',
  'manage',
  'reset-password',
  'map-roles',
  'manage-group-membership',
  'impersonate',
]);

const realm = 'dcontact';
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin';
export const accountServiceSecret =
  process.env.KEYCLOAK_ACCOUNT_SERVICE_SECRET ?? 'dcontact-account-service-dev-secret';

const PAGE = 100;

/** A user who is not a member of any Organization = not a tenant user -> the service account must not touch them */
export function protectedUserIds(allUserIds, organizationMemberIds, platformUserIds = []) {
  const members = new Set(organizationMemberIds);
  const platform = new Set(platformUserIds);
  return [...new Set(allUserIds)].filter((id) => !members.has(id) || platform.has(id)).sort();
}

/** The first tenant user who is not protected - used as the target of `--verify` */
export function firstTenantUser(organizationMemberIds, protectedIds) {
  const blocked = new Set(protectedIds);
  return organizationMemberIds.find((id) => !blocked.has(id));
}

export function clientRepresentation(secret) {
  return {
    clientId: ACCOUNT_SERVICE_CLIENT,
    name: 'D-Contact Account Service',
    enabled: true,
    publicClient: false,
    bearerOnly: false,
    protocol: 'openid-connect',
    secret,
    serviceAccountsEnabled: true,
    standardFlowEnabled: false,
    implicitFlowEnabled: false,
    directAccessGrantsEnabled: false,
  };
}

/**
 * a deny with no resources = deny every user (the whole resource type) - with no user to protect, no deny is created
 */
export function permissionRepresentations({ allowPolicyId, denyPolicyId, protectedIds }) {
  const permissions = [
    {
      name: USERS_PERMISSION,
      description: '#589: self-service บัญชีผ่าน API ของ D-Contact', // allow-thai: description is persisted in the Keycloak realm
      // no resources = every user of the realm (except those denied below)
      resourceType: 'Users',
      scopes: [...ALLOWED_USER_SCOPES],
      policies: [allowPolicyId],
      decisionStrategy: 'UNANIMOUS',
    },
    {
      name: PROTECTED_PERMISSION,
      description: '#592: ผู้ใช้ที่ไม่อยู่ใน Organization ใด (platform/service account/admin)', // allow-thai: description is persisted in the Keycloak realm
      resourceType: 'Users',
      resources: [...protectedIds],
      scopes: [...ALL_USER_SCOPES],
      policies: [denyPolicyId],
      decisionStrategy: 'UNANIMOUS',
    },
  ];
  return protectedIds.length > 0 ? permissions : permissions.slice(0, 1);
}

async function request(path, { method = 'GET', token, body, form, accept = [] } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (form !== undefined) headers['content-type'] = 'application/x-www-form-urlencoded';
  const response = await fetch(`${keycloakBaseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? form : JSON.stringify(body),
  });
  if (!response.ok && !accept.includes(response.status)) {
    throw new Error(`${method} ${path.split('?')[0]} failed (${response.status})`);
  }
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}

async function token(form) {
  const { body } = await request(
    `/realms/${form.get('realm') ?? 'master'}/protocol/openid-connect/token`,
    { method: 'POST', form: new URLSearchParams([...form].filter(([key]) => key !== 'realm')) },
  );
  return body.access_token;
}

const adminToken = () =>
  token(
    new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUsername,
      password: adminPassword,
    }),
  );

const realmPath = `/admin/realms/${realm}`;

async function pages(path, accessToken) {
  const items = [];
  for (let first = 0; ; first += PAGE) {
    const separator = path.includes('?') ? '&' : '?';
    const { body } = await request(`${path}${separator}first=${first}&max=${PAGE}`, {
      token: accessToken,
    });
    items.push(...body);
    if (body.length < PAGE) return items;
  }
}

async function ensureClient(accessToken) {
  const representation = clientRepresentation(accountServiceSecret);
  let {
    body: [client],
  } = await request(`${realmPath}/clients?clientId=${ACCOUNT_SERVICE_CLIENT}`, {
    token: accessToken,
  });
  if (client) {
    await request(`${realmPath}/clients/${client.id}`, {
      method: 'PUT',
      token: accessToken,
      body: { ...client, ...representation, id: client.id },
    });
  } else {
    await request(`${realmPath}/clients`, {
      method: 'POST',
      token: accessToken,
      body: representation,
    });
    ({
      body: [client],
    } = await request(`${realmPath}/clients?clientId=${ACCOUNT_SERVICE_CLIENT}`, {
      token: accessToken,
    }));
  }
  // no realm-management role at all - every permission comes from the fine-grained permissions below
  const { body: serviceAccount } = await request(
    `${realmPath}/clients/${client.id}/service-account-user`,
    { token: accessToken },
  );
  const {
    body: [realmManagement],
  } = await request(`${realmPath}/clients?clientId=realm-management`, { token: accessToken });
  const { body: granted } = await request(
    `${realmPath}/users/${serviceAccount.id}/role-mappings/clients/${realmManagement.id}`,
    { token: accessToken },
  );
  if (granted.length > 0) {
    await request(
      `${realmPath}/users/${serviceAccount.id}/role-mappings/clients/${realmManagement.id}`,
      { method: 'DELETE', token: accessToken, body: granted },
    );
  }
  return client;
}

async function upsert(listPath, createPath, name, representation, accessToken) {
  const { body: existing } = await request(`${listPath}?name=${encodeURIComponent(name)}`, {
    token: accessToken,
  });
  const current = (existing ?? []).find((item) => item.name === name);
  if (current) {
    await request(`${createPath}/${current.id}`, {
      method: 'PUT',
      token: accessToken,
      body: { ...representation, id: current.id },
    });
    return current.id;
  }
  const { body: created } = await request(createPath, {
    method: 'POST',
    token: accessToken,
    body: representation,
  });
  return created.id;
}

/**
 * Every user of the realm including service accounts - `GET /users` does not return service account users, so fetch them from the clients that enable
 * a service account by another route (probe on 26.7.5: the service account of another client can be edited unless denied)
 */
async function realmUsers(accessToken) {
  const users = await pages(`${realmPath}/users?briefRepresentation=true`, accessToken);
  const clients = await pages(`${realmPath}/clients`, accessToken);
  const serviceAccounts = [];
  for (const client of clients.filter((item) => item.serviceAccountsEnabled)) {
    const { body } = await request(`${realmPath}/clients/${client.id}/service-account-user`, {
      token: accessToken,
    });
    serviceAccounts.push(body.id);
  }
  const organizations = await pages(
    `${realmPath}/organizations?briefRepresentation=true`,
    accessToken,
  );
  const memberIds = [];
  for (const organization of organizations) {
    const members = await pages(
      `${realmPath}/organizations/${organization.id}/members`,
      accessToken,
    );
    memberIds.push(...members.map((member) => member.id));
  }
  // #685: every holder of a platform role (direct mapping) - must be in the deny list even if a member of an Organization
  const platformIds = [];
  const platformClient = clients.find((client) => client.clientId === PLATFORM_API_CLIENT);
  if (platformClient) {
    for (const role of PLATFORM_ROLES) {
      const holders = await pages(
        `${realmPath}/clients/${platformClient.id}/roles/${role}/users?briefRepresentation=true`,
        accessToken,
      );
      platformIds.push(...holders.map((user) => user.id));
    }
  }
  return {
    userIds: [...users.map((user) => user.id), ...serviceAccounts],
    memberIds,
    platformIds,
  };
}

/**
 * the executions of a flow (ordered depth-first with `level`) -> the direct child executions of the subflow at that index
 * (`-1` = the top level)
 */
export function childrenOf(executions, parentIndex) {
  const level = parentIndex < 0 ? 0 : executions[parentIndex].level + 1;
  const children = [];
  for (let index = parentIndex + 1; index < executions.length; index += 1) {
    const execution = executions[index];
    if (execution.level < level) break;
    if (execution.level === level) children.push({ ...execution, position: index });
  }
  return children;
}

/** The `forms` subflow (has username/password) and the original Keycloak 2FA subflow (has the OTP form + user configured) */
export function locateBrowserSubflows(executions) {
  const subflows = executions
    .map((execution, index) => ({ ...execution, position: index }))
    .filter((execution) => execution.authenticationFlow);
  const providers = (subflow) =>
    childrenOf(executions, subflow.position).map((child) => child.providerId);
  const forms = subflows.find(
    (subflow) => subflow.level === 0 && providers(subflow).includes('auth-username-password-form'),
  );
  const twoFactor = subflows.find(
    (subflow) =>
      subflow.displayName !== ORG_MFA_FLOW &&
      providers(subflow).includes('auth-otp-form') &&
      providers(subflow).includes('conditional-user-configured'),
  );
  const orgMfa = subflows.find((subflow) => subflow.displayName === ORG_MFA_FLOW);
  return { forms, twoFactor, orgMfa };
}

async function setRequirement(accessToken, { position: _position, ...execution }, requirement) {
  // `position` belongs to childrenOf/locateBrowserSubflows - Keycloak rejects unknown fields (400)
  if (execution.requirement === requirement) return;
  await request(`${realmPath}/authentication/flows/${TENANT_BROWSER_FLOW}/executions`, {
    method: 'PUT',
    token: accessToken,
    body: { ...execution, requirement },
  });
}

/** Set up the tenant browser flow - idempotent (add only the missing parts, then fix the requirement/config to match) */
async function ensureTenantBrowserFlow(accessToken, { bindRealm }) {
  const flowsPath = `${realmPath}/authentication/flows`;
  const executionsPath = `${flowsPath}/${encodeURIComponent(TENANT_BROWSER_FLOW)}/executions`;
  const { body: flows } = await request(flowsPath, { token: accessToken });
  if (!flows.some((flow) => flow.alias === TENANT_BROWSER_FLOW)) {
    await request(`${flowsPath}/browser/copy`, {
      method: 'POST',
      token: accessToken,
      body: { newName: TENANT_BROWSER_FLOW },
    });
  }
  const executions = async () => (await request(executionsPath, { token: accessToken })).body;
  let located = locateBrowserSubflows(await executions());
  if (!located.forms || !located.twoFactor) {
    throw new Error(
      `${TENANT_BROWSER_FLOW}: the forms/2FA subflows copied from browser were not found`,
    );
  }
  const subflowPath = (subflow) =>
    `${flowsPath}/${encodeURIComponent(subflow.displayName)}/executions`;

  // the original 2FA subflow: + a negate condition
  if (
    !childrenOf(await executions(), located.twoFactor.position).some(
      (child) => child.providerId === ORG_MFA_CONDITION,
    )
  ) {
    await request(`${subflowPath(located.twoFactor)}/execution`, {
      method: 'POST',
      token: accessToken,
      body: { provider: ORG_MFA_CONDITION },
    });
  }
  // the Org 2FA subflow in forms
  if (!located.orgMfa) {
    await request(`${subflowPath(located.forms)}/flow`, {
      method: 'POST',
      token: accessToken,
      body: {
        alias: ORG_MFA_FLOW,
        description:
          'AC2 #595: Organization บังคับ 2FA — ยังไม่มี OTP = ตั้งก่อน, มีแล้ว = ถาม OTP', // allow-thai: description is persisted in the Keycloak flow
        provider: 'registration-page-form',
        type: 'basic-flow',
      },
    });
  }
  located = locateBrowserSubflows(await executions());
  const orgChildren = childrenOf(await executions(), located.orgMfa.position);
  for (const provider of [ORG_MFA_CONDITION, 'auth-otp-form']) {
    if (!orgChildren.some((child) => child.providerId === provider)) {
      await request(`${subflowPath(located.orgMfa)}/execution`, {
        method: 'POST',
        token: accessToken,
        body: { provider },
      });
    }
  }

  const all = await executions();
  located = locateBrowserSubflows(all);
  await setRequirement(accessToken, located.orgMfa, 'CONDITIONAL');
  for (const child of childrenOf(all, located.orgMfa.position)) {
    await setRequirement(accessToken, child, 'REQUIRED');
  }
  const negated = childrenOf(all, located.twoFactor.position).find(
    (child) => child.providerId === ORG_MFA_CONDITION,
  );
  await setRequirement(accessToken, negated, 'REQUIRED');
  const negateConfig = { alias: ORG_MFA_NEGATE_CONFIG, config: { 'dc.negate': 'true' } };
  if (!negated.authenticationConfig) {
    await request(`${realmPath}/authentication/executions/${negated.id}/config`, {
      method: 'POST',
      token: accessToken,
      body: negateConfig,
    });
  } else {
    await request(`${realmPath}/authentication/config/${negated.authenticationConfig}`, {
      method: 'PUT',
      token: accessToken,
      body: { ...negateConfig, id: negated.authenticationConfig },
    });
  }

  // an OTP form as REQUIRED sets CONFIGURE_TOTP for a user without OTP - the required action must be enabled
  const { body: configureTotp } = await request(
    `${realmPath}/authentication/required-actions/CONFIGURE_TOTP`,
    { token: accessToken },
  );
  if (!configureTotp.enabled) {
    await request(`${realmPath}/authentication/required-actions/CONFIGURE_TOTP`, {
      method: 'PUT',
      token: accessToken,
      body: { ...configureTotp, enabled: true },
    });
  }
  if (!bindRealm) return;
  const { body: current } = await request(realmPath, { token: accessToken });
  if (current.browserFlow !== TENANT_BROWSER_FLOW) {
    await request(realmPath, {
      method: 'PUT',
      token: accessToken,
      body: { ...current, browserFlow: TENANT_BROWSER_FLOW },
    });
  }
}

/** The flow as set up matches what is wanted - returns the wrong items (empty = pass) */
export function browserFlowFailures(realmRepresentation, executions, { bindRealm = true } = {}) {
  const failures = [];
  if (bindRealm && realmRepresentation.browserFlow !== TENANT_BROWSER_FLOW) {
    failures.push(`the realm browser flow must be ${TENANT_BROWSER_FLOW}`);
  }
  const { twoFactor, orgMfa } = locateBrowserSubflows(executions);
  if (!orgMfa || orgMfa.requirement !== 'CONDITIONAL') {
    failures.push(`${ORG_MFA_FLOW} must be CONDITIONAL`);
  } else {
    const children = childrenOf(executions, orgMfa.position);
    for (const provider of [ORG_MFA_CONDITION, 'auth-otp-form']) {
      if (
        !children.some((child) => child.providerId === provider && child.requirement === 'REQUIRED')
      )
        failures.push(`${ORG_MFA_FLOW} must have ${provider} as REQUIRED`);
    }
  }
  const negated =
    twoFactor &&
    childrenOf(executions, twoFactor.position).find(
      (child) => child.providerId === ORG_MFA_CONDITION,
    );
  if (!negated || negated.requirement !== 'REQUIRED' || !negated.authenticationConfig) {
    failures.push('the original 2FA subflow must have dc-org-mfa-required as negate');
  }
  return failures;
}

export async function setupAccountService({ bindRealm = true } = {}) {
  const accessToken = await adminToken();
  const { body: current } = await request(realmPath, { token: accessToken });
  if (!current.adminPermissionsEnabled) {
    await request(realmPath, {
      method: 'PUT',
      token: accessToken,
      body: { ...current, adminPermissionsEnabled: true },
    });
  }
  const client = await ensureClient(accessToken);

  const {
    body: [adminPermissions],
  } = await request(`${realmPath}/clients?clientId=admin-permissions`, { token: accessToken });
  if (!adminPermissions)
    throw new Error('client admin-permissions not found - Keycloak must be >= 26.2');
  const server = `${realmPath}/clients/${adminPermissions.id}/authz/resource-server`;

  const policy = (name, logic) => ({
    name,
    type: 'client',
    logic,
    decisionStrategy: 'UNANIMOUS',
    clients: [client.id],
  });
  const allowPolicyId = await upsert(
    `${server}/policy`,
    `${server}/policy/client`,
    ALLOW_POLICY,
    policy(ALLOW_POLICY, 'POSITIVE'),
    accessToken,
  );
  const denyPolicyId = await upsert(
    `${server}/policy`,
    `${server}/policy/client`,
    DENY_POLICY,
    policy(DENY_POLICY, 'NEGATIVE'),
    accessToken,
  );

  const { userIds, memberIds, platformIds } = await realmUsers(accessToken);
  const protectedIds = protectedUserIds(userIds, memberIds, platformIds);

  const permissions = permissionRepresentations({ allowPolicyId, denyPolicyId, protectedIds });
  if (!permissions.some((permission) => permission.name === PROTECTED_PERMISSION)) {
    const { body: stale } = await request(
      `${server}/permission?name=${encodeURIComponent(PROTECTED_PERMISSION)}`,
      { token: accessToken },
    );
    for (const permission of (stale ?? []).filter((item) => item.name === PROTECTED_PERMISSION)) {
      await request(`${server}/permission/${permission.id}`, {
        method: 'DELETE',
        token: accessToken,
      });
    }
  }
  for (const permission of permissions) {
    await upsert(
      `${server}/permission`,
      `${server}/permission/scope`,
      permission.name,
      permission,
      accessToken,
    );
  }

  await ensureTenantBrowserFlow(accessToken, { bindRealm });

  return { protectedUsers: protectedIds.length, tenantUsers: new Set(memberIds).size };
}

/** Check with the token of the real service account - returns the checks that failed (empty = pass) */
export async function verifyAccountService({ bindRealm = true } = {}) {
  const accessToken = await adminToken();
  const { userIds, memberIds, platformIds } = await realmUsers(accessToken);
  const protectedIds = protectedUserIds(userIds, memberIds, platformIds);
  const tenantUserId = firstTenantUser(memberIds, protectedIds);
  if (!tenantUserId || protectedIds.length === 0)
    return ['there must be at least one tenant user and one protected user'];

  const serviceToken = await token(
    new URLSearchParams({
      realm,
      grant_type: 'client_credentials',
      client_id: ACCOUNT_SERVICE_CLIENT,
      client_secret: accountServiceSecret,
    }),
  );
  const status = async (path, method = 'GET') =>
    (await request(`${realmPath}${path}`, { method, token: serviceToken, accept: [403, 404] }))
      .status;

  const failures = [];
  const expect = (label, actual, expected) => {
    if (actual !== expected) failures.push(`${label}: got ${actual}, expected ${expected}`);
  };
  expect('read a tenant user', await status(`/users/${tenantUserId}`), 200);
  expect(
    'read the credentials of a tenant user',
    await status(`/users/${tenantUserId}/credentials`),
    200,
  );
  // every protected user, including system service accounts - not tested with write commands so verify does not edit real accounts
  for (const id of protectedIds) {
    expect(`read a protected user ${id}`, await status(`/users/${id}`), 403);
    expect(
      `read the credentials of a protected user ${id}`,
      await status(`/users/${id}/credentials`),
      403,
    );
  }
  expect('read the realm clients', await status('/clients'), 403);
  // `view` can read role mappings (the scope cannot be split) but must not be able to map roles - sending an empty array changes nothing
  const mapRoles = await request(`${realmPath}/users/${tenantUserId}/role-mappings/realm`, {
    method: 'POST',
    token: serviceToken,
    body: [],
    accept: [403],
  });
  expect('map a realm role to a tenant user', mapRoles.status, 403);

  // the dc-account extension: an invalid body = 400 before touching any data (so no real account is edited); another token = 403
  const extension = `/realms/${realm}/dc-account/users/${tenantUserId}/totp/verify-and-create`;
  const call = async (bearer) =>
    (
      await request(extension, {
        method: 'POST',
        token: bearer,
        body: { tenantId: 'invalid' },
        accept: [400, 401, 403, 404],
      })
    ).status;
  expect('the dc-account extension with the account service', await call(serviceToken), 400);
  // an admin token (the master realm) = a token of another realm -> 401; another token in the same realm -> 403 (boundary test)
  const foreign = await call(accessToken);
  if (foreign !== 401 && foreign !== 403) {
    failures.push(
      `the dc-account extension with the admin token: got ${foreign}, expected it to be rejected`,
    );
  }

  const { body: realmRepresentation } = await request(realmPath, { token: accessToken });
  const { body: executions } = await request(
    `${realmPath}/authentication/flows/${encodeURIComponent(TENANT_BROWSER_FLOW)}/executions`,
    { token: accessToken, accept: [404] },
  );
  failures.push(...browserFlowFailures(realmRepresentation, executions ?? [], { bindRealm }));
  return failures;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const verify = process.argv.includes('--verify');
  const bindRealm = !process.argv.includes('--keep-realm-browser-flow');
  try {
    if (verify) {
      const failures = await verifyAccountService({ bindRealm });
      if (failures.length > 0) throw new Error(failures.join('; '));
      console.log(JSON.stringify({ type: 'keycloak.account-service.verify', status: 'PASS' }));
    } else {
      const result = await setupAccountService({ bindRealm });
      console.log(
        JSON.stringify({ type: 'keycloak.account-service.setup', status: 'PASS', ...result }),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
