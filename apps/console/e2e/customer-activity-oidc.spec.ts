import { expect, test, type Page, type APIRequestContext } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

async function login(page: Page, request: APIRequestContext, alias = 'admin') {
  const config = await (await request.get('/__core_test/config')).json();
  await page.goto(
    `/?tenant=${alias === 'foreign' ? config.otherTenant : config.tenant}&view=customer-activity`,
  );
  await page.getByRole('button', { name: /^(เข้าสู่ระบบอีกครั้ง|Sign in again)$/ }).click();
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

test('Activity OIDC: tenant อื่นเห็น UNKNOWN และ empty ที่ยังยืนยันหลักฐานไม่ได้', async ({
  page,
  request,
}) => {
  await login(page, request, 'foreign');
  await expect(page.getByText('ยังยืนยันความครอบคลุมของหลักฐานในช่วงที่เลือกไม่ได้')).toBeVisible();
  await expect(page.getByText('ยังไม่พบกิจกรรมที่แสดงได้ในช่วงนี้')).toBeVisible();
});

test('Activity OIDC: กรองด้วยคีย์บอร์ดและแบ่งหน้าจาก owner events จริงโดยไม่แสดงข้อมูลดิบ', async ({
  page,
  request,
}, info) => {
  expect((await request.post('/__core_test/activity/seed')).ok()).toBe(true);
  await login(page, request);
  const grid = page.getByRole('grid', { name: 'กิจกรรมลูกค้า' });
  await expect(grid.getByRole('row')).toHaveCount(51);
  await page.getByRole('button', { name: 'โหลดเพิ่ม' }).focus();
  await page.keyboard.press('Enter');
  await expect(grid.getByRole('row')).toHaveCount(52);
  await expect(page.getByText('ไม่ทราบผู้ดำเนินการ').first()).toBeVisible();
  await expect(grid.getByText(/Synthetic private tag/)).toHaveCount(0);
  await page.setViewportSize({ width: 768, height: 900 });
  const tableRegion = page.getByRole('region', { name: /ตารางกิจกรรม/ });
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

  await page.getByRole('button', { name: /เหตุการณ์/ }).click();
  await page.getByRole('option', { name: 'สร้างลูกค้า', exact: true }).click();
  await page.getByRole('button', { name: 'ใช้ตัวกรอง' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByText('ยังไม่พบกิจกรรมที่แสดงได้ในช่วงนี้')).toBeVisible();
  await page.setViewportSize({ width: 768, height: 900 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', { name: 'English', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Customer activity', level: 1 })).toBeVisible();
});

test('Activity OIDC: response ค้างก่อนถอนสิทธิ์ไม่คืนข้อมูลเก่า', async ({ page, request }) => {
  expect((await request.post('/__core_test/activity/seed')).ok()).toBe(true);
  await login(page, request);
  const grid = page.getByRole('grid', { name: 'กิจกรรมลูกค้า' });
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
  await page.getByRole('button', { name: 'อ่านข้อมูลใหม่' }).click();
  await reached;
  try {
    expect((await request.post('/__core_test/revoke')).ok()).toBe(true);
    const denied = page.getByRole('alert').filter({ hasText: 'โปรดติดต่อผู้ดูแล tenant' });
    const apply = page.getByRole('button', { name: 'ใช้ตัวกรอง' });
    // เมื่อ OIDC renew เองระหว่าง revoke หน้าอาจปิดข้อมูลก่อนผู้ใช้กดใช้ตัวกรอง
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

test('Activity OIDC: Supervisor เปิด deep link ไม่ได้', async ({ page, request }) => {
  await login(page, request, 'supervisor');
  await expect(page.getByRole('alert')).toContainText('โปรดติดต่อผู้ดูแล tenant');
  await expect(page.getByRole('grid', { name: 'กิจกรรมลูกค้า' })).toHaveCount(0);
});

test('Activity OIDC: กลับมาหน้าเดิมหลังถอนสิทธิ์ต้องอ่านสิทธิ์ใหม่', async ({ page, request }) => {
  expect((await request.post('/__core_test/activity/seed')).ok()).toBe(true);
  await login(page, request);
  const grid = page.getByRole('grid', { name: 'กิจกรรมลูกค้า' });
  await expect(grid.getByRole('row')).toHaveCount(51);
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
  await expect(page.getByRole('alert')).toContainText('โปรดติดต่อผู้ดูแล tenant');
  await expect(grid).toHaveCount(0);
});
