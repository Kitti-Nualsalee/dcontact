import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { totp } from '../../../scripts/keycloak-platform-login.mjs';
import { PLATFORM_DEV_USERS } from '../../../scripts/keycloak-platform-setup.mjs';

/**
 * UAT flow ของ #412 ผ่าน UI จริงทั้งเส้น: login (password + OTP) → create → track จน ACTIVE →
 * search → timeline → recovery preview ของคำขอที่ติด ACTION_REQUIRED
 */
const operator = PLATFORM_DEV_USERS.find((user) => user.role === 'platform_operator')!;
const run = randomUUID().slice(0, 6);

async function login(page: Page) {
  await page.goto('/');
  await page.getByRole('button', { name: 'เข้าสู่ระบบ' }).click();
  await page.locator('#username').fill(operator.username);
  await page.locator('#password').fill(operator.password);
  await page.locator('#kc-login').click();
  // รหัส OTP ใช้ซ้ำใน window เดิมไม่ได้ — รอ window ใหม่ก่อนกรอก
  const window = Math.floor(Date.now() / 30_000);
  await page.waitForTimeout((window + 1) * 30_000 - Date.now() + 500);
  await page.locator('#otp').fill(totp(operator.totpSecret));
  await page.locator('#kc-login').click();
  await expect(page.getByRole('heading', { name: 'Tenants', level: 1 })).toBeVisible();
  // callback ไม่ทิ้ง code/state ไว้ใน URL
  expect(page.url()).not.toMatch(/[?&](code|state)=/);
}

async function createTenant(page: Page, slug: string, email: string) {
  await page.getByRole('button', { name: 'สร้าง tenant' }).first().click();
  await page.getByLabel('ชื่อลูกค้า / องค์กร').fill(`UAT ${slug}`);
  await page.getByLabel('Slug').fill(slug);
  await page.getByLabel('Primary domain').fill(`${slug}.uat.example.test`);
  await page.getByLabel('Plan').selectOption({ index: 1 });
  await page.getByLabel('ชื่อ First admin').fill('UAT Admin');
  await page.getByLabel('อีเมล First admin').fill(email);
  await page.getByRole('button', { name: 'ตรวจสอบข้อมูล →' }).click();
  await page.getByLabel(/ฉันตรวจสอบ identity/).check();
  await page.getByRole('button', { name: 'ยืนยันและเริ่ม provision' }).click();
  await expect(page).toHaveURL(/\/requests\/[0-9a-f-]{36}$/);
}

test('UAT: create → track → search → timeline → recovery preview ผ่าน UI จริง', async ({
  page,
}) => {
  await login(page);
  const email = `uat-${run}@uat.example.test`;
  await createTenant(page, `uat-${run}`, email);
  await expect(page.getByRole('heading', { name: 'พร้อมส่งมอบให้ลูกค้า' })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText('ส่งถึงผู้ให้บริการอีเมลแล้ว')).toBeVisible();

  await page.getByRole('button', { name: 'Tenants' }).click();
  await page.getByLabel('ค้นหา tenant').fill(email);
  await page.getByLabel('ค้นหา tenant').press('Enter');
  await expect(page.getByRole('row', { name: new RegExp(`UAT uat-${run}`) })).toContainText(
    'ACTIVE',
  );
  await page.getByRole('button', { name: `เปิดรายละเอียด UAT uat-${run}` }).click();
  const timeline = page.getByRole('list', { name: 'เหตุการณ์ล่าสุดก่อน' });
  await expect(timeline.getByText('Platform Operator').first()).toBeVisible();
  await expect(timeline.getByText('System').first()).toBeVisible();

  // อีเมลที่เป็นของ tenant user เดิม → FIRST_ADMIN หยุดที่ ACTION_REQUIRED แล้วลอง preview recovery
  await page.getByRole('button', { name: 'Tenants' }).click();
  await createTenant(page, `uat-${run}-stuck`, 'admin@demo.local');
  await expect(page.getByRole('heading', { name: 'ต้องการการตัดสินใจ' })).toBeVisible({
    timeout: 90_000,
  });
  await expect(page.getByText('FIRST_ADMIN_EMAIL_CONFLICT').first()).toBeVisible();
  await page.getByRole('button', { name: 'Reconcile & resume (แนะนำ)' }).click();
  const panel = page.getByRole('region', { name: /Reconcile & resume/ });
  await expect(panel.getByText('พบ resource ชื่อเดียวกันของเจ้าของอื่น — ห้ามยึด')).toBeVisible({
    timeout: 30_000,
  });

  const storage = await page.evaluate(() => JSON.stringify({ ...localStorage, ...sessionStorage }));
  expect(storage).not.toContain('access_token');
  expect(storage).not.toContain(email);
  console.log(JSON.stringify({ run }));
});
