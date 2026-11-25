import AxeBuilder from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { homeNavigation } from './support/home-navigation.js';
import { th } from './support/catalog';

function escapeRegExp(text: string) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

test.use({ locale: 'th-TH', viewport: { width: 1440, height: 1024 } });

test('Home is the default, rail active, sidebar and the menu open the destination per host with the tenant', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const nav = homeNavigation();
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: nav }));
  await page.goto('/?tenant=demo');
  await expect(page.getByRole('heading', { name: th('home:title') })).toBeVisible();
  // Home shows one item per app the server allows, except Home itself
  await expect(page.locator('.home__entry')).toHaveCount(
    nav.apps.filter((app) => app.id !== 'home').length,
  );
  await expect(
    page.locator('header').getByRole('navigation', { name: th('ui:shell.breadcrumb') }),
  ).toHaveCount(0);
  await expect(
    page.locator('#dc-main').getByRole('navigation', { name: th('ui:shell.breadcrumb') }),
  ).toBeVisible();
  await expect(page.locator('a[data-area=home]')).toHaveAttribute('aria-current', 'page');
  const systems = page
    .locator('header')
    .getByRole('navigation', { name: th('common:shell.liveSystems') });
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
  await expect(sidebar.getByText(th('home:nav'), { exact: true })).toHaveCount(0);
  await expect(sidebar.getByText(th('common:shell.pinned'), { exact: true })).toBeVisible();
  const pinned = sidebar
    .locator('div')
    .filter({ has: page.getByText(th('common:shell.pinned'), { exact: true }) })
    .last();
  await expect(
    pinned.getByRole('link', {
      name: new RegExp(escapeRegExp(th('common:navigation.apps.agentWorkspace'))),
    }),
  ).toHaveAttribute('href', 'http://localhost:5173/?tenant=demo');
  await expect(
    pinned.getByRole('link', {
      name: new RegExp(escapeRegExp(th('common:navigation.apps.agentWorkspace'))),
    }),
  ).toHaveAttribute('target', '_blank');
  await expect(
    sidebar.getByRole('link', { name: th('common:navigation.apps.home'), exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await expect(
    sidebar.getByRole('link', { name: th('common:shell.account.mine') }),
  ).toHaveAttribute('href', '/?view=account&tenant=demo');
  const inbox = page.getByRole('link', {
    name: new RegExp(escapeRegExp(th('home:names.agent-workspace').replace(/\)$/, ''))),
  });
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
    await page
      .getByRole('button', { name: lang === 'EN' ? 'English' : th('ui:shell.languageNames.th') })
      .click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      lang === 'EN' ? 'What would you like to do today?' : th('home:title'),
    );
    await expect(
      sidebar.getByText(lang === 'EN' ? 'Pinned' : th('common:shell.pinned'), { exact: true }),
    ).toBeVisible();
    await expect(
      sidebar.getByText(lang === 'EN' ? 'Workspaces' : th('home:nav'), { exact: true }),
    ).toHaveCount(0);
    const axe = await new AxeBuilder({ page }).analyze();
    expect(
      axe.violations
        .filter((v) => ['critical', 'serious'].includes(v.impact ?? ''))
        .map((v) => v.id),
    ).toEqual([]);
  }
  // a deep link to Journeys is not intercepted by Home and can go back
  await page.route('**/api/v1/journey-authoring/**', (route) =>
    route.fulfill({ json: { items: [], nextCursor: null } }),
  );
  await journey.click();
  await expect(page).toHaveURL(/view=journeys/);
  await expect(page.locator('a[data-area=journeys]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByText(th('common:shell.pinned'), { exact: true })).toHaveCount(0);
  await page.goBack();
  await expect(page.getByRole('heading', { name: th('home:title') })).toBeVisible();
  expect(errors).toEqual([]);
});

