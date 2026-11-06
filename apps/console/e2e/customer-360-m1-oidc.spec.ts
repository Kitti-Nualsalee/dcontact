import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

async function login(page: Page, request: APIRequestContext, alias: string) {
  const config = (await (await request.get('/__core_test/config')).json()) as {
    tenant: string;
    password: string;
    users: Record<string, string>;
  };
  await page.goto(`/?tenant=${config.tenant}&view=customer-tags`);
  await page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/ }).click();
  await page.getByLabel('Username or email').fill(config.users[alias]!);
  if (!(await page.getByLabel('Password', { exact: true }).count()))
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).not.toHaveURL(/code=/);
  return config;
}

test('OIDC จริง: deep link, สร้างแท็ก, reload session และถอนสิทธิ์', async ({ page, request }) => {
  await request.post('/__core_test/restore');
  await login(page, request, 'admin');
  await expect(page.getByRole('heading', { name: 'จัดการแท็ก' })).toBeVisible();
  await page.getByRole('button', { name: 'สร้างแท็ก' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ชื่อแท็ก').fill('แท็ก OIDC browser');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'แท็ก OIDC browser' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('row').filter({ hasText: 'แท็ก OIDC browser' })).toBeVisible();
  await request.post('/__core_test/revoke');
  await page.reload();
  await expect(page.getByRole('alert')).toContainText('ไม่สามารถเข้าถึงแท็ก');
  await expect(page.getByText('แท็ก OIDC browser')).toHaveCount(0);
  await request.post('/__core_test/restore');
});

test('OIDC จริง: Supervisor เปิด deep link ไม่เห็น catalog', async ({ page, request }) => {
  await request.post('/__core_test/restore');
  await login(page, request, 'supervisor');
  await expect(page.getByRole('alert')).toContainText('ไม่สามารถเข้าถึงแท็ก');
  await expect(page.getByRole('table')).toHaveCount(0);
});

test('OIDC จริง: reload กู้ผลที่คำตอบหายโดยไม่สร้างแท็กซ้ำ', async ({ page, request }) => {
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
  await page.getByRole('button', { name: 'สร้างแท็ก' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('ชื่อแท็ก').fill('กู้ผล OIDC');
  await dialog.getByRole('button', { name: 'บันทึก' }).click();
  await expect(dialog.getByRole('button', { name: 'ตรวจผลการบันทึก' })).toBeVisible();
  page.on('dialog', (warning) => void warning.accept());
  await page.reload();
  const check = page.getByRole('button', { name: 'ตรวจผลการบันทึก' });
  await expect(check).toBeVisible();
  await check.click();
  await expect(page.getByRole('row').filter({ hasText: 'กู้ผล OIDC' })).toHaveCount(1);
});
