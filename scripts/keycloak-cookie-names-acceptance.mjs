/**
 * R1 (#593) / AC6 (#599): ตรวจว่า cookie ของ realm `dcontact` ใช้ชื่อ `DC_*` และ login/SSO/monitorSession/logout ยังทำงาน
 * ด้วยเบราว์เซอร์จริง (Chromium) กับ dev stack — `pnpm test:keycloak-cookie-names`
 *
 * ต้องมี: dev stack, `pnpm infra:keycloak:extensions` (provider `dc` ใน dcontact-account.jar), theme dcontact ที่มี
 * `login/resources/js/authChecker.js` ที่แก้ชื่อ cookie และ client `agent-desktop` (redirect `http://localhost:5173/*`)
 *
 * `http://localhost:5173/` เป็น HTTP listener จำลองในสคริปต์ (ไม่ต้องรัน Workspace) เพื่อให้เป็น origin ที่ client อนุญาต
 * — redirect ของ OIDC ไม่ผ่าน `page.route` จึงต้องมี listener จริง
 */
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/console/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const ISSUER = `${KEYCLOAK}/realms/dcontact`;
const ORIGIN = 'http://localhost:5173';
const CLIENT = 'agent-desktop';
const USER = { username: 'agent1000@demo.local', password: 'agent1234' };
const FORBIDDEN = /keycloak|^KC_/i;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const b64u = (buffer) => Buffer.from(buffer).toString('base64url');
function pkce() {
  const verifier = b64u(randomBytes(32));
  return { verifier, challenge: b64u(createHash('sha256').update(verifier).digest()) };
}
function authUrl(challenge, extra = {}) {
  const url = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  for (const [key, value] of Object.entries({
    client_id: CLIENT,
    redirect_uri: `${ORIGIN}/`,
    response_type: 'code',
    scope: 'openid organization:demo',
    state: b64u(randomBytes(6)),
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...extra,
  }))
    url.searchParams.set(key, value);
  return url.href;
}

/** หน้าแทน Workspace: โหลด iframe ของ session management แล้วส่งผลผ่าน `window.__status` */
const HARNESS = `<!doctype html><meta charset="utf-8"><body><script>
window.__status = [];
window.addEventListener('message', (event) => window.__status.push(event.data));
window.__check = (iframeUrl, clientId, sessionState) =>
  new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.src = iframeUrl;
    frame.onload = () => {
      const handler = (event) => { window.removeEventListener('message', handler); resolve(event.data); };
      window.addEventListener('message', handler);
      frame.contentWindow.postMessage(clientId + ' ' + sessionState, new URL(iframeUrl).origin);
    };
    document.body.appendChild(frame);
  });
</script></body>`;

async function login(page, challenge) {
  await page.goto(authUrl(challenge));
  // organization ทำให้ใช้ identity-first: username ก่อน แล้วค่อย password
  await page.locator('#username').fill(USER.username);
  await page.locator('#kc-login').click();
  await page.locator('#password').fill(USER.password);
  await page.locator('#kc-login').click();
  await page.waitForURL(`${ORIGIN}/**`);
  return new URL(page.url());
}

const names = async (context) => (await context.cookies()).map((cookie) => cookie.name).sort();

async function exchange(code, verifier) {
  const response = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: CLIENT,
      code,
      redirect_uri: `${ORIGIN}/`,
      code_verifier: verifier,
    }),
  });
  assert.equal(response.status, 200, 'token exchange');
  return response.json();
}

