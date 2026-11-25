/**
 * R1 (#593) / AC6 (#599): checks that the cookies of the `dcontact` realm use the `DC_*` names and that login/SSO/monitorSession/logout still work
 * with a real browser (Chromium) against the dev stack - `pnpm test:keycloak-cookie-names`
 *
 * requires: the dev stack, `pnpm infra:keycloak:extensions` (provider `dc` in dcontact-account.jar), the dcontact theme that has
 * `login/resources/js/authChecker.js` with the cookie names fixed, and the `agent-desktop` client (redirect `http://localhost:5173/*`)
 *
 * `http://localhost:5173/` is a simulated HTTP listener inside the script (no need to run the Workspace) so it is an origin the client allows
 * - the OIDC redirect does not go through `page.route`, so a real listener is needed
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

/** A stand-in page for the Workspace: loads the session management iframe and returns the result through `window.__status` */
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
  // the organization makes it identity-first: username first, then password
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

// the stand-in page for the Workspace is a real server - `page.route` does not cover the navigation redirect (found while experimenting: the SSO redirect
// to this origin was refused a connection even though the IdP answered successfully)
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
  check('login succeeds and yields code + session_state', Boolean(code && sessionState));
  const afterLogin = await names(context);
  check(
    'cookies after login do not contain the word Keycloak / KC_',
    afterLogin.every((name) => !FORBIDDEN.test(name)),
    afterLogin.join(', '),
  );
  check(
    'DC_IDENTITY and DC_SESSION are present',
    afterLogin.includes('DC_IDENTITY') && afterLogin.includes('DC_SESSION'),
  );
  const tokens = await exchange(code, first.verifier);
  check(
    'the token can be exchanged (the new cookie names do not affect OIDC)',
    typeof tokens.id_token === 'string',
  );

  // 2) SSO: a new request in the same browser does not ask for the password again
  const second = pkce();
  const sso = await context.newPage();
  await sso.goto(authUrl(second.challenge));
  await sso.waitForURL(`${ORIGIN}/**`);
  check(
    'SSO: gets a code immediately without going through the form',
    Boolean(new URL(sso.url()).searchParams.get('code')),
  );
  const ssoState = new URL(sso.url()).searchParams.get('session_state');

  // 3) monitorSession: an iframe that reads DC_SESSION sees that the session has not changed
  const monitor = await context.newPage();
  await monitor.goto(`${ORIGIN}/`);
  const dcIframe = `${ISSUER}/dc-account/login-status-iframe.html`;
  const stockIframe = `${ISSUER}/protocol/openid-connect/login-status-iframe.html`;
  const unchanged = await monitor.evaluate(
    ([u, c, s]) => window.__check(u, c, s),
    [dcIframe, CLIENT, ssoState],
  );
  check(
    'monitorSession (the D-Contact iframe) = unchanged while logged in',
    unchanged === 'unchanged',
    unchanged,
  );
  const stock = await monitor.evaluate(
    ([u, c, s]) => window.__check(u, c, s),
    [stockIframe, CLIENT, ssoState],
  );
  check(
    'the original IdP iframe cannot find the old name -> reports changed (proves the D-Contact iframe is needed)',
    stock === 'changed',
    stock,
  );
  const wrong = await monitor.evaluate(
    ([u, c]) => window.__check(u, c, 'not-a-session'),
    [dcIframe, CLIENT],
  );
  check('a mismatched session_state = changed', wrong === 'changed', wrong);

  // 4) logout (RP-initiated) destroys the session and clears the cookies
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
    'logout: DC_IDENTITY/DC_SESSION are cleared and no cookie with the old name appears',
    !afterLogout.includes('DC_IDENTITY') &&
      !afterLogout.includes('DC_SESSION') &&
      afterLogout.every((name) => !FORBIDDEN.test(name)),
    afterLogout.join(', '),
  );
  const changed = await monitor.evaluate(
    ([u, c, s]) => window.__check(u, c, s),
    [dcIframe, CLIENT, ssoState],
  );
  check('after logout: monitorSession = changed', changed === 'changed', changed);
  const again = await context.newPage();
  await again.goto(authUrl(pkce().challenge));
  check(
    'after logout: must log in again (the form is shown)',
    (await again.locator('#username').count()) === 1,
  );

  // 5) login page: authChecker.js with the cookie names fixed raises no error and can still check the session
  check(
    'the login page has no JavaScript error',
    consoleErrors.filter((message) => !/Failed to load resource/.test(message)).length === 0,
    consoleErrors.join(' | '),
  );
  await context.close();

  // 5.5) rollout: a user who logged in before the provider was enabled holds a cookie with the old name - SSO must continue, then they are moved to the new name
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
    'rollout: a cookie with the old name (KEYCLOAK_*) can still SSO without asking for the password',
    migrated,
    before.join(', '),
  );
  // the old name expires as soon as it is used - it does not linger in the browser, while the new name is issued when the session is used/renewed
  check(
    'rollout: the old name is gone after the first use',
    !migratedNames.some((name) => name === 'KEYCLOAK_IDENTITY' || name === 'KEYCLOAK_SESSION'),
    migratedNames.join(', '),
  );
  await legacy.close();

  // 6) the master realm (admin console) still uses the old name - untouched
  const master = await browser.newContext();
  const masterPage = await master.newPage();
  await masterPage.goto(`${KEYCLOAK}/admin/master/console/`);
  await masterPage
    .waitForSelector('#username, input[name=username]', { timeout: 15000 })
    .catch(() => undefined);
  const masterNames = await names(master);
  check(
    'the master realm still uses the old cookie name (the admin console is not affected)',
    masterNames.includes('AUTH_SESSION_ID') && !masterNames.some((name) => name.startsWith('DC_')),
    masterNames.join(', '),
  );
  await master.close();

  // 7) backchannel logout: Keycloak sends a logout token to the client when the session is destroyed
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
      'backchannel logout: received the logout_token of the destroyed session',
      Boolean(claims.events && claims.sid && bcTokens.session_state),
      received.length === 0
        ? 'not received (the container cannot reach the host?)'
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
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exitCode = failed.length === 0 ? 0 : 1;
