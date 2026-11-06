import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function login(page: Page, request: APIRequestContext, alias = 'admin') {
  const config = (await (await request.get('/__core_test/config')).json()) as {
    tenant: string;
    password: string;
    users: Record<string, string>;
  };
  await page.goto(`/?tenant=${config.tenant}&view=customers`);
  await page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/ }).click();
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

test('OIDC จริง: สร้างลูกค้าและอ่านกลับโดยไม่เก็บร่างใน browser', async ({ page, request }) => {
  await login(page, request);
  const name = `ลูกค้า OIDC ${randomUUID()}`;
  await page.getByRole('button', { name: 'สร้างลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill(name);
  await expectDraftPrivate(page, name);
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expect(page.getByText('บันทึกและอ่านข้อมูลลูกค้ากลับแล้ว')).toBeVisible();
  await expectDraftPrivate(page, name);
  await page.reload();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expectDraftPrivate(page, name);
});

test('OIDC จริง: คำตอบหายหลัง commit แล้ว reload กู้ผลเดิมได้', async ({ page, request }) => {
  await login(page, request);
  const name = `กู้ลูกค้า OIDC ${randomUUID()}`;
  await page.getByRole('button', { name: 'สร้างลูกค้า' }).click();
  await page.getByLabel('ชื่อลูกค้า').fill(name);
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
  await page.getByRole('button', { name: 'บันทึกลูกค้า' }).click();
  await disconnected;
  await expect(page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' })).toBeVisible();
  await expectDraftPrivate(page, name);
  await page.unrouteAll({ behavior: 'wait' });
  page.once('dialog', (dialog) => void dialog.accept());
  await page.reload();
  await page.getByRole('button', { name: 'ตรวจสถานะการบันทึก' }).click();
  await expect(page.getByRole('heading', { name })).toBeVisible();
  await expectDraftPrivate(page, name);
});

test('OIDC จริง: Supervisor ไม่มีสิทธิ์สร้างลูกค้าจาก catalog', async ({ page, request }) => {
  await login(page, request, 'supervisor');
  await expect(page.getByRole('heading', { name: 'ลูกค้า', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'สร้างลูกค้า' })).toHaveCount(0);
});
