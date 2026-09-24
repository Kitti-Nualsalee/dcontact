import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * A1.4 (#409): Keycloak ฝั่ง provisioning ของ realm `dcontact` — idempotent ผ่าน Admin API
 *
 * - `dcontact-provisioner`: confidential client + service account ที่ saga worker ใช้สร้าง Organization,
 *   first-admin และส่ง execute-actions invitation; ไม่มี browser/direct grant
 *   Keycloak 26.0 ต้องใช้ `manage-realm` สำหรับ Organization API (ยังไม่มี fine-grained admin
 *   permission) จึงต้องเก็บ secret ไว้เฉพาะ worker
 * - user profile: correlation attributes แก้ได้เฉพาะ admin (ผู้ใช้แก้ผ่าน account console ไม่ได้)
 * - SMTP ของ dev ชี้ mailpit (ไม่มีการส่งออกภายนอก) — production ตั้ง SMTP ผ่าน secret ของ env
 */
export const PROVISIONER_CLIENT = 'dcontact-provisioner';
export const PROVISIONER_REALM_MANAGEMENT_ROLES = Object.freeze([
  'manage-users',
  'view-users',
  'query-users',
  'view-realm',
  // Organization admin API ของ Keycloak 26.0 (ดู PR ของ #409)
  'manage-realm',
]);
export const PROTECTED_USER_ATTRIBUTES = Object.freeze([
  'tenant_id',
  'tenant_slug',
  'dc_user_id',
  'dc_provisioning_request_id',
  // A1.4b (#436): control plane ตั้งตอน resend — ลิงก์ที่ออกก่อนเวลานี้ใช้ไม่ได้
  'dc_invitation_not_before',
]);
export const INVITATION_GUARD_FACTORY = 'io.dcontact.keycloak.InvitationGuardActionTokenHandler';

const realm = 'dcontact';
const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const adminUsername = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.KEYCLOAK_BOOTSTRAP_ADMIN_PASSWORD ?? 'admin';
export const provisionerSecret =
  process.env.KEYCLOAK_PROVISIONER_SECRET ?? 'dcontact-provisioner-dev-secret';
const smtp = {
  host: process.env.KEYCLOAK_SMTP_HOST ?? 'mailpit',
  port: process.env.KEYCLOAK_SMTP_PORT ?? '1025',
  from: process.env.KEYCLOAK_SMTP_FROM ?? 'no-reply@dcontact.local',
};

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
    throw new Error(`${method} ${path.split('?')[0]} ล้มเหลว (${response.status})`);
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
    throw new Error('realm-management ไม่มี role ที่ provisioner ต้องใช้ครบ');
  }
  await request(
    `${realmPath}/users/${serviceAccount.id}/role-mappings/clients/${realmManagement.id}`,
    { method: 'POST', token, body: wanted },
  );
  // ถอด role ที่เกินรายการ (เช่นจากการตั้งค่าด้วยมือ) ให้สิทธิ์ตรง contract เสมอ
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
  // เพิ่มเฉพาะที่ยังไม่มี — tenant attributes ที่ link script ตั้งไว้แล้วคงสิทธิ์เดิม
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
            view: name.startsWith('dc_') && name !== 'dc_user_id' ? ['admin'] : ['admin', 'user'],
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
      smtpServer: {
        host: smtp.host,
        port: smtp.port,
        from: smtp.from,
        fromDisplayName: 'D-Contact',
        auth: 'false',
        ssl: 'false',
        starttls: 'false',
      },
    },
  });
}

/**
 * fail closed: invitation guard (#436) ต้องถูกโหลดจริง ไม่อย่างนั้นลิงก์รุ่นเก่ายังใช้ได้
 * Keycloak ไม่เปิดชื่อ class ของ provider ใน serverinfo จึงตรวจว่ามี provider `execute-actions`
 * ที่ order สูงกว่าค่าเริ่มต้น (มีเฉพาะเมื่อ jar ของเราถูกโหลด)
 */
async function verifyInvitationGuard(token) {
  const info = await request('/admin/serverinfo', { token });
  const handlers = info.providers?.actionTokenHandler?.providers ?? {};
  const executeActions = handlers['execute-actions'];
  if (!executeActions || !(executeActions.order > 0)) {
    throw new Error(
      'Keycloak ไม่ได้โหลด invitation guard (#436) — รัน pnpm infra:keycloak:extensions แล้ว restart keycloak',
    );
  }
  return executeActions.order;
}

export async function setupKeycloakProvisioning() {
  const token = await adminToken();
  await verifyInvitationGuard(token);
  await ensureProvisionerClient(token);
  await ensureUserProfile(token);
  await ensureSmtp(token);
  return { client: PROVISIONER_CLIENT, roles: [...PROVISIONER_REALM_MANAGEMENT_ROLES] };
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
