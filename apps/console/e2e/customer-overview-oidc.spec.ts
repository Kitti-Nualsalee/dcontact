import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { en, th } from './support/catalog';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the same catalog text in either language: the sign-in screen appears before the session locale is known */
const either = (key: string) => new RegExp(`^(${escapeRegExp(th(key))}|${escapeRegExp(en(key))})$`);
const T = (key: string, options?: Record<string, unknown>) =>
  th(`customerOverview:${key}`, options);
let tenant = '';
async function login(
  page: Page,
  request: APIRequestContext,
  view = 'customer-overview',
  alias = 'admin',
) {
  const cfg = await (await request.get('/__core_test/config')).json();
  tenant = alias === 'foreign' ? cfg.otherTenant : cfg.tenant;
  await page.goto(`/?tenant=${tenant}&view=${view}`);
  await page.getByRole('button', { name: either('customerOverview:signIn') }).click();
  await page.getByLabel('Username or email').fill(cfg.users[alias]);
  if (!(await page.getByLabel('Password', { exact: true }).count()))
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(cfg.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).not.toHaveURL(/code=/);
}
test.beforeEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});
test.afterEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});
test('OIDC: a real empty, partial failure retries per section, and asOf', async ({
  page,
  request,
}, info) => {
  let fail = true;
  await page.route('**/api/v1/customer-360/overview/tags', async (route) => {
    if (fail)
      await route.fulfill({
        status: 503,
        json: { error: { code: 'CATALOG_UNAVAILABLE', retryable: true } },
      });
    else await route.continue();
  });
  await login(page, request);
  const customers = page.getByRole('region', { name: T('customers') });
  const tags = page.getByRole('region', { name: T('tags') });
  await expect(customers.getByText(T('emptyCustomers'))).toBeVisible();
  await expect(customers.locator('time')).toBeVisible();
  await expect(tags.getByRole('alert')).toContainText(T('unavailable'));
  fail = false;
  await tags.getByRole('button', { name: T('retry') }).click();
  await expect(tags.getByText(T('emptyTags'))).toBeVisible();
  await expect(customers.getByText(T('emptyCustomers'))).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.C360_OVERVIEW_EVIDENCE_DIR) {
    mkdirSync(process.env.C360_OVERVIEW_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: join(
        process.env.C360_OVERVIEW_EVIDENCE_DIR,
        `overview-${info.project.name}-${process.env.C360_DEV_TRIAL_ROUND ?? '1'}.png`,
      ),
      fullPage: true,
    });
  }
});
test('OIDC: rules version/constraints from the writer registry have no editor, and English does not overflow', async ({
  page,
  request,
}) => {
  await login(page, request, 'customer-rules');
  await expect(page.getByText('c360-profile-v1', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(
    page.getByText(
      'trim,preserve-local-tokens,lowercase-domain,IDNA-validation-only,no-punycode,no-NFC,no-NFKC',
    ),
  ).toBeVisible();
  await expect(page.locator('main').getByText(T('fields.company'), { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Data rules', exact: true, level: 1 }),
  ).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('OIDC: revoke closes every section, an old response returns no data, and retry restores permission', async ({
  page,
  request,
}) => {
  await login(page, request);
  await expect(page.getByText(T('emptyCustomers'))).toBeVisible();
  let release!: () => void;
  let arrived!: () => void;
  const reached = new Promise<void>((r) => (arrived = r));
  const held = new Promise<void>((r) => (release = r));
  await page.route('**/api/v1/customer-360/overview/customers', async (route) => {
    const response = await route.fetch();
    arrived();
    await held;
    await route.fulfill({ response });
  });
  await page
    .getByRole('region', { name: T('customers') })
    .getByRole('button', { name: T('refresh') })
    .click();
  await reached;
  await request.post('/__core_test/revoke');
  await page
    .getByRole('region', { name: T('tags') })
    .getByRole('button', { name: T('refresh') })
    .click();
  await expect(page.getByRole('alert')).toContainText(T('access'));
  release();
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByText(T('emptyCustomers'))).toHaveCount(0);
});
test('OIDC: a Supervisor does not get Overview permission from the directory permission', async ({
  page,
  request,
}) => {
  await login(page, request, 'customer-overview', 'supervisor');
  await expect(page.getByRole('alert')).toContainText(T('access'));
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Contact your tenant administrator.');
  await expect(page.locator('main time')).toHaveCount(0);
});

for (const kind of ['role', 'proof'] as const) {
  test(`context: an OIDC ${kind} change during the session closes every section from the current server authorization`, async ({
    page,
    request,
  }) => {
    await login(page, request);
    await expect(page.getByRole('region', { name: T('customers') }).locator('time')).toBeVisible();
    await request.post(`/__core_test/overview/${kind}`);
    await page
      .getByRole('region', { name: T('customers') })
      .getByRole('button', { name: T('refresh') })
      .click();
    await expect(page.getByRole('alert')).toContainText(T('access'));
    await expect(page.locator('main time')).toHaveCount(0);
    await expect(page.getByText(T('emptyTags'))).toHaveCount(0);
  });
}

test('context: OIDC scope projection stale is unavailable, not zero, and recovers from the real owner', async ({
  page,
  request,
}) => {
  await login(page, request);
  const customers = page.getByRole('region', { name: T('customers') });
  await expect(customers.getByText(T('emptyCustomers'))).toBeVisible();
  await request.post('/__core_test/overview/scope-lag');
  await customers.getByRole('button', { name: T('refresh') }).click();
  await expect(customers.getByRole('alert')).toContainText(T('unavailable'));
  await expect(customers.getByText(T('emptyCustomers'))).toHaveCount(0);
  await expect(page.getByRole('region', { name: T('tags') }).locator('time')).toBeVisible();
  await request.post('/__core_test/restore');
  await customers.getByRole('button', { name: T('retry') }).click();
  await expect(customers.getByText(T('emptyCustomers'))).toBeVisible();
});

for (const alias of ['admin-two', 'foreign'] as const) {
  test(`context: OIDC changing to ${alias} while a response is held does not return the count of the original actor/tenant`, async ({
    page,
    request,
  }) => {
    await request.post('/__core_test/overview/grant-customer');
    await login(page, request);
    const customers = page.getByRole('region', { name: T('customers') });
    await expect(customers.locator('strong')).toHaveText('1');
    let release!: () => void;
    let arrived!: () => void;
    const reached = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let captured = false;
    await page.route('**/api/v1/customer-360/overview/customers', async (route) => {
      if (captured) return route.continue();
      captured = true;
      const response = await route.fetch();
      expect((await response.json()).count).toBe('1');
      arrived();
      await held;
      // changing the document may abort the old request before it is fulfilled, which is the correct outcome
      await route.fulfill({ response }).catch(() => undefined);
    });
    await customers.getByRole('button', { name: T('refresh') }).click();
    await reached;
    await page.context().clearCookies();
    await login(page, request, 'customer-overview', alias);
    await expect(
      page.getByRole('region', { name: T('customers') }).getByText(T('emptyCustomers')),
    ).toBeVisible();
    release();
    await page.unrouteAll({ behavior: 'wait' });
    await expect(page.getByRole('region', { name: T('customers') }).locator('strong')).toHaveCount(
      0,
    );
    await expect(
      page.getByRole('region', { name: T('customers') }).getByText(T('emptyCustomers')),
    ).toBeVisible();
  });
}
