import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { th } from './catalog';

/**
 * keyboard order of the right work panel per docs/ui-principles.md item 2 (Tab order follows reading order)
 * work panel: panel header → tab bar (a single Tab) → tab content
 * right tool bar: Tab enters at a single stop and the next Tab leaves the bar; buttons inside use arrow up/down and Home/End
 */
test.use({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });

const navigation = {
  groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
  apps: [
    {
      id: 'agent-workspace',
      groupId: 'live',
      labelKey: 'navigation.apps.agentWorkspace',
      hostApp: 'workspace',
      path: '/',
    },
  ],
  areas: [
    {
      id: 'workspace',
      labelKey: 'navigation.areas.workspace',
      sections: [
        { id: 'work', labelKey: 'navigation.sections.work', items: [{ appId: 'agent-workspace' }] },
      ],
    },
  ],
  pins: { appIds: ['agent-workspace'], source: 'TENANT', revision: 0 },
  limits: { maxPins: 15 },
  features: { shellV2: true },
};

async function openWrapup(page: Page) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: { id: 'agent-1000', displayName: 'Somchai Jaidee', extension: '1000', state: 'ACW' },
        interaction: {
          id: '3f0c6c55-9a3e-4a51-9f53-0d7d1d3b8a21',
          state: 'WRAPUP',
          direction: 'INBOUND',
          version: '7',
          caller: '081-234-5678',
          queue: { id: 'queue-service', name: 'Customer Service' },
          offerExpiresAt: null,
          answeredAt: new Date(Date.now() - 95_000).toISOString(),
          endedAt: new Date(Date.now() - 5_000).toISOString(),
        },
      },
    }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByText('Somchai Jaidee')).toBeVisible();
}

const inspector = (page: Page) =>
  page.getByRole('complementary', { name: th('workspace:layout.inspector.label') });
const tools = (page: Page) => page.getByRole('toolbar', { name: th('workspace:layout.utility') });

/** the part of the page that has focus right now */
function focusedZone(page: Page) {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return 'outside';
    if (el.closest('.aw-v3-inspector-head')) return 'head';
    if (el.closest('.aw-v3-inspector [role="tablist"]')) return 'tabs';
    if (el.closest('.aw-v3-inspector [role="tabpanel"]')) return 'panel';
    if (el.closest('[role="toolbar"]')) return 'toolbar';
    return 'outside';
  });
}

test('Tab in the work panel: panel header → tab bar → content, then skip the tool bar with a single Tab', async ({
  page,
}) => {
  await openWrapup(page);
  await expect(
    inspector(page).getByRole('tab', { name: th('workspace:layout.inspector.tabs.wrapup') }),
  ).toHaveAttribute('aria-selected', 'true');

  await inspector(page)
    .getByRole('button', { name: th('workspace:layout.inspector.close') })
    .focus();
  const zones = [await focusedZone(page)];
  for (let i = 0; i < 30; i += 1) {
    await page.keyboard.press('Tab');
    const zone = await focusedZone(page);
    zones.push(zone);
    if (zone === 'outside') break;
  }
  // collapse adjacent stops in the same section, but count the stops in the tab bar and the tool bar
  const order = zones.filter((zone, i) => zone !== zones[i - 1]);
  expect(order).toEqual(['head', 'tabs', 'panel', 'toolbar', 'outside']);
  expect(zones.filter((zone) => zone === 'tabs')).toHaveLength(1);
  expect(zones.filter((zone) => zone === 'toolbar')).toHaveLength(1);

  // Shift+Tab goes back into the tool bar at a single stop, then back into the tab content
  await page.keyboard.press('Shift+Tab');
  expect(await focusedZone(page)).toBe('toolbar');
  await page.keyboard.press('Shift+Tab');
  expect(await focusedZone(page)).toBe('panel');
});

test('right tool bar: the Tab entry point is the open tab, arrows move within the bar, and Enter switches tabs', async ({
  page,
}) => {
  await openWrapup(page);
  const bar = tools(page);
  const wrapup = bar.getByRole('button', { name: th('workspace:layout.inspector.tabs.wrapup') });
  const events = bar.getByRole('button', { name: th('workspace:layout.inspector.tabs.events') });
  const readiness = bar.getByRole('button', {
    name: th('workspace:layout.inspector.tabs.readiness'),
  });
  const toggle = bar.getByRole('button', { name: th('workspace:layout.inspector.close') });

  // roving tabindex: exactly one button in the Tab order, and it is the open tab
  await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);
  await expect(wrapup).toHaveAttribute('tabindex', '0');

  // button order: open/close panel, summary, ... (other tabs can be added as capabilities allow, e.g. case), events, readiness
  await expect(bar.getByRole('button').nth(1)).toHaveAccessibleName(
    th('workspace:layout.inspector.tabs.wrapup'),
  );
  await wrapup.focus();
  await page.keyboard.press('ArrowDown');
  await expect(bar.getByRole('button').nth(2)).toBeFocused();
  await page.keyboard.press('End');
  await expect(readiness).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(readiness).toBeFocused();
  await page.keyboard.press('Home');
  await expect(toggle).toBeFocused();

  await page.keyboard.press('End');
  await page.keyboard.press('ArrowUp');
  await expect(events).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    inspector(page).getByRole('tab', { name: th('workspace:layout.inspector.tabs.events') }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(events).toHaveAttribute('aria-pressed', 'true');
  await expect(events).toBeFocused();
  await expect(bar.locator('button[tabindex="0"]')).toHaveCount(1);

  // close the panel with the first button, focus stays in the bar, and the same button reopens it
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(inspector(page)).toHaveCount(0);
  const reopen = bar.getByRole('button', { name: th('workspace:layout.inspector.open') });
  await expect(reopen).toBeFocused();
  await page.keyboard.press('Space');
  await expect(inspector(page)).toBeVisible();
});

test('forced-colors: the selected button in the tool bar and the summary-outcome options can be told apart from other buttons', async ({
  page,
}) => {
  await openWrapup(page);
  await page.emulateMedia({ forcedColors: 'active' });
  const background = (target: ReturnType<Page['locator']>) =>
    target.evaluate((element) => getComputedStyle(element).backgroundColor);

  // tool bar: the open tab (summary) must not have the same background as other buttons
  const bar = tools(page);
  const wrapup = bar.getByRole('button', { name: th('workspace:layout.inspector.tabs.wrapup') });
  const events = bar.getByRole('button', { name: th('workspace:layout.inspector.tabs.events') });
  await expect(wrapup).toHaveAttribute('aria-pressed', 'true');
  expect(await background(wrapup)).not.toBe(await background(events));

  // summary-outcome options (.aw-segmented): the selected button must differ from the other
  const choices = page.locator('.aw-segmented button');
  await choices.first().click();
  await expect(choices.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(choices.nth(1)).toHaveAttribute('aria-pressed', 'false');
  expect(await background(choices.first())).not.toBe(await background(choices.nth(1)));
});