// หน้าแทน Workspace เป็น server จริง — `page.route` ไม่ครอบ redirect ของ navigation (พบตอนทดลอง: SSO redirect
// ไป origin นี้แล้วถูกปฏิเสธการเชื่อมต่อ ทั้งที่ IdP ตอบสำเร็จ)
const harness = createServer((_, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HARNESS);
});
await new Promise((resolve, reject) => {
  harness.once('error', reject);
  harness.listen(Number(new URL(ORIGIN).port), resolve);
});

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  const context = await browser.newContext({ locale: 'th-TH' });
  const consoleErrors = [];
  const page = await context.newPage();
  page.on('pageerror', (error) => consoleErrors.push(error.message));
  page.on('console', (message) => message.type() === 'error' && consoleErrors.push(message.text()));

  // 1) login
  const first = pkce();
  const callback = await login(page, first.challenge);
  const code = callback.searchParams.get('code');
  const sessionState = callback.searchParams.get('session_state');
  check('login สำเร็จ ได้ code + session_state', Boolean(code && sessionState));
  const afterLogin = await names(context);
  check(
    'cookie หลัง login ไม่มีคำว่า Keycloak / KC_',
    afterLogin.every((name) => !FORBIDDEN.test(name)),
    afterLogin.join(', '),
  );
  check(
    'มี DC_IDENTITY และ DC_SESSION',
    afterLogin.includes('DC_IDENTITY') && afterLogin.includes('DC_SESSION'),
  );
  const tokens = await exchange(code, first.verifier);
  check('แลก token ได้ (cookie ชื่อใหม่ไม่กระทบ OIDC)', typeof tokens.id_token === 'string');

  // 2) SSO: คำขอใหม่ในเบราว์เซอร์เดิม ไม่ถามรหัสผ่านอีก
  const second = pkce();
  const sso = await context.newPage();
  await sso.goto(authUrl(second.challenge));
  await sso.waitForURL(`${ORIGIN}/**`);
  check('SSO: ได้ code ทันทีโดยไม่ผ่านฟอร์ม', Boolean(new URL(sso.url()).searchParams.get('code')));
  const ssoState = new URL(sso.url()).searchParams.get('session_state');

  // 3) monitorSession: iframe ที่อ่าน DC_SESSION เห็นว่า session ไม่เปลี่ยน
  const monitor = await context.newPage();
  await monitor.goto(`${ORIGIN}/`);
  const dcIframe = `${ISSUER}/dc-account/login-status-iframe.html`;
  const stockIframe = `${ISSUER}/protocol/openid-connect/login-status-iframe.html`;
  const unchanged = await monitor.evaluate(
    ([u, c, s]) => window.__check(u, c, s),
    [dcIframe, CLIENT, ssoState],
  );
  check(
    'monitorSession (iframe ของ D-Contact) = unchanged ขณะ login อยู่',
    unchanged === 'unchanged',
    unchanged,
  );
  const stock = await monitor.evaluate(
    ([u, c, s]) => window.__check(u, c, s),
    [stockIframe, CLIENT, ssoState],
  );
  check(
    'iframe ต้นฉบับของ IdP อ่านชื่อเดิมไม่เจอ → รายงาน changed (พิสูจน์ว่าต้องใช้ iframe ของ D-Contact)',
    stock === 'changed',
    stock,
  );
  const wrong = await monitor.evaluate(
    ([u, c]) => window.__check(u, c, 'not-a-session'),
    [dcIframe, CLIENT],
  );
  check('session_state ที่ไม่ตรง = changed', wrong === 'changed', wrong);

  // 4) logout (RP-initiated) ทำลาย session และล้าง cookie
  const logout = await context.newPage();
  await logout.goto(
    `${ISSUER}/protocol/openid-connect/logout?${new URLSearchParams({
      id_token_hint: tokens.id_token,
      post_logout_redirect_uri: `${ORIGIN}/`,
      client_id: CLIENT,
    })}`,
  );
  await logout.waitForURL(`${ORIGIN}/**`);
  const afterLogout = await names(context);
  check(
    'logout: DC_IDENTITY/DC_SESSION ถูกล้าง และไม่มี cookie ชื่อเดิมโผล่',
    !afterLogout.includes('DC_IDENTITY') &&
      !afterLogout.includes('DC_SESSION') &&
      afterLogout.every((name) => !FORBIDDEN.test(name)),
    afterLogout.join(', '),
  );
  const changed = await monitor.evaluate(
    ([u, c, s]) => window.__check(u, c, s),
    [dcIframe, CLIENT, ssoState],
  );
  check('หลัง logout: monitorSession = changed', changed === 'changed', changed);
  const again = await context.newPage();
  await again.goto(authUrl(pkce().challenge));
  check(
    'หลัง logout: ต้อง login ใหม่ (เห็นฟอร์ม)',
    (await again.locator('#username').count()) === 1,
  );

  // 5) login page: authChecker.js ที่แก้ชื่อ cookie ไม่ error และยังตรวจ session ได้
  check(
    'หน้า login ไม่มี JavaScript error',
    consoleErrors.filter((message) => !/Failed to load resource/.test(message)).length === 0,
    consoleErrors.join(' | '),
  );
  await context.close();

  // 5.5) rollout: ผู้ใช้ที่ login ไว้ก่อนเปิด provider ถือ cookie ชื่อเดิม — ต้อง SSO ต่อได้ แล้วถูกย้ายเป็นชื่อใหม่
  const legacy = await browser.newContext();
  const legacyPage = await legacy.newPage();
  const legacyLogin = pkce();
  await login(legacyPage, legacyLogin.challenge);
  const fresh = await legacy.cookies();
  const legacyNames = { DC_IDENTITY: 'KEYCLOAK_IDENTITY', DC_SESSION: 'KEYCLOAK_SESSION' };
  await legacy.clearCookies();
  await legacy.addCookies(
    fresh
      .filter((cookie) => legacyNames[cookie.name])
      .map((cookie) => ({ ...cookie, name: legacyNames[cookie.name] })),
  );
  const before = await names(legacy);
  const migrate = await legacy.newPage();
  await migrate.goto(authUrl(pkce().challenge));
  await migrate.waitForURL(`${ORIGIN}/**`);
  const migrated = Boolean(new URL(migrate.url()).searchParams.get('code'));
  const migratedNames = await names(legacy);
  check(
    'rollout: cookie ชื่อเดิม (KEYCLOAK_*) ยัง SSO ได้โดยไม่ถามรหัสผ่าน',
    migrated,
    before.join(', '),
  );
  // ชื่อเดิมถูกหมดอายุทันทีที่ใช้ — ไม่ค้างในเบราว์เซอร์ ส่วนชื่อใหม่ถูกออกตอน session ถูกใช้/ต่ออายุ
  check(
    'rollout: ชื่อเดิมหายไปหลังใช้ครั้งแรก',
    !migratedNames.some((name) => name === 'KEYCLOAK_IDENTITY' || name === 'KEYCLOAK_SESSION'),
    migratedNames.join(', '),
  );
  await legacy.close();

  // 6) realm master (admin console) ยังใช้ชื่อเดิม — ไม่แตะ
  const master = await browser.newContext();
  const masterPage = await master.newPage();
  await masterPage.goto(`${KEYCLOAK}/admin/master/console/`);
  await masterPage
    .waitForSelector('#username, input[name=username]', { timeout: 15000 })
    .catch(() => undefined);
  const masterNames = await names(master);
  check(
    'realm master ยังใช้ชื่อ cookie เดิม (ไม่กระทบ admin console)',
    masterNames.includes('AUTH_SESSION_ID') && !masterNames.some((name) => name.startsWith('DC_')),
    masterNames.join(', '),
  );
  await master.close();

  // 7) backchannel logout: Keycloak ส่ง logout token ไปที่ client เมื่อ session ถูกทำลาย
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => (body += chunk));
    request.on('end', () => {
      received.push(body);
      response.writeHead(200).end();
    });
  });
  await new Promise((resolve) => server.listen(0, '0.0.0.0', resolve));
  const port = server.address().port;
  const adminToken = (
    await (
      await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'password',
          client_id: 'admin-cli',
          username: 'admin',
          password: 'admin',
        }),
      })
    ).json()
  ).access_token;
  const admin = (path, init = {}) =>
    fetch(`${KEYCLOAK}/admin/realms/dcontact${path}`, {
      ...init,
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json' },
    });
  const [clientRep] = await (await admin(`/clients?clientId=${CLIENT}`)).json();
  const originalAttributes = clientRep.attributes ?? {};
  const host = process.env.BACKCHANNEL_HOST ?? '172.18.0.1';
  await admin(`/clients/${clientRep.id}`, {
    method: 'PUT',
    body: JSON.stringify({
      ...clientRep,
      attributes: {
        ...originalAttributes,
        'backchannel.logout.url': `http://${host}:${port}/logout`,
        'backchannel.logout.session.required': 'true',
      },
    }),
  });
  try {
    const bcContext = await browser.newContext();
    const bcPage = await bcContext.newPage();
    const bc = pkce();
    const bcCallback = await login(bcPage, bc.challenge);
    const bcTokens = await exchange(bcCallback.searchParams.get('code'), bc.verifier);
    const sessions = await (
      await admin(`/users?username=${encodeURIComponent(USER.username)}&exact=true`)
    ).json();
    await admin(`/users/${sessions[0].id}/logout`, { method: 'POST' });
    for (let attempt = 0; attempt < 20 && received.length === 0; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    const token = new URLSearchParams(received[0] ?? '').get('logout_token');
    const claims = token
      ? JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      : {};
    check(
      'backchannel logout: ได้ logout_token ของ session ที่ถูกทำลาย',
      Boolean(claims.events && claims.sid && bcTokens.session_state),
      received.length === 0
        ? 'ไม่ได้รับ (container เข้าถึง host ไม่ได้?)'
        : `sid=${claims.sid?.slice(0, 8)}…`,
    );
    await bcContext.close();
  } finally {
    await admin(`/clients/${clientRep.id}`, {
      method: 'PUT',
      body: JSON.stringify({ ...clientRep, attributes: originalAttributes }),
    });
    server.close();
  }
} finally {
  await browser.close();
  harness.close();
}

const failed = results.filter((result) => !result.ok);
console.log(`\n${results.length - failed.length}/${results.length} ผ่าน`);
process.exitCode = failed.length === 0 ? 0 : 1;
