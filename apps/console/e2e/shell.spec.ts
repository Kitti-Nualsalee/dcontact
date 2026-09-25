import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';

/**
 * D1.13 (#452): flag `ui.shell.v2` ของ Console — Navigation API จำลองด้วย page.route
 * เนื้อหาของหน้า Journeys ไม่ใช่เป้าของ test นี้ (ย้ายจริงใน D1.14) จึงตรวจ axe เฉพาะส่วนของ shell
 */
test.use({ locale: 'th-TH' });

function navigation(shellV2: boolean) {
  return {
    groups: [
      { id: 'live', labelKey: 'navigation.groups.live' },
      { id: 'automation', labelKey: 'navigation.groups.automation' },
      { id: 'quality', labelKey: 'navigation.groups.quality' },
    ],
    apps: [
      {
        id: 'agent-workspace',
        groupId: 'live',
        labelKey: 'navigation.apps.agentWorkspace',
        hostApp: 'workspace',
        path: '/',
      },
      {
        id: 'journeys',
        groupId: 'automation',
        labelKey: 'navigation.apps.journeys',
        hostApp: 'console',
        path: '/?view=journeys',
      },
      {
        id: 'contact-governance',
        groupId: 'quality',
        labelKey: 'navigation.apps.contactGovernance',
        hostApp: 'console',
        path: '/?view=governance',
      },
    ],
    pins: { appIds: ['agent-workspace', 'journeys'], source: 'SYSTEM', revision: 0 },
    limits: { maxPins: 15 },
    features: { shellV2 },
  };
}

async function mockNavigation(page: Page, response: { status: number; body?: unknown }) {
  // หน้า Journeys ต้องได้รายการ (ว่าง) ไม่เช่นนั้นเนื้อหาหน้าจะ error เอง — ไม่เกี่ยวกับ shell
  await page.route('**/api/v1/journey-authoring/**', (route) =>
    route.fulfill({ status: 200, json: { items: [], nextCursor: null } }),
  );
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: response.status, json: response.body ?? { code: 'INTERNAL' } }),
  );
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'เมนูหลัก' });

test('flag ปิด → หน้าเดิมทุกประการ: ไม่มี rail และไม่โหลด token ของ shell', async ({ page }) => {
  await mockNavigation(page, { status: 200, body: navigation(false) });
  await page.goto('/?view=journeys&tenant=demo');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(rail(page)).toHaveCount(0);
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--dc-brand-700'),
  );
  expect(brand).toBe('');
});

test('Navigation API ล้มเหลว → กลับไปหน้าเดิม (fail-safe)', async ({ page }) => {
  await mockNavigation(page, { status: 500 });
  await page.goto('/?view=journeys&tenant=demo');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(rail(page)).toHaveCount(0);
});

test('flag เปิด → shell ครอบ Journeys: rail, SubNav, แถบบน และลิงก์ข้ามแอปมีแค่ path + tenant', async ({
  page,
}) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo');
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).getByRole('link', { name: 'Journeys' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const inbox = rail(page).getByRole('link', { name: /กล่องงาน/ });
  await expect(inbox).toHaveAttribute('href', 'http://localhost:5173/?tenant=demo');
  await expect(inbox).toHaveAttribute('target', '_blank');
  await expect(page.getByRole('navigation', { name: 'Journeys' })).toBeVisible(); // SubNav
  await expect(page.getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' })).toContainText(
    'ระบบอัตโนมัติ',
  );

  const axe = await new AxeBuilder({ page }).include('nav').include('header').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
});

test('flag เปิด → สลับภาษาในแถบบนเปลี่ยนป้ายของ shell ทันทีโดยไม่ reload', async ({ page }) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo');
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Inbox/ })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});
