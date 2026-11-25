import { mkdirSync, writeFileSync } from 'node:fs';
import { test, expect, type Page, type APIRequestContext } from '@playwright/test';
import { en, th } from './support/catalog';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the same catalog text in either language, for steps that run before the session locale is known */
const either = (key: string) => new RegExp(`^(${escapeRegExp(th(key))}|${escapeRegExp(en(key))})$`);
const USER_MENU = new RegExp(`^${escapeRegExp(th('ui:userMenu.open', { name: '' }))}`);
test.beforeAll(async ({ browser }) => {
  mkdirSync('../../artifacts/core-settings', { recursive: true });
  writeFileSync(
    '../../artifacts/core-settings/browser-config.json',
    JSON.stringify(
      {
        browser: browser.browserType().name(),
        version: browser.version(),
        node: process.version,
        tzdb: process.versions.tz,
        icu: process.versions.icu,
        vmUat: 'NOT_RUN',
      },
      null,
      2,
    ),
  );
});
test.beforeEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});
test.afterEach(async ({ playwright }) => {
  const cleanup = await playwright.request.newContext({ baseURL: 'http://127.0.0.1:5188' });
  try {
    await cleanup.post('/__core_test/restore');
  } finally {
    await cleanup.dispose();
  }
});
interface Fixtures {
  tenant: string;
  otherTenant: string;
  password: string;
  users: Record<string, string>;
}
async function login(page: Page, request: APIRequestContext, alias = 'admin') {
  const config = (await (await request.get('/__core_test/config')).json()) as Fixtures;
  await page.goto(
    `/?tenant=${alias === 'foreign' ? config.otherTenant : config.tenant}&view=core-settings&page=organization`,
  );
  await page.getByRole('button', { name: either('coreSettings:signIn'), exact: true }).click();
  await page.getByLabel('Username or email').fill(config.users[alias]);
  if ((await page.getByLabel('Password', { exact: true }).count()) === 0)
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: either('coreSettings:title'), exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(
    (url) => !url.searchParams.has('code') && !url.searchParams.has('state'),
  );
  return config;
}
test('Rail: switching Home/organization and back/forward keeps the same document and OIDC session', async ({
  page,
  request,
}) => {
  const config = await login(page, request);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  let documents = 0,
    identityRequests = 0;
  page.on('request', (req) => {
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) documents++;
    if (req.url().startsWith(config.issuer)) identityRequests++;
  });
  const rail = page.getByRole('navigation', { name: either('ui:shell.mainNav') });
  await rail.getByRole('link', { name: either('common:navigation.apps.home') }).click();
  await expect(
    page.getByRole('heading', {
      name: either('home:title'),
    }),
  ).toBeVisible();
  await rail.getByRole('link', { name: either('coreSettings:title') }).click();
  await expect(
    page.getByRole('heading', { name: either('coreSettings:title'), exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(/view=home/);
  await page.goForward();
  await expect(page).toHaveURL(/view=core-settings/);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
  expect(documents).toBe(0);
  expect(identityRequests).toBe(0);
});
test('Rail: the organization draft stays when Rail/forward is cancelled, and confirming leaves without breaking history', async ({
  page,
  request,
}) => {
  await login(page, request);
  const rail = page.getByRole('navigation', { name: either('ui:shell.mainNav') });
  const home = rail.getByRole('link', { name: either('common:navigation.apps.home') });
  const name = page.getByRole('textbox', {
    name: either('coreSettings:name'),
  });
  const draft = 'Draft for Rail check';
  await name.fill(draft);
  page.once('dialog', (dialog) => dialog.dismiss());
  await home.click();
  await expect(page).toHaveURL(/view=core-settings/);
  await expect(name).toHaveValue(draft);
  page.once('dialog', (dialog) => dialog.accept());
  await home.click();
  await expect(page).toHaveURL(/view=home/);
  await page.goBack();
  await expect(name).toBeVisible();
  await name.fill(draft);
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.goForward();
  await expect(page).toHaveURL(/view=core-settings/);
  await expect(name).toHaveValue(draft);
  page.once('dialog', (dialog) => dialog.accept());
  await page.goForward();
  await expect(page).toHaveURL(/view=home/);
});
test('Rail: the Governance sub-page keeps the tenant and back/forward before switching back to Home', async ({
  page,
  request,
}) => {
  const config = await login(page, request);
  const timeOrigin = await page.evaluate(() => performance.timeOrigin);
  const rail = page.getByRole('navigation', { name: either('ui:shell.mainNav') });
  await rail.getByRole('link', { name: /Governance/ }).click();
  const nav = page.getByRole('navigation', { name: /^(Governance|Contact Governance)$/ });
  await nav
    .getByRole('link', { name: either('common:navigation.pages.contactGovernance.policies') })
    .click();
  await expect(page).toHaveURL(/section=policies/);
  await nav
    .getByRole('link', { name: either('common:navigation.pages.contactGovernance.overview') })
    .click();
  await expect(page).toHaveURL(/section=overview/);
  await page.goBack();
  await expect(
    nav.getByRole('link', { name: either('common:navigation.pages.contactGovernance.policies') }),
  ).toHaveAttribute('aria-current', 'page');
  expect(new URL(page.url()).searchParams.get('tenant')).toBe(config.tenant);
  await rail.getByRole('link', { name: either('common:navigation.apps.home') }).click();
  await expect(page).toHaveURL(/view=home/);
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(timeOrigin);
});
test('organization: real login → edit the name → readback and set defaults the first time, with the page not changing language', async ({
  page,
  request,
}) => {
  await login(page, request);
  const name = page.getByRole('textbox', { name: th('coreSettings:name'), exact: true });
  await name.fill('Browser test organization');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await expect(name).toHaveValue('Browser test organization');
  if (process.env.CORE_SETTINGS_VISUAL_EVIDENCE === '1')
    await page.screenshot({
      path: '../../artifacts/core-settings/organization-desktop.png',
      fullPage: true,
    });
  await page.getByRole('checkbox', { name: th('coreSettings:initializeDefaults') }).check();
  await page.getByRole('button', { name: th('coreSettings:locale') }).click();
  await page.getByRole('option', { name: th('coreSettings:english'), exact: true }).click();
  await page
    .getByRole('textbox', { name: th('coreSettings:timeZone'), exact: true })
    .fill('Asia/Bangkok');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await expect(
    page.getByRole('heading', { name: th('coreSettings:title'), exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: th('coreSettings:locale') }).click();
  await page.getByRole('option', { name: th('coreSettings:thai'), exact: true }).click();
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
});

test('organization: validation near the field, and a no-op after normalize does not report a data change', async ({
  page,
  request,
}) => {
  await login(page, request);
  const name = page.getByRole('textbox', { name: th('coreSettings:name'), exact: true });
  const current = await name.inputValue();
  await name.fill(' ');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByText(th('coreSettings:validation.name'))).toBeVisible();
  await name.fill(` ${current} `);
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.NO_OP'));
});
test('organization: two Admins editing in a clash must be asked to check the latest and keep the draft', async ({
  page,
  request,
  browser,
}) => {
  await login(page, request);
  const otherContext = await browser.newContext({ locale: 'th-TH' });
  const other = await otherContext.newPage();
  try {
    await login(other, request, 'admin-two');
    await page
      .getByRole('textbox', { name: th('coreSettings:name'), exact: true })
      .fill('Admin one saved');
    await other
      .getByRole('textbox', { name: th('coreSettings:name'), exact: true })
      .fill('Admin two draft');
    await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
    await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
    await other.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
    await expect(other.getByRole('status')).toContainText(
      th('coreSettings:status.REVISION_CONFLICT'),
    );
    await expect(
      other.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
    ).toHaveValue('Admin two draft');
    other.once('dialog', (d) => d.accept());
    await other.getByRole('button', { name: th('coreSettings:loadLatest') }).click();
    await expect(
      other.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
    ).toHaveValue('Admin one saved');
  } finally {
    await otherContext.close();
  }
});
test('organization: a lost response uses command-only recovery after reload and does not resend the business PATCH', async ({
  page,
  request,
}) => {
  await login(page, request);
  await request.post('/__core_test/fault/lost-response');
  await page
    .getByRole('textbox', { name: th('coreSettings:name'), exact: true })
    .fill('Confirm result after reload');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.UNKNOWN'));
  const refs = await page.evaluate(() =>
    Object.entries(sessionStorage).filter(([key]) => key.startsWith('dc:core-settings:command:')),
  );
  expect(refs).toHaveLength(1);
  expect(refs[0][1]).toMatch(/^[a-f0-9-]{36}$/);
  page.once('dialog', (d) => d.accept());
  await page.reload();
  // userStore is in memory: boot restores SSO then checks the original command before editing, without asking to log in again
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
  ).toHaveValue('Confirm result after reload');
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('dc:core-settings:command:')),
    ),
  ).toHaveLength(0);
});
test('organization: a missing readback stays UNKNOWN, then checking the original receipt succeeds', async ({
  page,
  request,
}) => {
  await login(page, request);
  await request.post('/__core_test/fault/readback');
  await page
    .getByRole('textbox', { name: th('coreSettings:name'), exact: true })
    .fill('Readback later');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.UNKNOWN'));
  await page.getByRole('button', { name: th('coreSettings:checkResult') }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.SAVED'));
});
test('organization: narrow keeps the draft, warns before leaving, and revoke does not use a cached capability', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page
    .getByRole('textbox', { name: th('coreSettings:name'), exact: true })
    .fill('Draft stays on page');
  await page.setViewportSize({ width: 760, height: 800 });
  if (process.env.CORE_SETTINGS_VISUAL_EVIDENCE === '1')
    await page.screenshot({
      path: '../../artifacts/core-settings/organization-narrow.png',
      fullPage: true,
    });
  await expect(
    page.getByRole('button', { name: th('coreSettings:save'), exact: true }),
  ).toHaveCount(0);
  await expect(page.getByText(th('coreSettings:draftKept'))).toBeVisible();
  await page.setViewportSize({ width: 1280, height: 900 });
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
  ).toHaveValue('Draft stays on page');
  await page.getByRole('button', { name: USER_MENU }).click();
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('menuitem', { name: th('ui:userMenu.account'), exact: true }).click();
  await expect(
    page.getByRole('heading', { name: th('coreSettings:title'), exact: true }),
  ).toBeVisible();
  await request.post('/__core_test/revoke');
  try {
    await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
    await expect(page.getByRole('status')).toContainText(th('coreSettings:status.FORBIDDEN'));
    await expect(
      page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
    ).toHaveCount(0);
  } finally {
    await request.post('/__core_test/restore');
  }
});
test('organization: a Supervisor is read-only and has a real way into the Team page', async ({
  page,
  request,
}) => {
  await login(page, request, 'supervisor');
  await expect(page.getByText(th('coreSettings:readOnly'))).toBeVisible();
  await expect(
    page.getByRole('button', { name: th('coreSettings:save'), exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('link', { name: th('common:navigation.pages.coreSettings.teams'), exact: true }),
  ).toHaveAttribute('href', /page=teams/);
});

test('organization: same-identity reauth stays on the same page keeping the draft, then checks the command before editing again', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.reload();
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
  ).toBeVisible();
  await request.post('/__core_test/fault/reauth');
  const name = page.getByRole('textbox', { name: th('coreSettings:name'), exact: true });
  await name.fill('Draft before session expiry');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.REAUTH'));
  await expect(name).toHaveValue('Draft before session expiry');
  await page.getByRole('button', { name: th('coreSettings:signIn'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.NOT_APPLIED'));
  await expect(name).toHaveValue('Draft before session expiry');
});
test('organization: the keyboard warning cancels sign-out and keeps the draft, then sign-out clears the draft and command reference', async ({
  page,
  request,
}) => {
  await login(page, request);
  await request.post('/__core_test/fault/readback');
  await page
    .getByRole('textbox', { name: th('coreSettings:name'), exact: true })
    .fill('Previous account data');
  await page.getByRole('button', { name: th('coreSettings:save'), exact: true }).click();
  await expect(page.getByRole('status')).toContainText(th('coreSettings:status.UNKNOWN'));
  await page.getByRole('button', { name: USER_MENU }).click();
  page.once('dialog', (d) => d.dismiss());
  await page.getByRole('menuitem', { name: th('ui:userMenu.signOut'), exact: true }).click();
  await expect(
    page.getByRole('heading', { name: th('coreSettings:title'), exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: USER_MENU }).click();
  page.once('dialog', (d) => d.accept());
  await page.getByRole('menuitem', { name: th('ui:userMenu.signOut'), exact: true }).click();
  await expect(
    page.getByRole('button', { name: th('common:auth.signedOut.action'), exact: true }),
  ).toBeVisible();
  expect(
    await page.evaluate(() =>
      Object.keys(sessionStorage).filter((key) => key.startsWith('dc:core-settings:command:')),
    ),
  ).toHaveLength(0);
  await login(page, request, 'foreign');
  await expect(
    page.getByRole('textbox', { name: th('coreSettings:name'), exact: true }),
  ).not.toHaveValue('Previous account data');
});

test('organization: English UI through real OIDC/API in a separate tenant', async ({
  browser,
  request,
}) => {
  const context = await browser.newContext({ locale: 'en-US' });
  const page = await context.newPage();
  try {
    await login(page, request, 'foreign');
    await page
      .getByRole('textbox', { name: 'Organization display name', exact: true })
      .fill('English organization');
    await page.getByRole('button', { name: 'Save changes', exact: true }).click();
    await expect(page.getByRole('status')).toContainText('Saved and verified');
  } finally {
    await context.close();
  }
});

test('Console session: switching menus and reload must restore SSO without asking to log in again', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.getByRole('button', { name: USER_MENU }).click();
  await page.getByRole('menuitem', { name: th('ui:userMenu.account'), exact: true }).click();
  await expect(
    page.getByRole('heading', { name: th('account:page.title'), exact: true }),
  ).toBeVisible();
  await page
    .getByRole('link', { name: th('common:navigation.apps.home'), exact: true })
    .first()
    .click();
  await expect(page.getByRole('heading', { name: th('home:title'), exact: true })).toBeVisible();
  await page.goBack();
  await expect(
    page.getByRole('heading', { name: th('account:page.title'), exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page.getByRole('heading', { name: th('home:title'), exact: true })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: th('home:title'), exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: USER_MENU })).toBeVisible();
  expect(
    await page.evaluate(() =>
      [localStorage, sessionStorage].some((storage) =>
        Object.values(storage).some((value) =>
          /"(?:access_token|refresh_token|id_token)"\s*:/.test(String(value)),
        ),
      ),
    ),
  ).toBe(false);
});

test('Console session: unusable SSO ends at the login UI and does not loop auth requests', async ({
  page,
  request,
  context,
}) => {
  await login(page, request);
  await context.clearCookies();
  let attempts = 0;
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (
      url.pathname.endsWith('/protocol/openid-connect/auth') &&
      url.searchParams.get('prompt') === 'none'
    )
      attempts++;
  });
  await page.reload();
  await expect(
    page.getByRole('button', { name: either('coreSettings:signIn'), exact: true }),
  ).toBeVisible({ timeout: 15000 });
  expect(attempts).toBe(1);
  expect(new URL(page.url()).pathname).toBe('/');
});

test('Console session: explicit sign-out and reload must not restore SSO back in by themselves', async ({
  page,
  request,
}) => {
  const config = await login(page, request);
  let attempts = 0;
  page.on('request', (req) => {
    const url = new URL(req.url());
    if (
      url.pathname.endsWith('/protocol/openid-connect/auth') &&
      url.searchParams.get('prompt') === 'none'
    )
      attempts++;
  });
  await page.getByRole('button', { name: USER_MENU }).click();
  await page.getByRole('menuitem', { name: th('ui:userMenu.signOut'), exact: true }).click();
  await expect(
    page.getByRole('heading', { name: th('common:auth.signedOut.title'), exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(
    page.getByRole('heading', { name: th('common:auth.signedOut.title'), exact: true }),
  ).toBeVisible();
  await page.goto(`/?tenant=${config.tenant}&view=core-settings&page=organization`);
  await expect(
    page.getByRole('button', { name: either('coreSettings:signIn'), exact: true }),
  ).toBeVisible();
  expect(attempts).toBe(0);
});

test('Console session: a hanging discovery must end at the login UI per the network timeout', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.route('**/.well-known/openid-configuration', () => {});
  await page.reload();
  await expect(
    page.getByRole('button', { name: either('coreSettings:signIn'), exact: true }),
  ).toBeVisible({ timeout: 12000 });
});

test('Console session: a hanging token request must end at the login UI per the network timeout', async ({
  page,
  request,
}) => {
  await login(page, request);
  await page.route('**/protocol/openid-connect/token', () => {});
  await page.reload();
  await expect(
    page.getByRole('button', { name: either('coreSettings:signIn'), exact: true }),
  ).toBeVisible({ timeout: 12000 });
});
