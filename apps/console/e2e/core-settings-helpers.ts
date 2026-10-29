import { expect, type Page, type APIRequestContext } from '@playwright/test';
export async function coreLogin(page: Page, request: APIRequestContext, alias = 'admin') {
  const config = await (await request.get('/__core_test/config')).json();
  await page.goto(`/?tenant=${config.tenant}&view=core-settings&page=teams`);
  await page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/ }).click();
  await page.getByLabel('Username or email').fill(config.users[alias]);
  if (!(await page.getByLabel('Password', { exact: true }).count()))
    await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.getByLabel('Password', { exact: true }).fill(config.password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await expect(page).not.toHaveURL(/code=/);
  return config;
}
