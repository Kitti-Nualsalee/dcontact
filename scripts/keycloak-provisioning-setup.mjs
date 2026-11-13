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
 * - SMTP ของ dev ชี้ mailpit (ไม่มีการส่งออกภายนอก) — UAT ส่ง `SMTP_*` ชุดเดียวกับ API ของ D-Contact มาเป็น
 *   `KEYCLOAK_SMTP_*` (AC3 #596); ชื่อผู้ส่ง "D-Contact" เสมอ และ Keycloak ตั้ง HELO เองไม่ได้
 */
export const PROVISIONER_CLIENT = 'dcontact-provisioner';
export const PROVISIONER_REALM_MANAGEMENT_ROLES = Object.freeze([
  'manage-users',
  'view-users',
  'query-users',
  'view-realm',
  // Organization admin API ของ Keycloak 26.0 (ดู PR ของ #409)
  'manage-realm',
  // #592 (Keycloak 26.7): เมื่อเปิด fine-grained admin permissions v2 การ list/ค้น Organization ข้ามการกรอง
  // เฉพาะผู้ที่มี `view-organizations`/`manage-organizations` — `manage-realm` อย่างเดียวได้รายการว่าง
  'manage-organizations',
  // A1.8 (#413): อ่าน user events ของ first admin เพื่อลง Action history
  'view-events',
  // #907: ค้น tenant Console client ตาม clientId — เมื่อเปิด fine-grained permission v2 ผลค้นถูกกรอง
  // เหลือเฉพาะ client ที่ provisioner มี `view` (ไม่เห็น client อื่น); การแก้ใช้ permission ราย client
  'query-clients',
]);
/** ต้องตรงกับ `FIRST_ADMIN_KEYCLOAK_EVENT_TYPES` ใน platform-control (boundary test ตรวจ) */
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
/**
 * `KEYCLOAK_SMTP_*` (มุมมองจาก network ของ container Keycloak — dev ชี้ `mailpit` ไม่ใช่ localhost)
 * FROM รับได้ทั้ง `"ชื่อ" <ที่อยู่>` และที่อยู่อย่างเดียว — ชื่อที่แสดงเป็น "D-Contact" เสมอ (#589 Q2)
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
    // ไม่ใช่ TLS ตั้งแต่ต้น = STARTTLS เมื่อ server รองรับ (JavaMail starttls.enable ไม่บังคับ) แบบเดียวกับ API
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
            // AC6 (#599): attribute ภายในไม่แสดงให้ผู้ใช้เห็นในหน้าของ identity provider
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
 * A1.8: realm ต้องเก็บ user events ที่ worker ใช้สร้าง timeline ของ first admin
 * รวมกับค่าที่ทีมอื่นตั้งไว้ (ไม่ถอด listener/type เดิม และไม่ลดอายุ event ที่ยาวกว่า)
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
      // รายการว่าง = Keycloak เก็บทุกชนิดอยู่แล้ว
      enabledEventTypes:
        types.length === 0 ? [] : [...new Set([...types, ...FIRST_ADMIN_EVENT_TYPES])],
      eventsExpiration: Math.max(current.eventsExpiration ?? 0, EVENTS_EXPIRATION_SECONDS),
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
 * #907: provisioner ได้ `view`/`manage` ผ่าน fine-grained admin permission v2 เฉพาะ tenant Console client
 * เพื่อเพิ่ม redirect ราย tenant — ไม่ได้ realm-management `manage-clients` ทั้ง realm
 * ตั้งเฉพาะเมื่อกำหนด client (UAT: `PLATFORM_TENANT_CONSOLE_CLIENT_ID`); permission เดิมถูกแทนที่ให้ชี้ client นี้ตัวเดียว
 */
export async function ensureTenantConsolePermission(consoleClientId, token) {
  if (!/^[A-Za-z0-9._-]{1,255}$/.test(consoleClientId ?? '')) {
    throw new Error('tenant Console client ไม่ถูกต้อง');
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
    throw new Error(`ไม่พบ tenant Console client แบบ public: ${consoleClientId}`);
  }
  const [provisioner] = await request(`${realmPath}/clients?clientId=${PROVISIONER_CLIENT}`, {
    token: accessToken,
  });
  const [adminPermissions] = await request(`${realmPath}/clients?clientId=admin-permissions`, {
    token: accessToken,
  });
  if (!provisioner || !adminPermissions) {
    throw new Error('ไม่พบ dcontact-provisioner หรือ admin-permissions — Keycloak ต้อง ≥ 26.2');
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
      description: '#907: เพิ่ม redirect ราย tenant ให้ tenant Console client เท่านั้น',
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
