import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { homeNavigation } from './support/home-navigation.js';

test.use({ locale: 'th-TH', viewport: { width: 1440, height: 1024 } });

test('Home เป็น default, rail active, sidebar และเมนูเปิดปลายทางตาม host พร้อม tenant', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: homeNavigation() }));
  await page.goto('/?tenant=demo');
  await expect(page.getByRole('heading', { name: 'วันนี้ต้องการทำอะไร?' })).toBeVisible();
  // Registry ปัจจุบันมี People และ Core Settings เพิ่มจากชุด Home เดิม
  await expect(page.locator('.home__entry')).toHaveCount(8);
  await expect(
    page.locator('header').getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' }),
  ).toHaveCount(0);
  await expect(
    page.locator('#dc-main').getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' }),
  ).toBeVisible();
  await expect(page.locator('a[data-area=home]')).toHaveAttribute('aria-current', 'page');
  const systems = page.locator('header').getByRole('navigation', { name: 'ระบบงานสด' });
  await expect(systems.getByRole('link', { name: /^Workspace/ })).toHaveAttribute(
    'href',
    'http://localhost:5173/?tenant=demo',
  );
  await expect(systems.getByRole('link', { name: /^Supervisor/ })).toHaveAttribute(
    'href',
    'http://localhost:5173/?view=supervisor&tenant=demo',
  );
  for (const link of await systems.getByRole('link').all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  }
  await expect(page.locator('a[data-area=workspace], a[data-area=supervisor]')).toHaveCount(0);
  const sidebar = page.locator('.home-sidebar');
  await expect(sidebar.getByText('ปักหมุด', { exact: true })).toBeVisible();
  const pinned = sidebar
    .locator('div')
    .filter({ has: page.getByText('ปักหมุด', { exact: true }) })
    .last();
  await expect(pinned.getByRole('link', { name: /กล่องงาน/ })).toHaveAttribute(
    'href',
    'http://localhost:5173/?tenant=demo',
  );
  await expect(pinned.getByRole('link', { name: /กล่องงาน/ })).toHaveAttribute('target', '_blank');
  await expect(sidebar.getByRole('link', { name: 'หน้าแรก', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(sidebar.getByRole('link', { name: 'บัญชีของฉัน' })).toHaveAttribute(
    'href',
    '/?view=account&tenant=demo',
  );
  const inbox = page.getByRole('link', { name: /กล่องงาน \(Agent Workspace/ });
  await expect(inbox).toHaveAttribute('target', '_blank');
  await expect(inbox).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(inbox).toHaveAttribute('href', 'http://localhost:5173/?tenant=demo');
  const journey = page.locator('.home__entry').filter({ hasText: 'Journeys' });
  await expect(journey).not.toHaveAttribute('target');
  await expect(journey).toHaveAttribute('href', '/?view=journeys&tenant=demo');
  await inbox.focus();
  await expect(inbox).toBeFocused();
  await inbox.press('Tab');
  await expect(page.locator('.home__entry').nth(1)).toBeFocused();
  for (const lang of ['EN', 'TH']) {
    await page.getByRole('button', { name: lang === 'EN' ? 'English' : 'ไทย' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      lang === 'EN' ? 'What would you like to do today?' : 'วันนี้ต้องการทำอะไร?',
    );
    await expect(
      sidebar.getByText(lang === 'EN' ? 'Pinned' : 'ปักหมุด', { exact: true }),
    ).toBeVisible();
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations
        .filter((v) => ['critical', 'serious'].includes(v.impact ?? ''))
        .map((v) => v.id),
    ).toEqual([]);
  }
  // deep link ไป Journeys ไม่ถูก Home ดัก และย้อนกลับได้
  await page.route('**/api/v1/journey-authoring/**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await journey.click();
  await expect(page).toHaveURL(/view=journeys/);
  await expect(page.locator('a[data-area=journeys]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText('ปักหมุด', { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: 'วันนี้ต้องการทำอะไร?' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('สิทธิ์ compliance เห็นเฉพาะ Governance ทั้งหน้าและ sidebar ไม่เผยแอปอื่น', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ json: homeNavigation(['compliance']) }),
  );
  await page.goto('/?tenant=demo&view=home');
  await expect(page.locator('.home__entry')).toHaveCount(1);
  await expect(page.locator('.home__entry')).toContainText('Governance');
  await expect(page.locator('.home-sidebar')).not.toContainText('Journeys');
  await expect(page.locator('.home-sidebar')).not.toContainText('dphone');
  await expect(page.getByRole('heading', { name: 'งานสด', exact: true })).toHaveCount(0);
  await expect(
    page.locator('header').getByRole('link', { name: /^(Workspace|Supervisor)/ }),
  ).toHaveCount(0);
});

test('plan ปิด modules ยังคง catalog Voice ตาม registry และ Home ไม่ขึ้นกับหมุด', async ({
  page,
}) => {
  const nav = homeNavigation(['admin'], true, {});
  nav.pins.appIds = [];
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: nav }));
  await page.goto('/?tenant=demo');
  await expect(page.locator('.home__entry')).toHaveCount(5);
  await expect(page.getByText('ปักหมุด', { exact: true })).toHaveCount(0);
  await expect(page.locator('.home__entry').filter({ hasText: 'ตั้งค่า Voice' })).toHaveAttribute(
    'href',
    '/?view=voice-routing&tenant=demo',
  );
  await expect(page.locator('a[data-area=home]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: 'จัดการและตั้งค่า', exact: true })).toHaveCount(1);
});

test('ปิด shell flag ยังแสดงเมนูที่ server อนุญาต พร้อมสลับภาษาและบัญชี', async ({ page }) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ json: homeNavigation(['agent'], false) }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.locator('.home__entry')).toHaveCount(2);
  await expect(page.getByRole('navigation', { name: 'เมนูหลัก' })).toHaveCount(0);
  await expect(
    page.locator('header').getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' }),
  ).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(
    page.getByRole('heading', { name: 'What would you like to do today?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'User menu ผู้ทดสอบ คอนโซล' }).click();
  await expect(page.getByRole('menuitem', { name: 'My account' })).toBeVisible();
});

test('API ล้มเหลวไม่เดาเมนู กดลองอีกครั้งแล้วกู้คืนได้', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill(fail ? { status: 503, json: {} } : { json: homeNavigation(['agent']) }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByRole('heading', { name: 'โหลดเมนูไม่สำเร็จ' })).toBeVisible();
  await expect(page.locator('.home__entry')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: 'ลองอีกครั้ง' }).click();
  await expect(page.locator('.home__entry')).toHaveCount(2);
});

test('รายการว่างแสดงวิธีขอสิทธิ์ ไม่มีหมวดว่างหรือเมนูที่เดาเอง', async ({ page }) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ json: homeNavigation([]) }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByRole('heading', { name: 'ยังไม่มีพื้นที่ทำงานที่เปิดได้' })).toBeVisible();
  await expect(page.locator('.home__entry')).toHaveCount(0);
  await expect(page.locator('.home__group')).toHaveCount(0);
});

