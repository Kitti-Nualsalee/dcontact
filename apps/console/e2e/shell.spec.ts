import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { homeNavigation } from './support/home-navigation.js';

/**
 * D1.13 (#452): the Console flag `ui.shell.v2` — the Navigation API is mocked with page.route
 * the Journeys page content is not this test's target (really moved in D1.14), so axe checks only the shell parts
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
    // #651: work areas on the rail + submenu (the server already filtered by role/plan)
    areas: [
      {
        id: 'workspace',
        labelKey: 'navigation.areas.workspace',
        sections: [
          {
            id: 'work',
            labelKey: 'navigation.sections.work',
            items: [{ appId: 'agent-workspace' }],
          },
        ],
      },
      {
        id: 'journeys',
        labelKey: 'navigation.areas.journeys',
        sections: [
          { id: 'work', labelKey: 'navigation.sections.work', items: [{ appId: 'journeys' }] },
        ],
      },
      {
        id: 'governance',
        labelKey: 'navigation.areas.governance',
        sections: [
          {
            id: 'work',
            labelKey: 'navigation.sections.work',
            items: [{ appId: 'contact-governance' }],
          },
        ],
      },
    ],
    pins: { appIds: ['agent-workspace', 'journeys'], source: 'SYSTEM', revision: 0 },
    limits: { maxPins: 15 },
    features: { shellV2 },
  };
}

async function mockNavigation(page: Page, response: { status: number; body?: unknown }) {
  // the Journeys page must get a (empty) list, otherwise the page content errors by itself — unrelated to the shell
  await page.route('**/api/v1/journey-authoring/**', (route) =>
    route.fulfill({ status: 200, json: { items: [], nextCursor: null } }),
  );
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: response.status, json: response.body ?? { code: 'INTERNAL' } }),
  );
}

const rail = (page: Page) => page.getByRole('navigation', { name: 'เมนูหลัก' });

test('#860: the customer menu per the registry works by keyboard and can switch language on a narrow screen', async ({
  page,
}) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await mockNavigation(page, { status: 200, body: homeNavigation(['admin']) });
  await page.goto('/?view=journeys&tenant=demo');
  await page.getByRole('button', { name: 'เปิดเมนูนำทาง' }).click();
  const customers = rail(page).getByRole('link', { name: 'ลูกค้า' });
  await expect(customers).toBeVisible();
  await customers.focus();
  await expect(customers).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'เปิดเมนูนำทาง' }).click();
  await expect(customers).toHaveAttribute('aria-current', 'page');
  const subnav = page.getByRole('navigation', { name: 'ลูกค้า' });
  await expect(subnav.getByRole('link', { name: 'ภาพรวมข้อมูลลูกค้า' })).toBeVisible();
  await expect(subnav.getByRole('link', { name: 'กฎข้อมูล' })).toBeVisible();
  await expect(subnav.getByRole('link', { name: 'กิจกรรมลูกค้า' })).toBeVisible();
  await expect(subnav.getByRole('link', { name: 'จัดการแท็ก' })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'English' }).click();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Customers' }).getByRole('link', { name: 'Data rules' }),
  ).toBeVisible();
});

test('#860: a Supervisor sees only the customer pages the server sends', async ({ page }) => {
  await mockNavigation(page, { status: 200, body: homeNavigation(['supervisor']) });
  await page.goto('/?view=journeys&tenant=demo');
  await rail(page).getByRole('link', { name: 'ลูกค้า' }).click();
  const subnav = page.getByRole('navigation', { name: 'ลูกค้า' });
  await expect(subnav.getByRole('link')).toHaveCount(1);
  await expect(subnav.getByRole('link', { name: 'ลูกค้า' })).toBeVisible();
});

test('the breadcrumb of a page with no specific form uses area / app per the menu, not Governance', async ({
  page,
}) => {
  await mockNavigation(page, { status: 200, body: homeNavigation(['agent']) });
  for (const [view, area, app] of [
    ['team-cases', 'เคส', 'เคสของทีม'],
    ['agent-history', 'ประวัติ', 'ประวัติงานของฉัน'],
  ]) {
    await page.goto(`/?view=${view}&tenant=demo`);
    const breadcrumb = page
      .locator('#dc-main')
      .getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' });
    await expect(breadcrumb).toContainText(area);
    await expect(breadcrumb.locator('[aria-current=page]')).toHaveText(app);
    await expect(breadcrumb).not.toContainText('Governance');
  }
});

test('flag off → no rail, and a page not yet moved does not load the shell tokens', async ({
  page,
}) => {
  await mockNavigation(page, { status: 200, body: navigation(false) });
  await page.goto('/?view=journeys&tenant=demo');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(rail(page)).toHaveCount(0);

  // D1.14: the Journeys page moved to tokens in both flag states — a page not yet moved must not get tokens
  await page.goto('/?view=i18n');
  await expect(page.getByTestId('language-label')).toBeVisible();
  const brand = await page.evaluate(() =>
    getComputedStyle(document.documentElement).getPropertyValue('--dc-brand-700'),
  );
  expect(brand).toBe('');
});

test('Navigation API fails → return to the original page (fail-safe)', async ({ page }) => {
  await mockNavigation(page, { status: 500 });
  await page.goto('/?view=journeys&tenant=demo');
  await page.waitForLoadState('networkidle');
  await expect(page.locator('#root')).not.toBeEmpty();
  await expect(rail(page)).toHaveCount(0);
});

test('flag on → the shell wraps Journeys: rail, SubNav, top bar, and cross-app links hold only path + tenant', async ({
  page,
}) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo');
  await expect(rail(page)).toBeVisible();
  await expect(rail(page).getByRole('link', { name: 'Journeys' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // #758: the live-system entry is in the top bar and opens a new tab with the tenant
  const workspace = page.locator('header').getByRole('link', { name: /^Workspace/ });
  await expect(workspace).toHaveAttribute('href', 'http://localhost:5173/?tenant=demo');
  await expect(workspace).toHaveAttribute('target', '_blank');
  await expect(workspace).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(rail(page).locator('a[data-area=workspace]')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Journeys' })).toBeVisible(); // SubNav
  await expect(page.getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' })).toContainText(
    'ระบบอัตโนมัติ',
  );
  await expect(
    page.locator('header').getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' }),
  ).toHaveCount(0);
  const breadcrumb = page.locator('#dc-main').getByRole('navigation', { name: 'ตำแหน่งปัจจุบัน' });
  await expect(breadcrumb).toBeVisible();
  await expect(breadcrumb.locator('[aria-current=page]')).toHaveText('Journeys');

  const axe = await new AxeBuilder({ page }).include('nav').include('header').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
});

test('flag on → switching language in the top bar changes the shell labels immediately without reload', async ({
  page,
}) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo');
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await expect(page.getByRole('link', { name: /Workspace/ })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});

/**
 * #588: user menu — the harness user is "Console Tester" (admin + offline_access)
 * and sign-outs are counted in `__signOuts`
 */
