import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * D1.11 (#450): ภาษาและ timezone ของผู้ใช้บน realm `dcontact` — idempotent ผ่าน Admin API
 * จึงใช้ได้ทั้ง realm ใหม่และ realm ที่ import ไปแล้ว (`--import-realm` ไม่ import ซ้ำ)
 *
 * - เปิด internationalization: `th` (ค่าเริ่มต้น) และ `en` — Keycloak จึงเก็บ attribute `locale`
 *   ของผู้ใช้, ใส่ claim `locale` ใน token (scope `profile`) และแสดงหน้า login/อีเมลตามภาษาผู้ใช้
 * - ประกาศ attribute `zoneinfo` ใน user profile (Keycloak 24+ ทิ้ง attribute ที่ไม่ได้ประกาศ)
 *   ให้ mapper `zoneinfo` ของ scope `profile` ส่ง timezone ของผู้ใช้ (IANA) ออกมาใน token
 *   ผู้ใช้เห็นได้ แต่แก้ได้เฉพาะ admin — ยังไม่มีหน้าตั้ง timezone ของผู้ใช้ใน D1
 *
 * ผู้ใช้เปลี่ยนภาษาของตัวเองผ่าน Account REST API ด้วย token ของตัวเอง (`@d-contact/i18n`)
 * ไม่ต้องให้ API ของ D-Contact ถือสิทธิ์ admin ของ realm — ต้องมี `account/manage-account` ซึ่งมากับ
 * `default-roles-dcontact` ผู้ใช้ที่สร้างผ่าน Admin API (provisioning) ได้ role นี้อัตโนมัติ แต่ผู้ใช้ dev
 * ที่ import จาก realm JSON พร้อม `realmRoles` ระบุเองไม่ได้ สคริปต์จึงเติมให้ (ปิดด้วย `--no-dev-users`)
 * attribute ของ tenant (`tenant_id`, `tenant_slug`, `dc_user_id`) ยังเป็น read-only สำหรับผู้ใช้
 */
export const LOCALE_REALM = 'dcontact';
export const REALM_LOCALES = Object.freeze(['th', 'en']);
export const REALM_DEFAULT_LOCALE = 'th';
export const REALM_DEFAULT_ROLE = 'default-roles-dcontact';
/** ตรงกับ `users` ใน infra/keycloak/realm-dcontact.dev.json */
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
    throw new Error(`${method} ${path} ล้มเหลว (${response.status}): ${await response.text()}`);
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
  permissions: { view: ['admin', 'user'], edit: ['admin'] },
  multivalued: false,
});

/** คืน user profile config ที่มี `zoneinfo` — ไม่แตะ attribute อื่นที่มีอยู่ */
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
