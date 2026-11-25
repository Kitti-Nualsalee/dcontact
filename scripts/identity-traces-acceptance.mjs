/**
 * AC6 (#599) acceptance: every page and email a D-Contact user sees must not contain the word Keycloak
 *
 * `node scripts/identity-traces-acceptance.mjs` - needs the dev stack (Keycloak + mailpit) and the latest extension/theme
 * (`pnpm infra:keycloak:extensions`, `pnpm infra:identity:theme`, `pnpm infra:identity:branding`)
 *
 * opens with a real Chromium and checks (gate) `/keycloak/i` in: `<title>`, the visible text (`innerText`) and the attribute values the user
 * can read (alt, aria-label, title, placeholder, value); every email: sender name, subject, HTML and text; and every cookie name
 * resource URLs that contain this word (e.g. `/common/keycloak/...` of an asset the IdP serves) are reported as information, not a gate
 * (the same decision as the `/auth/realms/...` path in #589 D9)
 *
 * pages covered: login (username/password/OTP), error, logout-confirm, page-expired, reset-password (+info + email),
 * required actions (update-password, update-profile, verify-email + email, configure-totp) and the invitation email flow (execute-actions)
 * all the way to the page where the user ends up; the Account Console must be unreachable
 */
import { createHmac, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(new URL('../apps/console/package.json', import.meta.url));
const { chromium } = require('@playwright/test');

const KEYCLOAK = process.env.KEYCLOAK_URL ?? 'http://localhost:8081';
const MAILPIT = process.env.MAILPIT_API_URL ?? 'http://localhost:8025';
const REALM = 'dcontact';
const ISSUER = `${KEYCLOAK}/realms/${REALM}`;
const ADMIN = `${KEYCLOAK}/admin/realms/${REALM}`;
const ORIGIN = 'http://localhost:5173';
const CLIENT = 'agent-desktop';
const PASSWORD = `Ac6-${randomBytes(6).toString('hex')}`;
const TRACE = /keycloak/i;
const LOCALES = (process.env.TRACE_LOCALES ?? 'th,en').split(',');

const findings = [];
const infos = [];
const visited = [];
const infoSet = new Set();
const untranslated = new Set();

const strip = (html) =>
  html
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/g, ' ');

function gate(where, kind, text) {
  const match = TRACE.exec(text ?? '');
  if (!match) return;
  const from = Math.max(0, match.index - 40);
  findings.push({ where, kind, excerpt: text.slice(from, match.index + 50).replace(/\s+/g, ' ') });
}

// ── Keycloak / mailpit ──
let adminToken = '';
async function admin(method, path, body) {
  const response = await fetch(`${ADMIN}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${method} ${path} → ${response.status}`);
  const text = await response.text();
  return { body: text ? JSON.parse(text) : undefined, headers: response.headers };
}

const createdUsers = [];
// the language being scanned - the temporary user holds this locale attribute, so the emails Keycloak sends follow the language of that round
let scanLocale = 'th';

async function createUser(label, { requiredActions = [], otp = false, emailVerified = true } = {}) {
  const org = (await admin('GET', '/organizations?first=0&max=100')).body.find(
    (o) => o.alias === 'demo',
  );
  const tenant = (await admin('GET', `/organizations/${org.id}`)).body.attributes.tenant_id[0];
  const username = `ac6-${label}-${randomBytes(3).toString('hex')}@demo.local`;
  const credentials = [{ type: 'password', value: PASSWORD, temporary: false }];
  if (otp) {
    credentials.push({
      type: 'otp',
      userLabel: 'scan',
      secretData: JSON.stringify({ value: 'dcontact-ac6-scan-totp-secret' }),
      credentialData: JSON.stringify({
        subType: 'totp',
        digits: 6,
        counter: 0,
        period: 30,
        algorithm: 'HmacSHA1',
      }),
    });
  }
  const { headers } = await admin('POST', '/users', {
    username,
    email: username,
    emailVerified,
    enabled: true,
    firstName: 'AC6',
    lastName: label,
    attributes: { tenant_id: [tenant], locale: [scanLocale] },
    requiredActions,
    credentials,
  });
  const id = headers.get('location').split('/').pop();
  await admin('POST', `/organizations/${org.id}/members`, id);
  createdUsers.push(id);
  return { id, username, tenant };
}