test('API รุ่นเก่าไม่มี areas ยังใช้ Home และลิงก์เมนูได้', async ({ page }) => {
  const { areas, ...legacy } = homeNavigation();
  void areas;
  legacy.apps = legacy.apps.filter((app) => app.id !== 'home');
  legacy.pins.appIds = legacy.pins.appIds.filter((id) => id !== 'home');
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: legacy }));
  await page.goto('/?tenant=demo');
  await expect(page.locator('.home__entry')).toHaveCount(8);
  await expect(
    page.locator('.home-sidebar').getByRole('link', { name: 'หน้าแรก', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

for (const shellV2 of [true, false]) {
  test(`Home บนจอแคบไม่ล้นแนวนอน (shellV2=${shellV2})`, async ({ page }) => {
    await page.route('**/api/v1/me/navigation', (route) =>
      route.fulfill({ json: homeNavigation(['admin'], shellV2) }),
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?tenant=demo');
    await expect(page.locator('.home__entry')).toHaveCount(8);
    await expect(page.getByRole('button', { name: 'English' })).toBeInViewport();
    await expect(page.getByRole('button', { name: 'เมนูผู้ใช้ ผู้ทดสอบ คอนโซล' })).toBeInViewport();
    await expect(page.locator('header').getByRole('link', { name: /^Workspace/ })).toBeInViewport();
    await expect(
      page.locator('header').getByRole('link', { name: /^Supervisor/ }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
