import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * AC6 (#599): ซ่อนร่องรอยของ identity provider จากลูกค้า (#589) บน realm `dcontact` — idempotent ผ่าน Admin API
 * จึงใช้ได้ทั้ง realm ใหม่และ realm ที่ import/สร้างไปแล้ว (`--import-realm` ไม่ import ซ้ำ)
 *
 * - `displayName` = "D-Contact" (ชื่อ realm ปรากฏใน title/หัวข้อ/อีเมลที่ใช้ `${realmName}`)
 * - account theme `dcontact`: หน้า HTML ของ `/realms/dcontact/account/` พาไป D-Contact Console
 *   (extension `dc-account` — `DcAccountLanding`); Account REST API ไม่ถูกกระทบ
 * - `baseUrl` ของ client `account-console` และ `account` = URL ของ D-Contact Console
 *   - `account-console`: ปลายทางของ redirect ข้างบน
 *   - `account`: client เริ่มต้นของอีเมลเชิญ (`execute-actions-email` ไม่ส่ง client_id) — ลิงก์ "กลับแอป" หลังตั้งรหัสผ่าน
 *     เสร็จจึงไป D-Contact แทนหน้าของ identity provider; ไม่ปิด client นี้เพราะอีเมลเชิญต้องใช้
 * - attribute ภายใน (`tenant_id`, `tenant_slug`, `dc_user_id`, `zoneinfo`) ผู้ใช้ไม่เห็น/แก้ไม่ได้ — ไม่งั้นหน้า
 *   required action "แก้ไขข้อมูลบัญชี" แสดงเป็นช่องฟอร์ม (claim ใน token มาจาก mapper อ่าน attribute ตรง)
 *
 * URL ของ Console: `CONSOLE_PUBLIC_URL` (เดียวกับ API) → `https://${UAT_HOST}/` (UAT) — ไม่มีทั้งสอง = ข้ามขั้น
 * baseUrl พร้อมเตือน (ไม่ล้มเหลว เพราะ displayName/profile ยังต้องตั้ง)
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

/** URL สัมบูรณ์ http(s) ของ Console (มี `/` ท้ายเสมอ) หรือ `undefined` */
export function consoleUrl(env = process.env) {
  const raw =
    env.CONSOLE_PUBLIC_URL?.trim() || (env.UAT_HOST ? `https://${env.UAT_HOST.trim()}/` : '');
  if (!raw) return undefined;
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('CONSOLE_PUBLIC_URL ไม่ใช่ URL ที่ถูกต้อง');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('CONSOLE_PUBLIC_URL ต้องเป็น http(s)');
  }
  if (url.search || url.hash || url.username || url.password) {
    throw new Error('CONSOLE_PUBLIC_URL ต้องไม่มี query/fragment/credential');
  }
  return url.href.endsWith('/') ? url.href : `${url.href}/`;
}

/** user profile ที่ attribute ภายในไม่แสดงให้ผู้ใช้ — คืน object เดิมถ้าไม่มีอะไรต้องเปลี่ยน */
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
    throw new Error(`${method} ${path} ล้มเหลว (${response.status})`);
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
          'ไม่ได้ตั้ง baseUrl ของ client account/account-console: ไม่มี CONSOLE_PUBLIC_URL (หรือ UAT_HOST) — ' +
            '/realms/dcontact/account/ จะตอบ 404 และลิงก์กลับแอปหลังเชิญไม่ไป Console',
        );
      }
      console.log(JSON.stringify({ type: 'keycloak.branding', status: 'PASS', ...result }));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
}
