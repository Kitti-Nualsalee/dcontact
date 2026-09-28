import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

/**
 * #515: ตั้ง login theme `dcontact` ให้ realm ที่ import ไปแล้ว (`--import-realm` ไม่ import ซ้ำ)
 * #522: และ email theme `dcontact` (อีเมลเชิญ first admin)
 * idempotent — ค่าเดิมตรงแล้วไม่ PUT
 * theme ของ Platform Console (`dcontact-platform`) ตั้งเป็น client attribute ใน keycloak-platform-setup.mjs
 */
export const LOGIN_THEME = 'dcontact';
export const PLATFORM_LOGIN_THEME = 'dcontact-platform';
export const EMAIL_THEME = 'dcontact';

const keycloakBaseUrl = process.env.KEYCLOAK_ADMIN_URL ?? 'http://localhost:8081';
const realm = process.env.KEYCLOAK_REALM ?? 'dcontact';
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

export async function setupKeycloakTheme() {
  const { access_token: token } = await request('/realms/master/protocol/openid-connect/token', {
    method: 'POST',
    form: new URLSearchParams({
      grant_type: 'password',
      client_id: 'admin-cli',
      username: adminUsername,
      password: adminPassword,
    }),
  });
  const current = await request(`/admin/realms/${realm}`, { token });
  if (current.loginTheme === LOGIN_THEME && current.emailTheme === EMAIL_THEME) {
    return { changed: false };
  }
  // PUT บางส่วนได้ — field ที่ไม่ส่งไม่ถูกแตะ
  await request(`/admin/realms/${realm}`, {
    method: 'PUT',
    token,
    body: { loginTheme: LOGIN_THEME, emailTheme: EMAIL_THEME },
  });
  return { changed: true };
}

const invokedUrl = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (invokedUrl === import.meta.url) {
  try {
    const { changed } = await setupKeycloakTheme();
    process.stdout.write(
      `${JSON.stringify({ type: 'keycloak.theme.setup', status: 'PASS', loginTheme: LOGIN_THEME, emailTheme: EMAIL_THEME, changed })}\n`,
    );
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
