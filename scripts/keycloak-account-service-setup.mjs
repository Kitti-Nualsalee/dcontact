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
 * `--verify` ตรวจด้วย token ของ service account จริง: แก้ผู้ใช้ tenant ได้, แตะผู้ใช้ที่ถูกป้องกันไม่ได้,
 * และอ่าน client ของ realm ไม่ได้
 */
export const ACCOUNT_SERVICE_CLIENT = 'dcontact-account-service';
export const ALLOW_POLICY = 'dc-account-service';
export const DENY_POLICY = 'dc-account-service-deny';
export const USERS_PERMISSION = 'dc-account-service-users';
export const PROTECTED_PERMISSION = 'dc-account-service-protected-users';
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
