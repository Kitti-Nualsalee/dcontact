import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * AC0 (#592): service account ของ self-service บัญชี (#589) บน realm `dcontact` — idempotent ผ่าน Admin API
 *
 * ใช้ fine-grained admin permissions v2 (Keycloak ≥ 26.2) แทน realm-management role ทั้ง realm:
 * - `dcontact-account-service`: confidential client + service account ไม่มี realm-management role ใด
 * - สิทธิ์ `view`/`manage`/`reset-password` บน Users — เท่าที่ API ของ D-Contact ต้องใช้แก้ชื่อ/email/รหัสผ่าน/OTP
 * - **deny ทุก scope** กับผู้ใช้ที่ไม่เป็นสมาชิก Organization ใดเลย (platform operator/auditor, service account
 *   ของระบบ, admin ของ realm) — ผล probe บน 26.7.5: deny ระดับ group ไม่ครอบ `reset-password`
 *   จึงต้อง deny เป็นราย user ซึ่งครอบทุก scope
 * - รายชื่อที่ถูกป้องกันคำนวณใหม่ทุกครั้งที่รัน — เพิ่ม platform user ใหม่แล้วต้องรันสคริปต์นี้ซ้ำ (runbook)
 *   และ API ของ D-Contact ยังตรวจว่าเป้าหมายเป็นผู้ใช้เจ้าของ token ใน tenant เดียวกันเสมอ (ชั้นที่สอง)
 *
 * ผลข้างเคียงของการเปิด FGAP v2: การ list Organization กรองตาม permission ทันที ยกเว้นผู้มี
 * `view-organizations`/`manage-organizations` — provisioner จึงได้ `manage-organizations` ใน
 * keycloak-provisioning-setup.mjs (สคริปต์นั้นรันก่อนสคริปต์นี้ใน `infra:bootstrap`)
 *
 * AC2 (#595): browser flow ของ tenant `dcontact-browser` (copy จาก `browser` ของ Keycloak) บังคับ 2FA ตาม
 * Organization ด้วย extension `dc-account` (infra/keycloak/extensions/dc-account):
 * - subflow ใหม่ "Org 2FA" (CONDITIONAL): `dc-org-mfa-required` + `auth-otp-form` แบบ REQUIRED —
 *   ยังไม่มี OTP = required action `CONFIGURE_TOTP`; มีแล้ว = ถาม OTP
 * - subflow 2FA เดิม: เพิ่ม `dc-org-mfa-required` แบบ negate เพื่อไม่ถาม OTP สองรอบเมื่อ org บังคับ
 * - ผูกเป็น browser flow ของ realm — `platform-console` มี flow ของตัวเอง (keycloak-platform-setup.mjs) จึงไม่กระทบ
 * - ประเมินตอน login เท่านั้น: เปิดบังคับแล้วมีผล login ครั้งถัดไป ไม่ตัด session ที่ใช้อยู่ (#589 D10)
 *
 * `--verify` ตรวจด้วย token ของ service account จริง: แก้ผู้ใช้ tenant ได้, แตะผู้ใช้ที่ถูกป้องกันไม่ได้,
 * อ่าน client ของ realm ไม่ได้, เรียก extension `dc-account` ได้ (token อื่น = 403) และ flow ถูกตั้งครบ
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

/** ผู้ใช้ที่ไม่เป็นสมาชิก Organization ใดเลย = ไม่ใช่ผู้ใช้ของ tenant → ห้าม service account แตะ */
export function protectedUserIds(allUserIds, organizationMemberIds) {
  const members = new Set(organizationMemberIds);
  return [...new Set(allUserIds)].filter((id) => !members.has(id)).sort();
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
 * deny ที่ไม่มี resources = deny ผู้ใช้ทุกคน (resource type ทั้งชุด) — ไม่มีผู้ใช้ที่ต้องป้องกันจึงไม่สร้าง deny
 */
export function permissionRepresentations({ allowPolicyId, denyPolicyId, protectedIds }) {
  const permissions = [
    {
      name: USERS_PERMISSION,
      description: '#589: self-service บัญชีผ่าน API ของ D-Contact',
      // ไม่ระบุ resources = ผู้ใช้ทุกคนของ realm (ยกเว้นที่ถูก deny ด้านล่าง)
      resourceType: 'Users',
      scopes: [...ALLOWED_USER_SCOPES],
      policies: [allowPolicyId],
      decisionStrategy: 'UNANIMOUS',
    },
    {
      name: PROTECTED_PERMISSION,
      description: '#592: ผู้ใช้ที่ไม่อยู่ใน Organization ใด (platform/service account/admin)',
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
    throw new Error(`${method} ${path.split('?')[0]} ล้มเหลว (${response.status})`);
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
  // ไม่มี realm-management role ใด — สิทธิ์ทั้งหมดมาจาก fine-grained permission ด้านล่าง
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
 * ผู้ใช้ทุกคนของ realm รวม service account — `GET /users` ไม่คืน service account user จึงดึงจาก client ที่เปิด
 * service account อีกทาง (probe บน 26.7.5: service account ของ client อื่นถูกแก้ได้ถ้าไม่ deny)
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
  return { userIds: [...users.map((user) => user.id), ...serviceAccounts], memberIds };
}

/**
 * execution ของ flow (เรียงแบบ depth-first พร้อม `level`) → execution ลูกโดยตรงของ subflow ที่ index นั้น
 * (`-1` = ระดับบนสุด)
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

/** subflow `forms` (มี username/password) และ subflow 2FA เดิมของ Keycloak (มี OTP form + user configured) */
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
  // `position` เป็นของ childrenOf/locateBrowserSubflows — Keycloak ปฏิเสธ field ที่ไม่รู้จัก (400)
  if (execution.requirement === requirement) return;
  await request(`${realmPath}/authentication/flows/${TENANT_BROWSER_FLOW}/executions`, {
    method: 'PUT',
    token: accessToken,
    body: { ...execution, requirement },
  });
}

/** ตั้ง browser flow ของ tenant — idempotent (เพิ่มเฉพาะส่วนที่ยังไม่มี แล้วแก้ requirement/config ให้ตรง) */
async function ensureTenantBrowserFlow(accessToken) {
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
    throw new Error(`${TENANT_BROWSER_FLOW}: ไม่พบ subflow forms/2FA ที่ copy มาจาก browser`);
  }
  const subflowPath = (subflow) =>
    `${flowsPath}/${encodeURIComponent(subflow.displayName)}/executions`;

  // subflow 2FA เดิม: + condition แบบ negate
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
  // subflow Org 2FA ใน forms
  if (!located.orgMfa) {
    await request(`${subflowPath(located.forms)}/flow`, {
      method: 'POST',
      token: accessToken,
      body: {
        alias: ORG_MFA_FLOW,
        description:
          'AC2 #595: Organization บังคับ 2FA — ยังไม่มี OTP = ตั้งก่อน, มีแล้ว = ถาม OTP',
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

  // OTP form แบบ REQUIRED ตั้ง CONFIGURE_TOTP ให้ผู้ใช้ที่ยังไม่มี OTP — required action ต้องเปิดอยู่
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
  const { body: current } = await request(realmPath, { token: accessToken });
  if (current.browserFlow !== TENANT_BROWSER_FLOW) {
    await request(realmPath, {
      method: 'PUT',
      token: accessToken,
      body: { ...current, browserFlow: TENANT_BROWSER_FLOW },
    });
  }
}

/** flow ที่ตั้งแล้วตรงกับที่ต้องการ — คืนรายการที่ผิด (ว่าง = ผ่าน) */
export function browserFlowFailures(realmRepresentation, executions) {
  const failures = [];
  if (realmRepresentation.browserFlow !== TENANT_BROWSER_FLOW) {
    failures.push(`browser flow ของ realm ต้องเป็น ${TENANT_BROWSER_FLOW}`);
  }
  const { twoFactor, orgMfa } = locateBrowserSubflows(executions);
  if (!orgMfa || orgMfa.requirement !== 'CONDITIONAL') {
    failures.push(`${ORG_MFA_FLOW} ต้องเป็น CONDITIONAL`);
  } else {
    const children = childrenOf(executions, orgMfa.position);
    for (const provider of [ORG_MFA_CONDITION, 'auth-otp-form']) {
      if (
        !children.some((child) => child.providerId === provider && child.requirement === 'REQUIRED')
      )
        failures.push(`${ORG_MFA_FLOW} ต้องมี ${provider} แบบ REQUIRED`);
    }
  }
  const negated =
    twoFactor &&
    childrenOf(executions, twoFactor.position).find(
      (child) => child.providerId === ORG_MFA_CONDITION,
    );
  if (!negated || negated.requirement !== 'REQUIRED' || !negated.authenticationConfig) {
    failures.push('subflow 2FA เดิมต้องมี dc-org-mfa-required แบบ negate');
  }
  return failures;
}

export async function setupAccountService() {
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
  if (!adminPermissions) throw new Error('ไม่พบ client admin-permissions — Keycloak ต้อง ≥ 26.2');
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

  const { userIds, memberIds } = await realmUsers(accessToken);
  const protectedIds = protectedUserIds(userIds, memberIds);

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

  await ensureTenantBrowserFlow(accessToken);

  return { protectedUsers: protectedIds.length, tenantUsers: new Set(memberIds).size };
}

/** ตรวจด้วย token ของ service account จริง — คืนรายการ check ที่ล้ม (ว่าง = ผ่าน) */
export async function verifyAccountService() {
  const accessToken = await adminToken();
  const { userIds, memberIds } = await realmUsers(accessToken);
  const protectedIds = protectedUserIds(userIds, memberIds);
  const tenantUserId = memberIds[0];
  if (!tenantUserId || protectedIds.length === 0)
    return ['ต้องมีผู้ใช้ tenant และผู้ใช้ที่ถูกป้องกันอย่างน้อยอย่างละหนึ่งคน'];

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
    if (actual !== expected) failures.push(`${label}: ได้ ${actual} ต้องได้ ${expected}`);
  };
  expect('อ่านผู้ใช้ tenant', await status(`/users/${tenantUserId}`), 200);
  expect(
    'อ่าน credential ของผู้ใช้ tenant',
    await status(`/users/${tenantUserId}/credentials`),
    200,
  );
  // ทุกคนที่ถูกป้องกัน รวม service account ของระบบ — ไม่ทดสอบด้วยคำสั่งเขียนเพื่อไม่ให้ verify แก้บัญชีจริง
  for (const id of protectedIds) {
    expect(`อ่านผู้ใช้ที่ถูกป้องกัน ${id}`, await status(`/users/${id}`), 403);
    expect(
      `อ่าน credential ของผู้ใช้ที่ถูกป้องกัน ${id}`,
      await status(`/users/${id}/credentials`),
      403,
    );
  }
  expect('อ่าน client ของ realm', await status('/clients'), 403);
  // `view` อ่าน role mapping ได้ (แยก scope ไม่ได้) แต่ต้อง map role ไม่ได้ — ส่ง array ว่างจึงไม่เปลี่ยนอะไร
  const mapRoles = await request(`${realmPath}/users/${tenantUserId}/role-mappings/realm`, {
    method: 'POST',
    token: serviceToken,
    body: [],
    accept: [403],
  });
  expect('map realm role ให้ผู้ใช้ tenant', mapRoles.status, 403);

  // extension dc-account: body ไม่ถูกต้อง = 400 ก่อนแตะข้อมูลใด (จึงไม่แก้บัญชีจริง); token อื่น = 403
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
  expect('extension dc-account ด้วย account service', await call(serviceToken), 400);
  // token ของ admin (realm master) = token ของ realm อื่น → 401; token อื่นใน realm เดียวกัน → 403 (boundary test)
  const foreign = await call(accessToken);
  if (foreign !== 401 && foreign !== 403) {
    failures.push(`extension dc-account ด้วย token ของ admin: ได้ ${foreign} ต้องถูกปฏิเสธ`);
  }

  const { body: realmRepresentation } = await request(realmPath, { token: accessToken });
  const { body: executions } = await request(
    `${realmPath}/authentication/flows/${encodeURIComponent(TENANT_BROWSER_FLOW)}/executions`,
    { token: accessToken, accept: [404] },
  );
  failures.push(...browserFlowFailures(realmRepresentation, executions ?? []));
  return failures;
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? '')).href) {
  const verify = process.argv.includes('--verify');
  try {
    if (verify) {
      const failures = await verifyAccountService();
      if (failures.length > 0) throw new Error(failures.join('; '));
      console.log(JSON.stringify({ type: 'keycloak.account-service.verify', status: 'PASS' }));
    } else {
      const result = await setupAccountService();
      console.log(
        JSON.stringify({ type: 'keycloak.account-service.setup', status: 'PASS', ...result }),
      );
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
