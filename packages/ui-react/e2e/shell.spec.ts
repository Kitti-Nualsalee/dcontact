import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { en, th } from './catalog';
import { anyOf, escapeRegExp, pen, pth } from './preview-catalog';

/**
 * D1.13 (#452) acceptance: axe 0 serious/critical, rail/launcher keyboard, and no PII in cross-app URLs
 * the `?view=shell` page uses a simulated Navigation API (maxPins = 3) through `useShellNavigation`
 */
// display name and initials of the claims fixture in preview/shell-demo.tsx
const USER_NAME = 'สมชาย ใจดี'; // allow-thai: fixture in preview/shell-demo.tsx
const USER_INITIALS = 'สจ'; // allow-thai: initials of the fixture name

async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`);
}

const rail = (page: Page) =>
  page.getByRole('navigation', { name: anyOf(th('shell.mainNav'), en('shell.mainNav')) });

for (const lang of ['th', 'en'] as const) {
  test(`axe: shell 0 serious/critical (${lang}) both normally and with the launcher open`, async ({
    page,
  }) => {
    await page.goto(`/?view=shell&lang=${lang}`);
    await expect(rail(page)).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page
      .getByRole('button', { name: lang === 'th' ? th('shell.allApps') : en('shell.allApps') })
      .click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('rail: pins in order, the current page has aria-current, and the other app opens a new tab with path + tenant only', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  const links = rail(page).getByRole('link');
  await expect(links).toHaveCount(3); // Inbox, Journeys, Settings
  const inbox = rail(page).getByRole('link', {
    name: new RegExp(escapeRegExp(pth('shellDemo.apps.agentWorkspace'))),
  });
  await expect(inbox).toHaveAttribute('target', '_blank');
  await expect(inbox).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(inbox).toHaveAttribute('href', 'https://workspace.example/?tenant=demo');
  await expect(inbox).toHaveAccessibleName(new RegExp(escapeRegExp(th('shell.opensInNewTab'))));
  const journeys = rail(page).getByRole('link', { name: 'Journeys' });
  await expect(journeys).toHaveAttribute('aria-current', 'page');
  await expect(journeys).toHaveAttribute('href', '/?view=journeys&tenant=demo');
  await expect(journeys).not.toHaveAttribute('target', /.*/);
});

test('keyboard: the skip link goes to the content', async ({ page }) => {
  await page.goto('/?view=shell');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: th('shell.skipToContent') });
  await expect(skip).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('#dc-main')).toBeFocused();
});

test('keyboard: opens the launcher with Enter, focus on the search field, search works, Esc closes and focus returns to the button', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  const trigger = page.getByRole('button', { name: th('shell.allApps') });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: th('launcher.title') });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('searchbox')).toBeFocused();

  await page.keyboard.type('gov');
  await expect(dialog.getByRole('link')).toHaveCount(2); // Governance + Create Journey
  await expect(dialog.getByRole('link', { name: 'Governance' })).toBeVisible();
  await page.keyboard.type('zzz');
  await expect(dialog.getByRole('status').first()).toHaveText(th('launcher.noMatch'));

  await page.keyboard.press('Escape'); // clear the search
  await page.keyboard.press('Escape'); // close the launcher
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('keyboard: pinning with Space → rail updates, PUT sends expectedRevision, and nothing more can be pinned once the cap is reached', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  await page.getByRole('button', { name: th('shell.allApps') }).click();
  const pinGovernance = page.getByRole('button', {
    name: th('launcher.pin', { app: 'Governance' }),
  });
  await pinGovernance.focus();
  await page.keyboard.press('Space');
  await expect(
    page.getByRole('button', { name: th('launcher.unpin', { app: 'Governance' }) }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(rail(page).getByRole('link', { name: 'Governance' })).toBeVisible();

  const put = await page.evaluate(() =>
    (
      window as unknown as { __navRequests: { method: string; body: unknown }[] }
    ).__navRequests.filter((r) => r.method === 'PUT'),
  );
  expect(put).toEqual([
    {
      url: 'https://api.example/api/v1/me/navigation/pins',
      method: 'PUT',
      body: { appIds: ['agent-workspace', 'journeys', 'contact-governance'], expectedRevision: 0 },
    },
  ]);

  // cap of 3 (mock) — apps not yet pinned are disabled, with a message giving the reason
  await expect(
    page.getByRole('button', {
      name: th('launcher.pin', { app: pth('shellDemo.apps.supervisorWorkspace') }),
    }),
  ).toBeDisabled();
  await expect(page.getByText(th('launcher.pinLimit', { max: 3 }))).toBeVisible();

  // unpin with the keyboard → next revision
  await page.getByRole('button', { name: th('launcher.unpin', { app: 'Governance' }) }).focus();
  await page.keyboard.press('Space');
  await expect(rail(page).getByRole('link', { name: 'Governance' })).toHaveCount(0);
  // PUT requests are sent one at a time — wait for the unpin request queued behind the first, which must use the next revision
  await expect
    .poll(() =>
      page.evaluate(() => {
        const all = (
          window as unknown as {
            __navRequests: { method: string; body: { expectedRevision: number } }[];
          }
        ).__navRequests;
        return all.filter((r) => r.method === 'PUT').at(-1)!.body.expectedRevision;
      }),
    )
    .toBe(1);
});

test('switching the language in the top bar changes the rail/launcher labels immediately without a reload', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  const origin = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByRole('button', { name: 'English' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(rail(page).getByRole('link', { name: /Inbox/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'All apps' })).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(origin);
});

test('rapid pin/unpin presses — requests are sent one at a time with the latest revision, never collide, and no pin is lost', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  await page.getByRole('button', { name: th('shell.allApps') }).click();
  // two clicks in a row while the first PUT has not been answered (the mock delays 150ms)
  await page
    .getByRole('button', { name: th('launcher.pin', { app: 'Governance' }), exact: true })
    .click();
  await page
    .getByRole('button', { name: th('launcher.unpin', { app: 'Journeys' }), exact: true })
    .click();
  // the launcher is a modal popover — close it before checking the rail (the rest of the page is hidden from the a11y tree while open)
  await page.keyboard.press('Escape');
  await expect(rail(page).getByRole('link', { name: 'Governance' })).toBeVisible();
  await expect(rail(page).getByRole('link', { name: 'Journeys' })).toHaveCount(0);

  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (window as unknown as { __navRequests: { method: string }[] }).__navRequests.filter(
            (r) => r.method === 'PUT',
          ).length,
      ),
    )
    .toBeGreaterThanOrEqual(1);
  // wait for the queue to drain, then check that the server got the final set with no 409 along the way
  await page.waitForTimeout(300);
  const puts = await page.evaluate(() =>
    (
      window as unknown as {
        __navRequests: { method: string; body: { appIds: string[]; expectedRevision: number } }[];
      }
    ).__navRequests
      .filter((r) => r.method === 'PUT')
      .map((r) => r.body),
  );
  expect(puts.map((body) => body.expectedRevision)).toEqual(puts.map((_, index) => index));
  expect(puts.at(-1)!.appIds).toEqual(['agent-workspace', 'contact-governance']);
  // no 409 → no new navigation load after the first PUT
  const methods = await page.evaluate(() =>
    (window as unknown as { __navRequests: { method: string }[] }).__navRequests.map(
      (r) => r.method,
    ),
  );
  expect(methods.slice(methods.indexOf('PUT'))).not.toContain('GET');
});

/**
 * #588 acceptance: user menu on the top bar — keyboard, axe, narrow screen, confirmation before sign-out during a call, and no link to Keycloak
 * the demo page uses simulated claims (a Thai display name, supervisor + agent + offline_access) and counts sign-outs in `__signOuts`
 */
const userTrigger = (page: Page) =>
  page.getByRole('button', {
    name: anyOf(th('userMenu.open', { name: '' }).trim(), en('userMenu.open', { name: '' }).trim()),
  });
const signOuts = (page: Page) =>
  page.evaluate(() => (window as unknown as { __signOuts?: number }).__signOuts ?? 0);

for (const lang of ['th', 'en'] as const) {
  test(`axe: user menu 0 serious/critical (${lang}) for both the menu and the confirmation dialog`, async ({
    page,
  }) => {
    await page.goto(`/?view=shell&lang=${lang}&signout=confirm`);
    await userTrigger(page).click();
    await expect(page.getByRole('menu')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
    await page
      .getByRole('menuitem', { name: anyOf(th('userMenu.signOut'), en('userMenu.signOut')) })
      .click();
    await expect(page.getByRole('alertdialog')).toBeVisible();
    expect(await seriousViolations(page)).toEqual([]);
  });
}

test('user menu: opens with Enter, the menu reads name/email/organization/role, Esc closes and focus returns to the button', async ({
  page,
}) => {
  await page.goto('/?view=shell');
  const trigger = page.getByRole('button', { name: th('userMenu.open', { name: USER_NAME }) });
  await expect(trigger).toContainText(USER_INITIALS);
  await expect(trigger).toContainText(USER_NAME);
  await trigger.focus();
  await page.keyboard.press('Enter');
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  await expect(menu).toHaveAccessibleName(
    new RegExp(
      [
        USER_NAME,
        'somchai@demo.example',
        th('userMenu.organization', { organization: 'demo' }),
        th('userMenu.roles.supervisor'),
        th('userMenu.roles.agent'),
      ]
        .map(escapeRegExp)
        .join('.*'),
    ),
  );
  await expect(page.getByText('offline_access')).toHaveCount(0);
  // AC5 (#598): "My account" comes before "Sign out" and points to the D-Contact page (new tab, like Workspace)
  const account = page.getByRole('menuitem', { name: th('userMenu.account') });
  await expect(account).toBeFocused();
  await expect(account).toHaveAttribute('href', 'https://console.demo.example/?view=account');
  await expect(account).toHaveAttribute('target', '_blank');
  await expect(account).toHaveAttribute('rel', 'noopener noreferrer');
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('menuitem', { name: th('userMenu.signOut') })).toBeFocused();
  // #588 D3: no link or text that refers to Keycloak
  await expect(page.locator('[data-trigger=MenuTrigger]').getByRole('link')).toHaveCount(0);
  expect((await page.locator('body').innerText()).toLowerCase()).not.toContain('keycloak');

  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await signOuts(page)).toBe(0);
});

test('user menu: signs out immediately when no confirmation is needed', async ({ page }) => {
  await page.goto('/?view=shell');
  await userTrigger(page).click();
  await page.getByRole('menuitem', { name: th('userMenu.signOut') }).click();
  await expect(page.getByRole('alertdialog')).toHaveCount(0);
  expect(await signOuts(page)).toBe(1);
});

test('user menu: during a call it asks for confirmation first — cancel does not sign out and focus returns to the button, confirm signs out', async ({
  page,
}) => {
  await page.goto('/?view=shell&signout=confirm');
  const trigger = userTrigger(page);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown'); // AC5 (#598): skip "My account"
  await page.keyboard.press('Enter'); // choose "Sign out"
  const dialog = page.getByRole('alertdialog', { name: pth('shellDemo.signOutConfirm.title') });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: th('userMenu.cancel') }).click();
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(await signOuts(page)).toBe(0);

  await trigger.click();
  await page.getByRole('menuitem', { name: th('userMenu.signOut') }).click();
  await dialog.getByRole('button', { name: pth('shellDemo.signOutConfirm.confirm') }).click();
  await expect(dialog).toBeHidden();
  expect(await signOuts(page)).toBe(1);
});

test('user menu: a narrow screen leaves the initials circle but the name stays in the aria-label', async ({
  page,
}) => {
  await page.setViewportSize({ width: 640, height: 800 });
  await page.goto('/?view=shell');
  const trigger = page.getByRole('button', { name: th('userMenu.open', { name: USER_NAME }) });
  await expect(trigger).toBeVisible();
  await expect(trigger.getByText(USER_NAME)).toBeHidden();
  await expect(trigger.getByText(USER_INITIALS)).toBeVisible();
});

for (const lang of ['th', 'en'] as const) {
  for (const width of [390, 768, 950, 1280, 1440]) {
    test(`TopBar actions are on screen and open the menu with keyboard at ${width}px (${lang})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?view=shell&lang=${lang}`);
      const header = page.locator('header');
      const menu = userTrigger(page);
      await expect(menu).toBeVisible();
      const bounds = await header.evaluate((element) => ({
        client: element.clientWidth,
        scroll: element.scrollWidth,
      }));
      expect(bounds.scroll).toBeLessThanOrEqual(bounds.client);
      for (const control of await header.locator('a, button').all()) {
        await expect(control).toBeInViewport({ ratio: 1 });
      }
      await menu.focus();
      await page.keyboard.press('Enter');
      await expect(page.getByRole('menu')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(menu).toBeFocused();
    });
  }
}

for (const lang of ['th', 'en'] as const) {
  for (const width of [390, 768]) {
    test(`narrow-screen menu: keyboard, focus and content do not remount at ${width}px (${lang})`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/?view=shell&lang=${lang}`);
      const trigger = page.getByRole('button', {
        name: lang === 'th' ? th('shell.openNavigation') : en('shell.openNavigation'),
      });
      const main = page.locator('#dc-main');
      const original = await main.elementHandle();
      await expect(rail(page)).toBeHidden();
      expect(await main.evaluate((node) => node.clientWidth)).toBeGreaterThanOrEqual(width - 2);
      await trigger.focus();
      await page.keyboard.press('Enter');
      await expect(rail(page)).toBeVisible();
      await expect(trigger).toHaveAttribute('aria-expanded', 'true');
      await page.screenshot({
        path: test.info().outputPath(`drawer-${width}-${lang}.png`),
        fullPage: true,
      });
      await expect(rail(page).getByRole('link', { name: 'Journeys' })).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(rail(page)).toBeHidden();
      await expect(trigger).toBeFocused();
      await trigger.click();
      await page
        .getByRole('link', {
          name: lang === 'th' ? pth('shellDemo.list') : pen('shellDemo.list'),
          exact: true,
        })
        .click();
      await expect(rail(page)).toBeHidden();
      await page.setViewportSize({ width: 1440, height: 900 });
      await expect(rail(page)).toBeVisible();
      await expect(trigger).toBeHidden();
      expect(await original!.evaluate((node) => node === document.getElementById('dc-main'))).toBe(
        true,
      );
      await page.setViewportSize({ width, height: 900 });
      await expect(rail(page)).toBeHidden();
      expect(await original!.evaluate((node) => node === document.getElementById('dc-main'))).toBe(
        true,
      );
      expect(await seriousViolations(page)).toEqual([]);
      await page.screenshot({
        path: test.info().outputPath(`shell-${width}-${lang}.png`),
        fullPage: true,
      });
    });
  }
}

test('#861: focus on a breakpoint change, and Escape in the launcher does not close the navigation menu first', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto('/?view=shell&lang=en');
  const trigger = page.getByRole('button', { name: 'Open navigation' });
  await trigger.click();
  await expect(page.getByRole('button', { name: 'Close navigation' })).toBeFocused();
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect(rail(page).getByRole('link').first()).toBeFocused();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(trigger).toBeFocused();
  await trigger.click();
  await page.getByRole('button', { name: 'All apps' }).click();
  await expect(page.getByRole('dialog', { name: 'D-Contact apps' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Escape');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await expect(trigger).toBeFocused();
});
