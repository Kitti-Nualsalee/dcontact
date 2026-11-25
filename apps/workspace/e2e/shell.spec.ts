import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { homeNavigation } from '../../console/e2e/support/home-navigation.js';

/**
 * D1.13 (#452): flag `ui.shell.v2` of Workspace — the shell decides before WorkspaceApp mounts
 * and switching language in the shell must not remount WorkspaceApp (ADR-026: never cut the call/WS)
 */
test.use({ locale: 'th-TH' });

function navigation(shellV2: boolean) {
  return {
    groups: [
      { id: 'live', labelKey: 'navigation.groups.live' },
      { id: 'automation', labelKey: 'navigation.groups.automation' },
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
    ],
    // #651: work areas on the rail (Workspace has no submenu — D1.2)
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
    ],
    pins: { appIds: ['agent-workspace', 'journeys'], source: 'TENANT', revision: 0 },
    limits: { maxPins: 15 },
    features: { shellV2 },
  };
}

async function mockApis(page: Page, shellV2: boolean) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation(shellV2) }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: {
          id: 'agent-1000',
          displayName: 'สมชาย ใจดี',
          extension: '1000',
          state: 'AVAILABLE',
        },
        interaction: null,
      },
    }),
  );
}

const rail = (page: Page) => page.getByRole('navigation', { name: /เมนูหลัก|Main navigation/ });

test('#860: the customer area from Workspace opens Console with the language and tenant', async ({
  page,
}) => {
  await mockApis(page, true);
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: homeNavigation(['admin']) }),
  );
  await page.goto('/?tenant=demo');
  const customers = rail(page).getByRole('link', { name: /ลูกค้า/ });
  await expect(customers).toHaveAttribute(
    'href',
    'http://localhost:5174/?view=customers&tenant=demo',
  );
  await expect(customers).toHaveAttribute('target', '_blank');
  await rail(page).getByRole('button', { name: 'แอปทั้งหมด' }).click();
  const launcher = page.getByRole('dialog', { name: 'แอป D-Contact' });
  await expect(launcher.getByRole('link', { name: /ภาพรวมข้อมูลลูกค้า/ })).toBeVisible();
  await expect(launcher.getByRole('link', { name: /กฎข้อมูล/ })).toBeVisible();
  await expect(launcher.getByRole('link', { name: /กิจกรรมลูกค้า/ })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'English' }).click();
  await expect(rail(page).getByRole('link', { name: /Customers/ })).toBeVisible();
  await rail(page).getByRole('button', { name: 'All apps' }).click();
  const englishLauncher = page.getByRole('dialog', { name: 'D-Contact apps' });
  await expect(englishLauncher.getByRole('link', { name: /Customer overview/ })).toBeVisible();
  await expect(englishLauncher.getByRole('link', { name: /Data rules/ })).toBeVisible();
  await expect(englishLauncher.getByRole('link', { name: /Customer activity/ })).toBeVisible();
});

test('flag off → the old Workspace has no rail', async ({ page }) => {
  await mockApis(page, false);
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(rail(page)).toHaveCount(0);
});

test('flag on → the rail has no SubNav, Journeys opens a new tab to Console, and the shell axe passes', async ({
  page,
}) => {
  await mockApis(page, true);
  await page.goto('/?tenant=demo');
  await expect(rail(page)).toBeVisible();
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(2); // rail + breadcrumb (no SubNav)
  const journeys = rail(page).getByRole('link', { name: /Journeys/ });
  await expect(journeys).toHaveAttribute(
    'href',
    'http://localhost:5174/?view=journeys&tenant=demo',
  );
  await expect(journeys).toHaveAttribute('target', '_blank');
  await expect(rail(page).getByRole('link', { name: 'พื้นที่ทำงาน' })).toHaveAttribute(
    'aria-current',
    'page',
  );

  const axe = await new AxeBuilder({ page }).include('nav').include('header').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
});

test('#651: the rail shows work areas from the Navigation API and Workspace still has no submenu', async ({
  page,
}) => {
  await mockApis(page, true);
  await page.goto('/?tenant=demo');
  const areas = rail(page).locator('a[data-area]');
  await expect(areas).toHaveCount(2);
  expect(await areas.evaluateAll((els) => els.map((el) => el.getAttribute('data-area')))).toEqual([
    'workspace',
    'journeys',
  ]);
  await expect(rail(page).locator('a[aria-current=page]')).toHaveAttribute(
    'data-area',
    'workspace',
  );
  // the Console area opens a new tab (ADR-026 item 3) — the link has only the path + tenant, no PII
  const consoleArea = rail(page).locator('a[data-area=journeys]');
  await expect(consoleArea).toHaveAttribute('target', '_blank');
  await expect(consoleArea).toHaveAttribute(
    'href',
    'http://localhost:5174/?view=journeys&tenant=demo',
  );
  // D1.2: Workspace has no SubNav — only the rail + breadcrumb
  await expect(page.getByRole('navigation')).toHaveCount(2);
});

test('flag on → switching language neither reloads nor remounts WorkspaceApp', async ({ page }) => {
  await mockApis(page, true);
  await page.goto('/?tenant=demo');
  const agentName = page.getByText('สมชาย ใจดี');
  await expect(agentName).toBeVisible();
  const before = await page.evaluate(() => performance.timeOrigin);
  // marker on the WorkspaceApp DOM node — if it remounts the new node has no marker
  await agentName.evaluate(
    (el) => ((el as HTMLElement & { __d113?: string }).__d113 = 'same-node'),
  );

  await page.getByRole('button', { name: 'English' }).click();
  await expect(rail(page).getByRole('link', { name: 'Workspace' })).toBeVisible();
  await page.getByRole('button', { name: 'ไทย' }).click();
  await expect(rail(page).getByRole('link', { name: 'พื้นที่ทำงาน' })).toBeVisible();

  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
  expect(await agentName.evaluate((el) => (el as HTMLElement & { __d113?: string }).__d113)).toBe(
    'same-node',
  );
});