test('compliance permission sees only Governance across the page and sidebar, revealing no other app', async ({
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
  await expect(page.getByRole('heading', { name: th('home:live'), exact: true })).toHaveCount(0);
  await expect(
    page.locator('header').getByRole('link', { name: /^(Workspace|Supervisor)/ }),
  ).toHaveCount(0);
});

test('a plan that disables modules still keeps the Voice catalog per the registry, and Home does not depend on pins', async ({
  page,
}) => {
  const nav = homeNavigation(['admin'], true, {});
  nav.pins.appIds = [];
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: nav }));
  await page.goto('/?tenant=demo');
  await expect(page.locator('.home__entry')).toHaveCount(
    nav.apps.filter((app) => app.id !== 'home').length,
  );
  await expect(page.getByText(th('common:shell.pinned'), { exact: true })).toHaveCount(0);
  await expect(
    page.locator('.home__entry').filter({ hasText: th('home:names.voice-routing') }),
  ).toHaveAttribute('href', '/?view=voice-routing&tenant=demo');
  await expect(page.locator('a[data-area=home]')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('heading', { name: th('home:manage'), exact: true })).toHaveCount(1);
});

test('with the shell flag off the menu the server allows still shows, with language and account switching', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ json: homeNavigation(['agent'], false) }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.locator('.home__entry')).toHaveCount(2);
  await expect(page.getByRole('navigation', { name: th('ui:shell.mainNav') })).toHaveCount(0);
  await expect(
    page.locator('header').getByRole('navigation', { name: th('ui:shell.breadcrumb') }),
  ).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: th('ui:shell.breadcrumb') })).toBeVisible();
  await page.getByRole('button', { name: 'English' }).click();
  await expect(
    page.getByRole('heading', { name: 'What would you like to do today?' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'User menu Console Tester' }).click();
  await expect(page.getByRole('menuitem', { name: 'My account' })).toBeVisible();
});

test('an API failure does not guess the menu, try again recovers', async ({ page }) => {
  let fail = true;
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill(fail ? { status: 503, json: {} } : { json: homeNavigation(['agent']) }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByRole('heading', { name: th('home:error') })).toBeVisible();
  await expect(page.locator('.home__entry')).toHaveCount(0);
  fail = false;
  await page.getByRole('button', { name: th('home:retry') }).click();
  await expect(page.locator('.home__entry')).toHaveCount(2);
});

test('an empty list shows how to request permission, with no empty category or guessed menu', async ({
  page,
}) => {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ json: homeNavigation([]) }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByRole('heading', { name: th('home:empty') })).toBeVisible();
  await expect(page.locator('.home__entry')).toHaveCount(0);
  await expect(page.locator('.home__group')).toHaveCount(0);
});

test('an older API with no areas still uses Home and the menu links', async ({ page }) => {
  const { areas, ...legacy } = homeNavigation();
  void areas;
  legacy.apps = legacy.apps.filter((app) => app.id !== 'home');
  legacy.pins.appIds = legacy.pins.appIds.filter((id) => id !== 'home');
  await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: legacy }));
  await page.goto('/?tenant=demo');
  await expect(page.locator('.home__entry')).toHaveCount(legacy.apps.length);
  await expect(
    page
      .locator('.home-sidebar')
      .getByRole('link', { name: th('common:navigation.apps.home'), exact: true }),
  ).toHaveAttribute('aria-current', 'page');
});

for (const shellV2 of [true, false]) {
  test(`Home on a narrow screen does not overflow horizontally (shellV2=${shellV2})`, async ({
    page,
  }) => {
    const nav = homeNavigation(['admin'], shellV2);
    await page.route('**/api/v1/me/navigation', (route) => route.fulfill({ json: nav }));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/?tenant=demo');
    await expect(page.locator('.home__entry')).toHaveCount(
      nav.apps.filter((app) => app.id !== 'home').length,
    );
    await expect(page.getByRole('button', { name: 'English' })).toBeInViewport();
    await expect(
      page.getByRole('button', { name: th('ui:userMenu.open', { name: 'Console Tester' }) }),
    ).toBeInViewport();
    await expect(page.locator('header').getByRole('link', { name: /^Workspace/ })).toBeInViewport();
    await expect(
      page.locator('header').getByRole('link', { name: /^Supervisor/ }),
    ).toBeInViewport();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true);
  });
}
