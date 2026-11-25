import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { en, th } from './support/catalog';

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** the same catalog text in either language: the sign-in screen appears before the session locale is known */
const either = (key: string) => new RegExp(`^(${escapeRegExp(th(key))}|${escapeRegExp(en(key))})$`);
const T = (key: string, options?: Record<string, unknown>) => th(`customers:${key}`, options);

async function login(page: Page, request: APIRequestContext, alias = 'admin') {
  const config = (await (await request.get('/__core_test/config')).json()) as {
    tenant: string;
    password: string;
    users: Record<string, string>;
  };
  await page.goto(`/?tenant=${config.tenant}&view=customers`);
  await page.getByRole('button', { name: either('customers:signIn') }).click();
  await page.getByLabel('Username or email').fill(config.users[alias]!);
  if (!(await page.getByLabel('Password', { exact: true }).count()))
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).not.toHaveURL(/code=/);
}

async function expectDraftPrivate(page: Page, value: string) {
  expect(decodeURIComponent(page.url())).not.toContain(value);
  const storage = await page.evaluate(() => [
    JSON.stringify(localStorage),
    JSON.stringify(sessionStorage),
  ]);
  for (const entry of storage) expect(entry).not.toContain(value);
}

test.beforeEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});
test.afterEach(async ({ request }) => {
  await request.post('/__core_test/restore');
});

test('real OIDC: create a customer and read it back without keeping a draft in the browser', async ({
  page,
  request,
}, info) => {
  await login(page, request);
  const name = `OIDC customer ${randomUUID()}`;
  await page.getByRole('button', { name: T('write.create') }).click();
  await page.getByLabel(T('write.name')).fill(name);
  await expectDraftPrivate(page, name);
  await page.getByRole('button', { name: T('write.save') }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText(T('write.saved'))).toBeVisible();
  await expectDraftPrivate(page, name);
  await page.reload();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expectDraftPrivate(page, name);
  const evidenceDir = process.env.C360_C4_EVIDENCE_DIR;
  if (evidenceDir) {
    mkdirSync(evidenceDir, { recursive: true });
    await page.screenshot({
      path: join(
        evidenceDir,
        `create-readback-${info.project.name}-${process.env.C360_DEV_TRIAL_ROUND ?? info.repeatEachIndex}.png`,
      ),
      fullPage: true,
    });
  }
});

test('real OIDC: a lost answer after commit, then reload, recovers the original result', async ({
  page,
  request,
}) => {
  await login(page, request);
  const name = `OIDC recovery customer ${randomUUID()}`;
  await page.getByRole('button', { name: T('write.create') }).click();
  await page.getByLabel(T('write.name')).fill(name);
  await expectDraftPrivate(page, name);
  let dropped = false;
  let delivered!: () => void;
  const disconnected = new Promise<void>((resolve) => {
    delivered = resolve;
  });
  await page.route('**/api/v1/customer-360/contacts', async (route) => {
    if (!dropped && route.request().method() === 'POST') {
      dropped = true;
      await route.fetch();
      await route.abort('failed');
      delivered();
    } else await route.continue();
  });
  await page.getByRole('button', { name: T('write.save') }).click();
  await disconnected;
  await expect(page.getByRole('button', { name: T('write.checkResult') })).toBeVisible();
  await expectDraftPrivate(page, name);
  await page.unrouteAll({ behavior: 'wait' });
  page.once('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: T('write.checkResult') }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expectDraftPrivate(page, name);
});

test('real OIDC: a Supervisor has no permission to create a customer from the catalog', async ({
  page,
  request,
}) => {
  await login(page, request, 'supervisor');
  await expect(page.getByRole('heading', { name: T('title'), exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: T('write.create') })).toHaveCount(0);
});

test('real OIDC: saving unchanged data is a no-op and reads the result back', async ({
  page,
  request,
}) => {
  await login(page, request);
  const name = `OIDC no-op check ${randomUUID()}`;
  await page.getByRole('button', { name: T('write.create') }).click();
  await page.getByLabel(T('write.name')).fill(name);
  await page.getByRole('button', { name: T('write.save') }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await page.getByRole('button', { name: T('write.edit') }).click();
  await page.getByRole('button', { name: T('write.save') }).click();
  await expect(page.getByText(T('write.unchanged'))).toBeVisible();
});

test('real OIDC: revoking permission closes the draft and recovers it only when permission returns', async ({
  page,
  request,
}) => {
  await login(page, request);
  const name = `Draft after revoke ${randomUUID()}`;
  await page.getByRole('button', { name: T('write.create') }).click();
  await page.getByLabel(T('write.name')).fill(name);
  await request.post('/__core_test/revoke');
  await page.getByRole('button', { name: T('write.save') }).click();
  await expect(page.getByRole('alert')).toContainText(T('write.access'));
  await expect(page.getByLabel(T('write.name'))).toHaveCount(0);
  await expectDraftPrivate(page, name);
  await request.post('/__core_test/restore');
  await page
    .getByRole('alert')
    .getByRole('button', { name: T('retry') })
    .click();
  await expect(page.getByLabel(T('write.name'))).toHaveValue(name);
});
