import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { en, th } from './support/catalog';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the same catalog text in either language: the sign-in screen appears before the session locale is known */
const either = (key: string) => new RegExp(`^(${escapeRegExp(th(key))}|${escapeRegExp(en(key))})$`);
const T = (key: string, options?: Record<string, unknown>) => th(`customerTags:${key}`, options);

async function login(page: Page, request: APIRequestContext, alias: string) {
  const config = (await (await request.get('/__core_test/config')).json()) as {
    tenant: string;
    password: string;
    users: Record<string, string>;
  };
  await page.goto(`/?tenant=${config.tenant}&view=customer-tags`);
  await page.getByRole('button', { name: either('customerTags:signIn') }).click();
  await page.getByLabel('Username or email').fill(config.users[alias]!);
  if (!(await page.getByLabel('Password', { exact: true }).count()))
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).not.toHaveURL(/code=/);
  return config;
}

test('real OIDC: deep link, create a tag, reload the session and revoke permission', async ({
  page,
  request,
}) => {
  await request.post('/__core_test/restore');
  await login(page, request, 'admin');
  await expect(page.getByRole('heading', { name: T('title') })).toBeVisible();
  await page.getByRole('button', { name: T('create') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(T('name')).fill('OIDC browser tag');
  await dialog.getByRole('button', { name: T('save') }).click();
  await expect(page.getByRole('row').filter({ hasText: 'OIDC browser tag' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: 'OIDC browser tag' })).toBeVisible();
  await request.post('/__core_test/revoke');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText(T('access'));
  await expect(page.getByText('OIDC browser tag')).toHaveCount(0);
  await request.post('/__core_test/restore');
});

test('real OIDC: a Supervisor opening the deep link sees no catalog', async ({ page, request }) => {
  await request.post('/__core_test/restore');
  await login(page, request, 'supervisor');
  await expect(page.getByRole('alert')).toContainText(T('access'));
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('real OIDC: reload recovers a result whose answer was lost without creating a duplicate tag', async ({
  page,
  request,
}) => {
  await request.post('/__core_test/restore');
  await login(page, request, 'admin');
  let dropped = false;
  await page.route('**/api/v1/customer-360/tags', async (route) => {
    if (!dropped && route.request().method() === 'POST') {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
    } else await route.continue();
  });
  await page.getByRole('button', { name: T('create') }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel(T('name')).fill('OIDC recovery');
  await dialog.getByRole('button', { name: T('save') }).click();
  await expect(dialog.getByRole('button', { name: T('check') })).toBeVisible();
  page.on('dialog', (warning) => void warning.accept());
  await page.reload();
  const check = page.getByRole('button', { name: T('check') });
  await expect(check).toBeVisible();
  await check.click();
  await expect(page.getByRole('row').filter({ hasText: 'OIDC recovery' })).toHaveCount(1);
});