const userMenu = (page: Page) => page.getByRole('button', { name: 'เมนูผู้ใช้ Console Tester' });

test('flag off → no user menu', async ({ page }) => {
  await mockNavigation(page, { status: 200, body: navigation(false) });
  await page.goto('/?view=journeys&tenant=demo');
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible();
  await expect(userMenu(page)).toHaveCount(0);
});

test('flag on → the user menu shows name/organization/role, has no link elsewhere, and can sign out', async ({
  page,
}) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo');
  await expect(rail(page)).toBeVisible();
  await userMenu(page).click();
  const menu = page.getByRole('menu');
  await expect(menu).toHaveAccessibleName(
    /Console Tester.*console-e2e@demo\.example.*องค์กร demo.*ผู้ดูแลระบบ/,
  );
  await expect(page.getByText('offline_access')).toHaveCount(0);
  // AC5 (#598): "My account" points only to the D-Contact Console page (same tab) + sign out
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await expect(menu.getByRole('menuitem', { name: 'บัญชีของฉัน' })).toHaveAttribute(
    'href',
    '/?view=account&tenant=demo',
  );
  await expect(page.locator('[data-trigger=MenuTrigger]').getByRole('link')).toHaveCount(0);

  const axe = await new AxeBuilder({ page }).include('header').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);

  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
  expect(await page.evaluate(() => (window as { __signOuts?: number }).__signOuts ?? 0)).toBe(1);
});