const ACCOUNT_SERVICE_SECRET =
  process.env.KEYCLOAK_ACCOUNT_SERVICE_SECRET ?? 'dcontact-account-service-dev-secret';

/** TOTP (RFC 6238, SHA1, 6 digits, 30 seconds) - key = the bytes of the secret as Keycloak uses them for a credential stored as characters */
function totp(secret, at = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const mac = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const offset = mac[mac.length - 1] & 0xf;
  const value = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(value % 1_000_000).padStart(6, '0');
}

async function enrolTotpViaExtension(user, secret) {
  const tokenResponse = await fetch(`${ISSUER}/protocol/openid-connect/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: 'dcontact-account-service',
      client_secret: ACCOUNT_SERVICE_SECRET,
    }),
  });
  const { access_token: serviceToken } = await tokenResponse.json();
  return fetch(`${ISSUER}/dc-account/users/${user.id}/totp/verify-and-create`, {
    method: 'POST',
    headers: { authorization: `Bearer ${serviceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      tenantId: user.tenant,
      secret,
      code: totp(secret),
      label: 'ac6-enrol',
    }),
  });
}

async function mailTo(address, { wait = true } = {}) {
  for (let attempt = 0; attempt < (wait ? 20 : 1); attempt += 1) {
    const response = await fetch(
      `${MAILPIT}/api/v1/search?${new URLSearchParams({ query: `to:"${address}"` })}`,
    );
    const { messages } = await response.json();
    if (messages.length > 0 || !wait) {
      return Promise.all(
        messages.map(async (message) =>
          (await fetch(`${MAILPIT}/api/v1/message/${message.ID}`)).json(),
        ),
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return [];
}

function scanEmail(where, message) {
  gate(where, 'email:from', `${message.From?.Name ?? ''} <${message.From?.Address ?? ''}>`);
  gate(where, 'email:subject', message.Subject);
  gate(where, 'email:html', strip(message.HTML ?? ''));
  gate(where, 'email:text', message.Text ?? '');
  gate(
    where,
    'email:html-title',
    /<title>([\s\S]*?)<\/title>/i.exec(message.HTML ?? '')?.[1] ?? '',
  );
  visited.push(`${where} (email: ${message.Subject})`);
}

// ── browser ──
async function scanPage(where, page, { control = false } = {}) {
  await page.waitForLoadState('domcontentloaded');
  const snapshot = await page.evaluate(() => ({
    title: document.title,
    text: document.body.innerText,
    attrs: [
      ...document.querySelectorAll('[alt],[aria-label],[title],[placeholder],input[value]'),
    ].flatMap((el) =>
      ['alt', 'aria-label', 'title', 'placeholder', 'value']
        .map((name) => el.getAttribute(name) ?? '')
        .filter(Boolean),
    ),
    resources: performance.getEntriesByType('resource').map((entry) => entry.name),
    lang: document.documentElement.lang,
    links: [...document.querySelectorAll('a[href]')].map((a) => ({
      href: a.href,
      text: a.innerText.replace(/\s+/g, ' ').trim(),
    })),
    lines: document.body.innerText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean),
    // the heading of the real content (the brand panel on the left is the same on every page) - used to confirm the intended page was reached
    heading: (
      document.querySelector('#kc-content h1, #kc-page-title, main h1, h1')?.innerText ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim(),
    notice: (
      document.querySelector(
        '.dc-alert, .alert, #kc-error-message, .kc-feedback-text, [role=alert]',
      )?.innerText ?? ''
    )
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 90),
  }));
  gate(where, 'title', snapshot.title);
  gate(where, 'text', snapshot.text);
  for (const value of snapshot.attrs) gate(where, 'attribute', value);
  for (const url of snapshot.resources.filter((name) => TRACE.test(name)))
    infoSet.add(new URL(url).pathname);
  // TRACE_SHOTS=<dir> keeps screenshots of every scanned page (for visual inspection - the gate checks only text)
  if (process.env.TRACE_SHOTS && !control) {
    const slug = where
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
    await page.screenshot({ path: `${process.env.TRACE_SHOTS}/${slug}.png`, fullPage: true });
  }
  // TRACE_DUMP=<page name regex> prints the full text and links of that page (for use while fixing)
  if (process.env.TRACE_DUMP && new RegExp(process.env.TRACE_DUMP).test(where)) {
    console.log(
      `\n--- ${where}\n${snapshot.lines.join(' | ')}\nlinks: ${snapshot.links.map((l) => `${l.text}→${new URL(l.href).pathname}`).join(' ; ')}\n`,
    );
  }
  // a link to the IdP Account Console = the user is dropped onto a page that is not D-Contact (#589 D2/D3) - gate
  for (const link of snapshot.links) {
    if (
      /\/realms\/[^/]+\/account(\/|$|\?)/.test(
        new URL(link.href).pathname + new URL(link.href).search,
      )
    ) {
      findings.push({
        where,
        kind: 'link',
        excerpt: `link "${link.text}" goes to ${new URL(link.href).pathname}`,
      });
    }
  }
  // information (not a gate): purely English lines on a Thai page = text that has not been translated
  if (/\[th\]/.test(where) && !control) {
    for (const line of snapshot.lines) {
      if (/^[\x20-\x7E]+$/.test(line) && /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(line))
        untranslated.add(`${where.replace(/ \[th\]/, '')}: ${line.slice(0, 80)}`);
    }
  }
  const detail = [
    snapshot.heading && `h1: ${snapshot.heading}`,
    snapshot.notice && `notice: ${snapshot.notice}`,
  ]
    .filter(Boolean)
    .join(' | ');
  visited.push(
    `${where} - ${new URL(page.url()).pathname} - "${snapshot.title}" - ${detail || '(no heading)'}`,
  );
  return snapshot;
}
function pkceUrl(extra = {}) {
  const url = new URL(`${ISSUER}/protocol/openid-connect/auth`);
  const params = {
    client_id: CLIENT,
    redirect_uri: `${ORIGIN}/`,
    response_type: 'code',
    scope: 'openid organization:demo',
    state: randomBytes(6).toString('hex'),
    code_challenge: 'abcdefghijklmnopqrstuvwxyzabcdefghijklmnopq',
    code_challenge_method: 'S256',
    ...extra,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.href;
}

async function submitUsername(page, username) {
  await page.locator('#username').fill(username);
  await page.locator('#kc-login').click();
}
async function submitPassword(page) {
  await page.locator('#password').fill(PASSWORD);
  await page.locator('#kc-login').click();
}

const harness = createServer((_, response) =>
  response
    .writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    .end('<!doctype html><title>app</title>'),
);

async function run(browser, locale) {
  scanLocale = locale;
  const tag = (name) => `${name} [${locale}]`;
  const context = await browser.newContext({ locale: locale === 'th' ? 'th-TH' : 'en-US' });
  const page = await context.newPage();

  // 1) login: username → password
  await page.goto(pkceUrl());
  await scanPage(tag('login: username'), page);
  const plain = await createUser('plain');
  await submitUsername(page, plain.username);
  await page.locator('#password').waitFor();
  await scanPage(tag('login: password'), page);

  // 2) reset password (the "forgot password" link) -> info + email
  const reset = page.locator('a[href*="reset-credentials"]');
  if ((await reset.count()) > 0) {
    await reset.first().click();
    await page.locator('#username').waitFor();
    await scanPage(tag('reset-password: form'), page);
    await page.locator('#username').fill(plain.username);
    await page.locator('input[type=submit], button[type=submit]').first().click();
    await page.waitForLoadState('domcontentloaded');
    await scanPage(tag('reset-password: info (email sent)'), page);
    for (const message of await mailTo(plain.username))
      scanEmail(tag('email: password-reset'), message);
  } else {
    infos.push(
      `[${locale}] no forgot-password link in this realm (resetPasswordAllowed=false) - the reset page/email was not scanned`,
    );
  }

  // 3) page-expired: open the original form with a mismatched session_code
  await page.goto(pkceUrl());
  const action = await page.locator('form').first().getAttribute('action');
  const stale = new URL(action, KEYCLOAK);
  stale.searchParams.set('session_code', 'expired-code');
  await page.goto(stale.href);
  await scanPage(tag('page-expired / session error'), page);

  // 4) error: a redirect_uri that is not allowed
  await page.goto(pkceUrl({ redirect_uri: 'https://evil.example.test/' }));
  await scanPage(tag('error: invalid redirect_uri'), page);
  await page.goto(pkceUrl({ client_id: 'no-such-client' }));
  await scanPage(tag('error: client not found'), page);

  // 5) OTP
  const withOtp = await createUser('otp', { otp: true });
  await page.goto(pkceUrl());
  await submitUsername(page, withOtp.username);
  await submitPassword(page);
  await page.locator('#otp').waitFor();
  await scanPage(tag('login: OTP'), page);

  // 5b) enrol TOTP through the same extension the API uses (the user scans the secret), then login must ask for OTP and the correct code passes
  const enrolled = await createUser('enrol');
  const enrolSecret = randomBytes(10).toString('hex');
  const enrol = await enrolTotpViaExtension(enrolled, enrolSecret);
  if (enrol.status !== 201) {
    findings.push({
      where: tag('enrol TOTP'),
      kind: 'acceptance',
      excerpt: `extension answered ${enrol.status}`,
    });
  } else {
    const enrolContext = await browser.newContext({
      locale: locale === 'th' ? 'th-TH' : 'en-US',
    });
    const enrolPage = await enrolContext.newPage();
    await enrolPage.goto(pkceUrl());
    await submitUsername(enrolPage, enrolled.username);
    await submitPassword(enrolPage);
    await enrolPage.locator('#otp').waitFor();
    await enrolPage.locator('#otp').fill(totp(enrolSecret));
    await enrolPage.locator('#kc-login').click();
    try {
      await enrolPage.waitForURL(`${ORIGIN}/**`, { timeout: 15_000 });
      infos.push(
        `[${locale}] after enrolling TOTP, login asks for OTP and the correct code passes`,
      );
    } catch {
      findings.push({
        where: tag('login with the enrolled OTP'),
        kind: 'acceptance',
        excerpt: 'entering the correct TOTP code did not pass',
      });
    }
    await enrolContext.close();
  }

  // 6) logout-confirm (log in first, then log out without an id_token_hint)
  const loggedIn = await createUser('logout');
  await page.goto(pkceUrl());
  await submitUsername(page, loggedIn.username);
  await submitPassword(page);
  await page.waitForURL(`${ORIGIN}/**`);
  await page.goto(
    `${ISSUER}/protocol/openid-connect/logout?${new URLSearchParams({ client_id: CLIENT, post_logout_redirect_uri: `${ORIGIN}/` })}`,
  );
  await scanPage(tag('logout-confirm'), page);
  const confirm = page
    .locator('#kc-logout, input[name=confirmLogout], button[type=submit]')
    .first();
  if ((await confirm.count()) > 0) {
    await confirm.click();
    await page.waitForLoadState('domcontentloaded');
    await scanPage(tag('after confirming logout'), page);
  }

  // 6b) change the password, then log in with the new password in a real browser (the old password must not pass)
  // - the real change through the D-Contact API is checked in apps/api account-api.boundary.ts (which uses the same reset-password)
  const NEW_PASSWORD = `${PASSWORD}-new`;
  await admin('PUT', `/users/${loggedIn.id}/reset-password`, {
    type: 'password',
    value: NEW_PASSWORD,
    temporary: false,
  });
  const freshContext = await browser.newContext({ locale: locale === 'th' ? 'th-TH' : 'en-US' });
  const afterChange = await freshContext.newPage();
  await afterChange.goto(pkceUrl());
  await submitUsername(afterChange, loggedIn.username);
  await afterChange.locator('#password').fill(PASSWORD);
  await afterChange.locator('#kc-login').click();
  await afterChange.locator('#password').waitFor();
  await scanPage(tag('login: old password after the change (must not pass)'), afterChange);
  await afterChange.locator('#password').fill(NEW_PASSWORD);
  await afterChange.locator('#kc-login').click();
  try {
    await afterChange.waitForURL(`${ORIGIN}/**`, { timeout: 15_000 });
    infos.push(`[${locale}] login with the new password succeeded and the old password did not`);
  } catch {
    findings.push({
      where: tag('login after the password change'),
      kind: 'acceptance',
      excerpt: 'login with the new password did not succeed',
    });
  }
  await freshContext.close();

  // 7) required actions (one user per action so every page is seen)
  for (const [label, action] of [
    ['update-password', 'UPDATE_PASSWORD'],
    ['update-profile', 'UPDATE_PROFILE'],
    ['verify-email', 'VERIFY_EMAIL'],
    ['configure-totp', 'CONFIGURE_TOTP'],
  ]) {
    const fresh = await context.newPage();
    const user = await createUser(label, {
      requiredActions: [action],
      emailVerified: action !== 'VERIFY_EMAIL' && action !== 'UPDATE_PROFILE',
    });
    await fresh.goto(pkceUrl());
    await submitUsername(fresh, user.username);
    await submitPassword(fresh);
    await fresh.waitForLoadState('domcontentloaded');
    await scanPage(tag(`required action: ${label}`), fresh);
    if (action === 'VERIFY_EMAIL') {
      for (const message of await mailTo(user.username))
        scanEmail(tag('email: verify-email'), message);
    }
    await fresh.close();
  }

  // 8) the invitation email (execute-actions), then follow the link to the page where the user ends up
  const invited = await createUser('invite', {
    requiredActions: ['VERIFY_EMAIL', 'UPDATE_PASSWORD'],
    emailVerified: false,
  });
  await admin('PUT', `/users/${invited.id}/execute-actions-email?lifespan=3600`, [
    'VERIFY_EMAIL',
    'UPDATE_PASSWORD',
  ]);
  const [invite] = await mailTo(invited.username);
  if (invite) {
    scanEmail(tag('email: execute-actions (invitation)'), invite);
    const link = /https?:\/\/[^\s"'<>]+action-token[^\s"'<>]+/.exec(invite.Text ?? '')?.[0];
    if (link) {
      const invitePage = await context.newPage();
      await invitePage.goto(link.replace(/&amp;/g, '&'));
      await scanPage(tag('invite: first page after clicking the link'), invitePage);
      for (let step = 0; step < 4; step += 1) {
        const field = invitePage.locator('#password-new');
        if ((await field.count()) > 0) {
          await field.fill(PASSWORD);
          await invitePage.locator('#password-confirm').fill(PASSWORD);
          await scanPage(tag('invite: set password'), invitePage);
          await invitePage.locator('input[type=submit], button[type=submit]').first().click();
        } else {
          const proceed = invitePage
            .locator(
              'a:has-text("Proceed"), a:has-text("ดำเนินการ"), input[type=submit], button[type=submit]', // allow-thai: matches the Thai button label of the localized Keycloak page
            )
            .first();
          if ((await proceed.count()) === 0) break;
          await proceed.click();
        }
        await invitePage.waitForLoadState('domcontentloaded');
        await scanPage(tag(`invite: step ${step + 1}`), invitePage);
      }
      infos.push(`[${locale}] invite ends at: ${new URL(invitePage.url()).pathname}`);
      if (/\/account/.test(invitePage.url())) {
        findings.push({
          where: tag('invite: final page'),
          kind: 'landing',
          excerpt: `was taken to ${new URL(invitePage.url()).pathname} (the IdP Account Console)`,
        });
      }
    } else {
      findings.push({
        where: tag('invite'),
        kind: 'setup',
        excerpt: 'no action-token link found in the invitation email',
      });
    }
  } else {
    findings.push({
      where: tag('invite'),
      kind: 'setup',
      excerpt: 'the invitation email was not received',
    });
  }

  // 9) every cookie of this context
  for (const cookie of await context.cookies())
    gate(tag(`cookie ${cookie.name}`), 'cookie-name', cookie.name);
  await context.close();
}

async function accountConsoleReachable(browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const response = await page
    .goto(`${ISSUER}/account/`, { waitUntil: 'domcontentloaded' })
    .catch(() => undefined);
  const status = response?.status() ?? 0;
  // pass = the user is not on an identity provider page (redirected to D-Contact or 404) - not merely "no text"
  const finalUrl = new URL(page.url() || 'about:blank', ISSUER);
  const stillOnIdp = finalUrl.origin === new URL(ISSUER).origin;
  const text = stillOnIdp
    ? await page.evaluate(() => document.body?.innerText ?? '').catch(() => '')
    : '';
  const reachable = stillOnIdp && status === 200 && text.trim().length > 0;
  if (reachable) {
    findings.push({
      where: 'Account Console',
      kind: 'reachable',
      excerpt: `${ISSUER}/account/ answered ${status} - the user can get in`,
    });
  } else {
    visited.push(
      `Account Console: ${stillOnIdp ? `page not shown (status ${status})` : `redirect to ${finalUrl.origin}`}`,
    );
  }
  await context.close();
}

adminToken = (
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

/**
 * negative control: the scanner must "see" this word when it is really there - the login page of the master realm (which does not go through the D-Contact theme) must be caught
 * if it is not caught = the scanner is unusable, so the PASS below would be meaningless
 */
async function negativeControl(browser) {
  const page = await browser.newPage();
  // the master realm login page is rendered server-side (title "Sign in to Keycloak") - not an SPA that redirects with JavaScript
  const master = new URL(`${KEYCLOAK}/realms/master/protocol/openid-connect/auth`);
  for (const [key, value] of Object.entries({
    client_id: 'security-admin-console',
    redirect_uri: `${KEYCLOAK}/admin/master/console/`,
    response_type: 'code',
    scope: 'openid',
  }))
    master.searchParams.set(key, value);
  await page.goto(master.href, { waitUntil: 'domcontentloaded' });
  const before = findings.length;
  await scanPage('control: realm master (must be found)', page, { control: true });
  const detected = findings.length > before;
  findings.splice(before); // not counted as a D-Contact finding
  await page.close();
  if (!detected) {
    console.error(
      'negative control failed: the scanner does not see the word Keycloak on the master realm page - the result is unusable',
    );
    process.exit(2);
  }
  console.log('negative control: the scanner catches the word Keycloak on the master realm page');
}

await new Promise((resolve, reject) => {
  harness.once('error', reject);
  harness.listen(Number(new URL(ORIGIN).port), resolve);
});
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
try {
  await negativeControl(browser);
  for (const locale of LOCALES) await run(browser, locale);
  await accountConsoleReachable(browser);
} finally {
  await browser.close();
  harness.close();
  for (const id of createdUsers) await admin('DELETE', `/users/${id}`).catch(() => undefined);
}

console.log(`\nscanned ${visited.length} pages/emails`);
for (const entry of visited) console.log(`  · ${entry}`);
if (infoSet.size > 0) {
  console.log('\ninformation (not a gate): resources served by the IdP have this word in the URL');
  for (const path of [...infoSet].sort()) console.log(`  · ${path}`);
}
if (untranslated.size > 0) {
  console.log(
    '\ninformation (not a gate): purely English text on a Thai page (not yet translated)',
  );
  for (const line of [...untranslated].sort()) console.log(`  · ${line}`);
}
for (const note of infos.filter((item) => typeof item === 'string')) console.log(`  ℹ ${note}`);
if (findings.length === 0) {
  console.log(
    '\nPASS: the word Keycloak was not found in the checked pages, emails and cookie names',
  );
} else {
  console.log(`\nFAIL: found ${findings.length} spots`);
  for (const finding of findings)
    console.log(`  ✗ ${finding.where} [${finding.kind}] …${finding.excerpt}…`);
  process.exitCode = 1;
}
