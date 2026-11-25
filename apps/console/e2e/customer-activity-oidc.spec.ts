import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { en, th } from './support/catalog';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the same catalog text in either language: the sign-in screen appears before the session locale is known */
const either = (key: string) => new RegExp(`^(${escapeRegExp(th(key))}|${escapeRegExp(en(key))})$`);
const T = (key: string, options?: Record<string, unknown>) =>
  th(`customerActivity:${key}`, options);

async function login(page: Page, request: APIRequestContext, alias = 'admin') {
  const config = await (await request.get('/__core_test/config')).json();
  await page.goto(
    `/?tenant=${alias === 'foreign' ? config.otherTenant : config.tenant}&view=customer-activity`,
  );
  await page.getByRole('button', { name: either('customerActivity:signIn') }).click();
  await page.getByLabel('Username or email').fill(config.users[alias]);
  if (!(await page.getByLabel('Password', { exact: true }).count()))
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).not.toHaveURL(/code=/);
}
test.beforeEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});
test.afterEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});

test('Activity OIDC: another tenant sees UNKNOWN and an empty that evidence cannot yet confirm', async ({
  page,
  request,
}) => {
  await login(page, request, 'foreign');
  await expect(page.getByText(T('coverage.UNKNOWN'))).toBeVisible();
  await expect(page.getByText(T('emptyUnconfirmed'))).toBeVisible();
});

test('Activity OIDC: filter by keyboard and paginate from real owner events without showing raw data', async ({
  page,
  request,
}, info) => {
  expect((await request.post('/__core_test/activity/seed')).ok()).toBe(true);
  await login(page, request);
  const grid = page.getByRole('grid', { name: T('title') });
  await expect(grid.getByRole('row')).toHaveCount(51);
  await page.getByRole('button', { name: T('more') }).focus();
  await page.keyboard.press('Enter');
  await expect(grid.getByRole('row')).toHaveCount(52);
  await expect(page.getByText(T('unknownActor')).first()).toBeVisible();
  await expect(grid.getByText(/Synthetic private tag/)).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 900 });
  const tableRegion = page.getByRole('region', {
    name: new RegExp(escapeRegExp(T('tableRegion'))),
  });
  await tableRegion.focus();
  await expect(tableRegion).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  if (process.env.C360_ACTIVITY_EVIDENCE_DIR) {
    mkdirSync(process.env.C360_ACTIVITY_EVIDENCE_DIR, { recursive: true });
    await page.screenshot({
      path: join(
        process.env.C360_ACTIVITY_EVIDENCE_DIR,
        `activity-${info.project.name}-${process.env.C360_DEV_TRIAL_ROUND ?? '1'}.png`,
      ),
    });
  }

  await page.getByRole('button', { name: new RegExp(escapeRegExp(T('operation'))) }).click();
  await page.getByRole('option', { name: T('operations.CONTACT_CREATED'), exact: true }).click();
  await page.getByRole('button', { name: T('apply') }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText(T('emptyUnconfirmed'))).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customer activity', level: 1 })).toBeVisible();
});

test('Activity OIDC: a response held before permission revoke does not return old data', async ({
  page,
  request,
}) => {
  expect((await request.post('/__core_test/activity/seed')).ok()).toBe(true);
  await login(page, request);
  const grid = page.getByRole('grid', { name: T('title') });
  await expect(grid.getByRole('row')).toHaveCount(51);
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let captured = false;
  await page.route('**/api/v1/customer-360/activity?*', async (route) => {
    if (captured) return route.continue();
    captured = true;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    arrived();
    await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.getByRole('button', { name: T('refresh') }).click();
  await reached;
  try {
    expect((await request.post('/__core_test/revoke')).ok()).toBe(true);
    const denied = page.getByRole('alert').filter({ hasText: T('access') });
    const apply = page.getByRole('button', { name: T('apply') });
    // when OIDC renews by itself during revoke the page may close the data before the user presses a filter
    await apply.or(denied).first().waitFor();
    if (await apply.isVisible()) {
      await apply.click({ timeout: 2000 }).catch(async () => {
        await expect(denied).toBeVisible();
      });
    }
    await expect(denied).toBeVisible();
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await expect(grid).toHaveCount(0);
});

test('Activity OIDC: a Supervisor cannot open the deep link', async ({ page, request }) => {
  await login(page, request, 'supervisor');
  await expect(page.getByRole('alert')).toContainText(T('access'));
  await expect(page.getByRole('grid', { name: T('title') })).toHaveCount(0);
});

test('Activity OIDC: returning to the same page after permission revoke must read the new permission', async ({
  page,
  request,
}) => {
  expect((await request.post('/__core_test/activity/seed')).ok()).toBe(true);
  await login(page, request);
  const grid = page.getByRole('grid', { name: T('title') });
  await expect(grid.getByRole('row')).toHaveCount(51);
  let release!: () => void;
  let arrived!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  let captured = false;
  await page.route('**/api/v1/customer-360/activity?*', async (route) => {
    if (captured) return route.continue();
    captured = true;
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    arrived();
    await held;
    await route.fulfill({ response }).catch(() => undefined);
  });
  await page.getByRole('button', { name: T('refresh') }).click();
  await reached;
  try {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(grid).toHaveCount(0);
    expect((await request.post('/__core_test/revoke')).ok()).toBe(true);
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expect(page.getByRole('alert')).toContainText(T('access'));
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
  await expect(grid).toHaveCount(0);
});