test('#588: sign-out fails → the user is notified, not silently swallowed', async ({ page }) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo&signout=fail');
  await userMenu(page).click();
  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
  await expect(page.getByText('ออกจากระบบไม่สำเร็จ กรุณาลองอีกครั้ง')).toBeVisible();
});

/**
 * #651: Rail menu system (work areas) + a submenu driven by data from the Navigation API
 */
test("#651: the rail shows the permitted work areas in the server's order and selects the current area", async ({
  page,
}) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo');
  const links = rail(page).locator('a[data-area]');
  await expect(links).toHaveCount(2);
  expect(await links.evaluateAll((els) => els.map((el) => el.getAttribute('data-area')))).toEqual([
    'journeys',
    'governance',
  ]);
  await expect(rail(page).locator('a[aria-current=page]')).toHaveAttribute('data-area', 'journeys');
  // an area button within the same app = a relative link to the area's first item
  await expect(rail(page).locator('a[data-area=governance]')).toHaveAttribute(
    'href',
    '/?view=governance&tenant=demo',
  );
  // an area the user has no permission for (not in the response) must not be on the rail
  await expect(rail(page).locator('a[data-area=integrations]')).toHaveCount(0);
});

test('#758: the submenu shows only the current area, with no pins inserted from other areas', async ({
  page,
}) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo');
  const sub = page.getByRole('navigation', { name: 'Journeys' });
  await expect(sub).toBeVisible();
  await expect(sub.getByText('ปักหมุด')).toHaveCount(0);
  await expect(sub.getByText('งาน', { exact: true })).toBeVisible();
  await expect(sub.getByRole('link', { name: 'Journeys' }).first()).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(sub.getByRole('link', { name: /กล่องงาน/ })).toHaveCount(0);
});

test('#651: the area rail and submenu pass axe in both Thai and English', async ({ page }) => {
  await mockNavigation(page, { status: 200, body: navigation(true) });
  await page.goto('/?view=journeys&tenant=demo');
  for (const language of ['TH', 'EN']) {
    await page.getByRole('button', { name: language === 'TH' ? 'ไทย' : 'English' }).click();
    const axe = await new AxeBuilder({ page }).include('nav').analyze();
    expect(
      axe.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id),
    ).toEqual([]);
  }
});

test("#651: an older API that does not send areas → the rail uses the app's original pins, and has a single submenu item for this app", async ({
  page,
}) => {
  const { areas: _areas, ...legacy } = navigation(true);
  void _areas;
  await mockNavigation(page, { status: 200, body: legacy });
  await page.goto('/?view=journeys&tenant=demo');
  await expect(rail(page).locator('a[data-area]')).toHaveCount(0);
  await expect(rail(page).getByRole('link', { name: 'Journeys' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('navigation', { name: 'Journeys' })).toBeVisible();
});

for (const width of [390, 768, 1440]) {
  test(`#861: Console header and navigation at ${width}px in both TH/EN`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockNavigation(page, { status: 200, body: homeNavigation(['admin']) });
    await page.goto('/?view=journeys&tenant=demo');
    for (const language of ['ไทย', 'English']) {
      await page.getByRole('button', { name: language, exact: true }).click();
      const user = page.getByRole('button', { name: /เมนูผู้ใช้|User menu/ });
      await expect(user).toBeInViewport({ ratio: 1 });
      await user.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(user).toBeFocused();
      if (width <= 768) {
        await expect(
          page.getByRole('navigation', { name: /เมนูหลัก|Main navigation/ }),
        ).toBeHidden();
        const trigger = page.getByRole('button', { name: /เปิดเมนูนำทาง|Open navigation/ });
        await trigger.click();
        await expect(
          page.getByRole('navigation', { name: /เมนูหลัก|Main navigation/ }),
        ).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
      }
      await page.screenshot({
        path: test
          .info()
          .outputPath(`console-${width}-${language === 'English' ? 'en' : 'th'}.png`),
        fullPage: true,
      });
    }
  });
}
