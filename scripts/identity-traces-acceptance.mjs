/**
 * AC6 (#599) acceptance: ทุกหน้าและอีเมลที่ผู้ใช้ของ D-Contact เจอ ต้องไม่มีคำว่า Keycloak
 *
 * `node scripts/identity-traces-acceptance.mjs` — ต้องมี dev stack (Keycloak + mailpit), extension/theme ล่าสุด
 * (`pnpm infra:keycloak:extensions`, `pnpm infra:identity:theme`, `pnpm infra:identity:branding`)
 *
 * เปิดด้วย Chromium จริงและตรวจ (gate) `/keycloak/i` ใน: `<title>`, ข้อความที่มองเห็น (`innerText`) และค่า attribute ที่ผู้ใช้
 * อ่านได้ (alt, aria-label, title, placeholder, value); ทุก email: ชื่อผู้ส่ง, หัวเรื่อง, HTML และ text; และชื่อ cookie ทุกตัว
 * ส่วน URL ของ resource ที่มีคำนี้ (เช่น `/common/keycloak/...` ของ asset ที่ IdP เสิร์ฟ) รายงานไว้เป็นข้อมูล ไม่ใช่ gate
 * (ตัดสินใจเดียวกับ path `/auth/realms/...` ใน #589 D9)
 *
 * หน้าที่ครอบ: login (username/password/OTP), error, logout-confirm, page-expired, reset-password (+info + email),
 * required action (update-password, update-profile, verify-email + email, configure-totp) และ flow อีเมลเชิญ (execute-actions)
 * ไปจนถึงหน้าที่ผู้ใช้ลงท้าย; Account Console ต้องเข้าไม่ถึง
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
// ภาษาที่กำลังสแกน — ผู้ใช้ชั่วคราวถือ attribute locale นี้ อีเมลที่ Keycloak ส่งจึงตามภาษาของรอบนั้น
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

/** TOTP (RFC 6238, SHA1, 6 หลัก, 30 วินาที) — key = bytes ของ secret ตามที่ Keycloak ใช้กับ credential ที่เก็บเป็นตัวอักษร */
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
    // หัวข้อของเนื้อหาจริง (แผงแบรนด์ด้านซ้ายเหมือนกันทุกหน้า) — ใช้ยืนยันว่าเปิดถึงหน้าที่ตั้งใจ
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
  // TRACE_SHOTS=<dir> เก็บภาพหน้าจอของทุกหน้าที่สแกน (ไว้ตรวจด้วยตา — gate ตรวจแค่ข้อความ)
  if (process.env.TRACE_SHOTS && !control) {
    const slug = where
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80);
    await page.screenshot({ path: `${process.env.TRACE_SHOTS}/${slug}.png`, fullPage: true });
  }
  // TRACE_DUMP=<regex ของชื่อหน้า> พิมพ์ข้อความและลิงก์เต็มของหน้านั้น (ไว้ดูตอนแก้)
  if (process.env.TRACE_DUMP && new RegExp(process.env.TRACE_DUMP).test(where)) {
    console.log(
      `\n--- ${where}\n${snapshot.lines.join(' | ')}\nลิงก์: ${snapshot.links.map((l) => `${l.text}→${new URL(l.href).pathname}`).join(' ; ')}\n`,
    );
  }
  // ลิงก์ไป Account Console ของ IdP = ผู้ใช้หลุดไปหน้าที่ไม่ใช่ของ D-Contact (#589 D2/D3) — gate
  for (const link of snapshot.links) {
    if (
      /\/realms\/[^/]+\/account(\/|$|\?)/.test(
        new URL(link.href).pathname + new URL(link.href).search,
      )
    ) {
      findings.push({
        where,
        kind: 'link',
        excerpt: `ลิงก์ "${link.text}" ไป ${new URL(link.href).pathname}`,
      });
    }
  }
  // ข้อมูล (ไม่ใช่ gate): บรรทัดภาษาอังกฤษล้วนในหน้าภาษาไทย = ข้อความที่ยังไม่แปล
  if (/\[th\]/.test(where) && !control) {
    for (const line of snapshot.lines) {
      if (/^[\x20-\x7E]+$/.test(line) && /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(line))
        untranslated.add(`${where.replace(/ \[th\]/, '')}: ${line.slice(0, 80)}`);
    }
  }
  const detail = [
    snapshot.heading && `h1: ${snapshot.heading}`,
    snapshot.notice && `แจ้ง: ${snapshot.notice}`,
  ]
    .filter(Boolean)
    .join(' | ');
  visited.push(
    `${where} — ${new URL(page.url()).pathname} — "${snapshot.title}" — ${detail || '(ไม่มีหัวข้อ)'}`,
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

  // 2) reset password (ลิงก์ "ลืมรหัสผ่าน") → info + email
  const reset = page.locator('a[href*="reset-credentials"]');
  if ((await reset.count()) > 0) {
    await reset.first().click();
    await page.locator('#username').waitFor();
    await scanPage(tag('reset-password: form'), page);
    await page.locator('#username').fill(plain.username);
    await page.locator('input[type=submit], button[type=submit]').first().click();
    await page.waitForLoadState('domcontentloaded');
    await scanPage(tag('reset-password: info (ส่งอีเมลแล้ว)'), page);
    for (const message of await mailTo(plain.username))
      scanEmail(tag('email: password-reset'), message);
  } else {
    infos.push(
      `[${locale}] ไม่มีลิงก์ลืมรหัสผ่านใน realm นี้ (resetPasswordAllowed=false) — ไม่ได้สแกนหน้า/อีเมล reset`,
    );
  }

  // 3) page-expired: เปิดฟอร์มเดิมด้วย session_code ที่ไม่ตรง
  await page.goto(pkceUrl());
  const action = await page.locator('form').first().getAttribute('action');
  const stale = new URL(action, KEYCLOAK);
  stale.searchParams.set('session_code', 'expired-code');
  await page.goto(stale.href);
  await scanPage(tag('page-expired / ข้อผิดพลาดของ session'), page);

  // 4) error: redirect_uri ที่ไม่อนุญาต
  await page.goto(pkceUrl({ redirect_uri: 'https://evil.example.test/' }));
  await scanPage(tag('error: redirect_uri ไม่ถูกต้อง'), page);
  await page.goto(pkceUrl({ client_id: 'no-such-client' }));
  await scanPage(tag('error: ไม่พบ client'), page);

  // 5) OTP
  const withOtp = await createUser('otp', { otp: true });
  await page.goto(pkceUrl());
  await submitUsername(page, withOtp.username);
  await submitPassword(page);
  await page.locator('#otp').waitFor();
  await scanPage(tag('login: OTP'), page);

  // 5b) ลงทะเบียน TOTP ผ่าน extension เดียวกับที่ API ใช้ (ผู้ใช้สแกน secret) แล้ว login ต้องถาม OTP และโค้ดที่ถูกผ่าน
  const enrolled = await createUser('enrol');
  const enrolSecret = randomBytes(10).toString('hex');
  const enrol = await enrolTotpViaExtension(enrolled, enrolSecret);
  if (enrol.status !== 201) {
    findings.push({
      where: tag('ลงทะเบียน TOTP'),
      kind: 'acceptance',
      excerpt: `extension ตอบ ${enrol.status}`,
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
      infos.push(`[${locale}] ลงทะเบียน TOTP แล้ว login ถาม OTP และโค้ดที่ถูกผ่าน`);
    } catch {
      findings.push({
        where: tag('login ด้วย OTP ที่ลงทะเบียน'),
        kind: 'acceptance',
        excerpt: 'ใส่โค้ด TOTP ที่ถูกต้องแล้วไม่ผ่าน',
      });
    }
    await enrolContext.close();
  }

  // 6) logout-confirm (ล็อกอินก่อน แล้วออกโดยไม่มี id_token_hint)
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
    await scanPage(tag('หลังยืนยันออกจากระบบ'), page);
  }

  // 6b) เปลี่ยนรหัสผ่านแล้ว login ด้วยรหัสใหม่ในเบราว์เซอร์จริง (รหัสเดิมต้องไม่ผ่าน)
  // — การเปลี่ยนจริงผ่าน API ของ D-Contact ตรวจใน apps/api account-api.boundary.ts (ใช้ reset-password ตัวเดียวกัน)
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
  await scanPage(tag('login: รหัสเดิมหลังเปลี่ยน (ต้องไม่ผ่าน)'), afterChange);
  await afterChange.locator('#password').fill(NEW_PASSWORD);
  await afterChange.locator('#kc-login').click();
  try {
    await afterChange.waitForURL(`${ORIGIN}/**`, { timeout: 15_000 });
    infos.push(`[${locale}] login ด้วยรหัสผ่านใหม่สำเร็จ และรหัสเดิมไม่ผ่าน`);
  } catch {
    findings.push({
      where: tag('login หลังเปลี่ยนรหัสผ่าน'),
      kind: 'acceptance',
      excerpt: 'login ด้วยรหัสผ่านใหม่ไม่สำเร็จ',
    });
  }
  await freshContext.close();

  // 7) required actions (หนึ่งผู้ใช้ต่อหนึ่ง action เพื่อเห็นทุกหน้า)
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

  // 8) อีเมลเชิญ (execute-actions) แล้วเดินตามลิงก์จนถึงหน้าที่ผู้ใช้ลงท้าย
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
    scanEmail(tag('email: execute-actions (เชิญ)'), invite);
    const link = /https?:\/\/[^\s"'<>]+action-token[^\s"'<>]+/.exec(invite.Text ?? '')?.[0];
    if (link) {
      const invitePage = await context.newPage();
      await invitePage.goto(link.replace(/&amp;/g, '&'));
      await scanPage(tag('invite: หน้าแรกหลังกดลิงก์'), invitePage);
      for (let step = 0; step < 4; step += 1) {
        const field = invitePage.locator('#password-new');
        if ((await field.count()) > 0) {
          await field.fill(PASSWORD);
          await invitePage.locator('#password-confirm').fill(PASSWORD);
          await scanPage(tag('invite: ตั้งรหัสผ่าน'), invitePage);
          await invitePage.locator('input[type=submit], button[type=submit]').first().click();
        } else {
          const proceed = invitePage
            .locator(
              'a:has-text("Proceed"), a:has-text("ดำเนินการ"), input[type=submit], button[type=submit]',
            )
            .first();
          if ((await proceed.count()) === 0) break;
          await proceed.click();
        }
        await invitePage.waitForLoadState('domcontentloaded');
        await scanPage(tag(`invite: ขั้นที่ ${step + 1}`), invitePage);
      }
      infos.push(`[${locale}] invite ลงท้ายที่: ${new URL(invitePage.url()).pathname}`);
      if (/\/account/.test(invitePage.url())) {
        findings.push({
          where: tag('invite: หน้าที่ลงท้าย'),
          kind: 'landing',
          excerpt: `ถูกพาไป ${new URL(invitePage.url()).pathname} (Account Console ของ IdP)`,
        });
      }
    } else {
      findings.push({
        where: tag('invite'),
        kind: 'setup',
        excerpt: 'ไม่พบลิงก์ action-token ในอีเมลเชิญ',
      });
    }
  } else {
    findings.push({ where: tag('invite'), kind: 'setup', excerpt: 'ไม่ได้รับอีเมลเชิญ' });
  }

  // 9) cookie ทุกตัวของ context นี้
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
  // ผ่าน = ผู้ใช้ไม่ได้อยู่บนหน้าของ identity provider (redirect ไป D-Contact หรือ 404) — ไม่ใช่แค่ "ไม่มีข้อความ"
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
      excerpt: `${ISSUER}/account/ ตอบ ${status} — ผู้ใช้เข้าได้`,
    });
  } else {
    visited.push(
      `Account Console: ${stillOnIdp ? `ไม่แสดงหน้า (status ${status})` : `redirect ไป ${finalUrl.origin}`}`,
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
 * negative control: ตัวสแกนต้อง "เห็น" คำนี้เมื่อมีจริง — หน้า login ของ realm master (ไม่ผ่าน theme ของ D-Contact) ต้องถูกจับได้
 * ถ้าไม่ถูกจับ = ตัวสแกนใช้ไม่ได้ ผล PASS ข้างล่างจึงไม่มีความหมาย
 */
async function negativeControl(browser) {
  const page = await browser.newPage();
  // หน้า login ของ realm master render ฝั่ง server (title "Sign in to Keycloak") — ไม่ใช่ SPA ที่ redirect ด้วย JavaScript
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
  await scanPage('control: realm master (ต้องเจอ)', page, { control: true });
  const detected = findings.length > before;
  findings.splice(before); // ไม่นับเป็น finding ของ D-Contact
  await page.close();
  if (!detected) {
    console.error(
      'negative control ล้มเหลว: ตัวสแกนไม่เห็นคำว่า Keycloak ในหน้าของ realm master — ใช้ผลไม่ได้',
    );
    process.exit(2);
  }
  console.log('negative control: ตัวสแกนจับคำว่า Keycloak ในหน้า realm master ได้');
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

console.log(`\nสแกน ${visited.length} หน้า/อีเมล`);
for (const entry of visited) console.log(`  · ${entry}`);
if (infoSet.size > 0) {
  console.log('\nข้อมูล (ไม่ใช่ gate): resource ที่ IdP เสิร์ฟมีคำนี้ใน URL');
  for (const path of [...infoSet].sort()) console.log(`  · ${path}`);
}
if (untranslated.size > 0) {
  console.log('\nข้อมูล (ไม่ใช่ gate): ข้อความภาษาอังกฤษล้วนในหน้าภาษาไทย (ยังไม่แปล)');
  for (const line of [...untranslated].sort()) console.log(`  · ${line}`);
}
for (const note of infos.filter((item) => typeof item === 'string')) console.log(`  ℹ ${note}`);
if (findings.length === 0) {
  console.log('\nPASS: ไม่พบคำว่า Keycloak ในหน้า อีเมล และชื่อ cookie ที่ตรวจ');
} else {
  console.log(`\nFAIL: พบ ${findings.length} จุด`);
  for (const finding of findings)
    console.log(`  ✗ ${finding.where} [${finding.kind}] …${finding.excerpt}…`);
  process.exitCode = 1;
}