/**
 * #588: user menu — the harness user is "Workspace Tester" (agent); sign-outs are counted in `__signOuts`
 */
const userMenu = (page: Page) => page.getByRole('button', { name: 'เมนูผู้ใช้ Workspace Tester' });
const signOuts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __signOuts?: number }).__signOuts ?? 0);

test('flag off → no user menu, and the old sign-out button stays in the status bar', async ({
  page,
}) => {
  await mockApis(page, false);
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await expect(userMenu(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toBeVisible();
});

test('flag on → the user menu shows name/organization/role, there is no duplicate sign-out button, and with no call you can sign out at once', async ({
  page,
}) => {
  await mockApis(page, true);
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  // the old button in the status bar is hidden — sign out only at the user menu
  await expect(page.getByRole('button', { name: 'ออกจากระบบ' })).toHaveCount(0);
  await userMenu(page).click();
  await expect(page.getByRole('menu')).toHaveAccessibleName(
    /Workspace Tester.*workspace-e2e@demo\.example.*องค์กร demo.*เอเจนต์/,
  );
  // AC5 (#598): "My account" opens Console in a new tab — Workspace does not remount during a call (ADR-026)
  const account = page.getByRole('menuitem', { name: 'บัญชีของฉัน' });
  await expect(account).toHaveAttribute('href', 'http://localhost:5174/?tenant=demo&view=account');
  await expect(account).toHaveAttribute('target', '_blank');
  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await signOuts(page)).toBe(1);
});

test('flag on → with an unsaved wrap-up, confirm before signing out, and after cancelling the wrap-up is still there', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation(true) }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: { id: 'agent-1000', displayName: 'สมชาย ใจดี', extension: '1000', state: 'ACW' },
        interaction: {
          id: '9a8a5477-aa53-4254-ae68-a21ab64cc2bb',
          state: 'WRAPUP',
          version: '19',
          caller: '081-234-5678',
          queue: { id: 'queue-service', name: 'บริการลูกค้า' },
          offerExpiresAt: null,
          answeredAt: '2026-09-06T10:00:00.000Z',
          endedAt: '2026-09-06T10:03:00.000Z',
        },
      },
    }),
  );
  await page.goto('/?tenant=demo');
  const wrapup = page.getByRole('heading', { name: 'สรุปผลหลังสาย' });
  await expect(wrapup).toBeVisible();

  await userMenu(page).click();
  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'ออกจากระบบทั้งที่ยังมีงานค้าง?' });
  await expect(dialog).toContainText('wrap-up ที่ยังไม่บันทึกจะหายไป');
  await dialog.getByRole('button', { name: 'ยกเลิก' }).click();
  await expect(dialog).toBeHidden();
  await expect(wrapup).toBeVisible();
  expect(await signOuts(page)).toBe(0);
});

test('#588: with a call offered (ASSIGNED) even though dphone is not yet ringing, confirm before signing out', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation(true) }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: {
          id: 'agent-1000',
          displayName: 'สมชาย ใจดี',
          extension: '1000',
          state: 'RESERVED',
        },
        interaction: {
          id: 'interaction-offer-2',
          state: 'ASSIGNED',
          version: '3',
          caller: '081-234-5678',
          queue: { id: 'queue-service', name: 'บริการลูกค้า' },
          offerExpiresAt: '2099-01-01T00:00:20.000Z',
          answeredAt: null,
          endedAt: null,
        },
      },
    }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByText('สมชาย ใจดี')).toBeVisible();
  await userMenu(page).click();
  await page.getByRole('menuitem', { name: 'ออกจากระบบ' }).click();
  await expect(
    page.getByRole('alertdialog', { name: 'ออกจากระบบทั้งที่ยังมีงานค้าง?' }),
  ).toBeVisible();
  expect(await signOuts(page)).toBe(0);
});

for (const width of [390, 768, 950, 1280, 1440]) {
  test(`Workspace TopBar user menu works at ${width}px in both Thai and English`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    await mockApis(page, true);
    await page.goto('/?tenant=demo');
    for (const [language, triggerName] of [
      ['ไทย', /เมนูผู้ใช้/],
      ['English', /User menu/],
    ] as const) {
      await page.getByRole('button', { name: language, exact: true }).click();
      const trigger = page.getByRole('button', { name: triggerName });
      await expect(trigger).toBeInViewport({ ratio: 1 });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      const main = page.locator('#dc-main');
      const child = await page.getByText('สมชาย ใจดี', { exact: true }).elementHandle();
      const original = await main.elementHandle();
      if (width <= 768) {
        const navigation = page.getByRole('button', { name: /เปิดเมนูนำทาง|Open navigation/ });
        await navigation.click();
        await expect(rail(page)).toBeVisible();
        await page.keyboard.press('Escape');
        await expect(navigation).toBeFocused();
        expect(
          await original!.evaluate((node) => node === document.getElementById('dc-main')),
        ).toBe(true);
      }
      if (width <= 768) {
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.setViewportSize({ width, height: 900 });
      }
      expect(await child!.evaluate((node) => node.isConnected)).toBe(true);
      await page.screenshot({
        path: test
          .info()
          .outputPath(`workspace-${width}-${language === 'English' ? 'en' : 'th'}.png`),
        fullPage: true,
      });
    }
  });
}
