import AxeBuilder from '@axe-core/playwright';
import { expect, test } from './fixtures';
import type { Page } from '@playwright/test';
import { th } from './catalog';
import { bothLocales, escapeRegExp } from './locale-match';

/**
 * Agent Workspace in the shell (`ui.shell.v2`) per V3 (mockups/d-contact-agent-workspace-v3.html):
 * work list · current work (call bar + Voice tab) · work panel (summary/details/events/readiness) · tool bar
 * with Voice data from the snapshot only — no placeholder customer panel (Cus360 C5 #795)
 * `D813_EVIDENCE_DIR=<dir>` = save evidence screenshots for the PR
 */
test.use({ locale: 'th-TH', viewport: { width: 1440, height: 900 } });
const durationLabel = th('workspace:layout.duration', { duration: '' }).trim();

type Interaction = Record<string, unknown> | null;

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

async function open(page: Page, interaction: Interaction, agentState = 'AVAILABLE') {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({ status: 200, json: navigation }),
  );
  await page.route('**/api/v1/workspace/agent/snapshot', (route) =>
    route.fulfill({
      status: 200,
      json: {
        agent: {
          id: 'agent-1000',
          displayName: 'Somchai Jaidee',
          extension: '1000',
          state: agentState,
        },
        interaction,
      },
    }),
  );
  await page.goto('/?tenant=demo');
  await expect(page.getByText('Somchai Jaidee')).toBeVisible();
}

const call = (overrides: Record<string, unknown>) => ({
  id: '3f0c6c55-9a3e-4a51-9f53-0d7d1d3b8a21',
  state: 'ACTIVE',
  direction: 'INBOUND',
  version: '7',
  caller: '081-234-5678',
  queue: { id: 'queue-service', name: 'Customer Service' },
  offerExpiresAt: null,
  answeredAt: new Date(Date.now() - 95_000).toISOString(),
  endedAt: null,
  ...overrides,
});

const work = (page: Page) =>
  page.getByRole('region', { name: new RegExp(`^${bothLocales('workspace:layout.work')}$`) });
const current = (page: Page) =>
  page.getByRole('region', { name: new RegExp(`^${bothLocales('workspace:layout.current')}$`) });
const inspector = (page: Page) =>
  page.getByRole('complementary', {
    name: new RegExp(`^${bothLocales('workspace:layout.inspector.label')}$`),
  });
const readiness = (page: Page) =>
  page.getByRole('region', { name: new RegExp(`^${bothLocales('workspace:layout.readiness')}$`) });

async function evidence(page: Page, name: string) {
  const dir = process.env.D813_EVIDENCE_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}.png` });
}

async function expectNoSeriousAxe(page: Page) {
  const axe = await new AxeBuilder({ page }).include('main').analyze();
  expect(
    axe.violations
      .filter((v) => v.impact === 'serious' || v.impact === 'critical')
      .map((v) => v.id),
  ).toEqual([]);
}

test('no work → work list · current work · work panel in left-to-right order, and the work panel opens at readiness', async ({
  page,
}) => {
  await open(page, null);
  await expect(work(page)).toContainText(th('workspace:layout.workEmpty'));
  await expect(current(page)).toContainText(th('workspace:layout.noCurrent'));
  await expect(
    inspector(page).getByRole('tab', { name: th('workspace:layout.inspector.tabs.readiness') }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect(
    readiness(page).getByRole('heading', { name: th('workspace:media.title') }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: new RegExp(bothLocales('workspace:case.customer')) }),
  ).toHaveCount(0);

  const [left, middle, right] = await Promise.all(
    [work(page), current(page), inspector(page)].map((region) => region.boundingBox()),
  );
  expect(left!.x).toBeLessThan(middle!.x);
  expect(middle!.x).toBeLessThan(right!.x);
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-idle');
});

test('during a call → the work is in the list and call bar, call time ticks, events show the answered call', async ({
  page,
}) => {
  await open(page, call({}), 'BUSY');
  await expect(work(page).getByRole('listitem')).toContainText('081-234-5678');
  await expect(work(page).getByRole('listitem')).toContainText(
    `${th('workspace:layout.state.ACTIVE')} · Customer Service`,
  );
  await expect(
    work(page).getByRole('tab', { name: th('workspace:layout.list.open', { count: 1 }) }),
  ).toBeVisible();
  await expect(current(page)).toContainText(
    `${th('workspace:layout.direction.INBOUND')} · Customer Service · ${th('workspace:layout.inDphone')}`,
  );
  const timer = current(page).getByRole('timer');
  await expect(timer).toHaveText(new RegExp(`${escapeRegExp(durationLabel)} 0[1-9]:\\d\\d`));
  const first = await timer.textContent();
  await expect(timer).not.toHaveText(first!);

  // no Cus360 capability in the snapshot → only the Voice tab, no empty customer tab
  await expect(current(page).getByRole('tab', { name: 'Voice' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(current(page).getByRole('tab', { name: 'Customer 360' })).toHaveCount(0);
  // opening a new page during a call, audio devices not checked yet → the work panel opens at readiness so they can be checked first
  await expect(
    inspector(page).getByRole('tab', { name: th('workspace:layout.inspector.tabs.readiness') }),
  ).toHaveAttribute('aria-selected', 'true');
  await inspector(page)
    .getByRole('tab', { name: th('workspace:layout.inspector.tabs.details') })
    .click();
  await expect(
    inspector(page).getByRole('heading', { name: th('workspace:authority.title') }),
  ).toBeVisible();
  await inspector(page)
    .getByRole('tab', { name: th('workspace:layout.inspector.tabs.events') })
    .click();
  await expect(
    inspector(page)
      .getByRole('listitem')
      .filter({ hasText: th('workspace:layout.event.answered') }),
  ).toBeVisible();
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-call');
});

test('WRAPUP → the work panel opens the summary tab itself, and can switch to view events', async ({
  page,
}) => {
  await open(
    page,
    call({ state: 'WRAPUP', endedAt: new Date(Date.now() - 5_000).toISOString() }),
    'ACW',
  );
  const tab = inspector(page).getByRole('tab', {
    name: th('workspace:layout.inspector.tabs.wrapup'),
  });
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  await expect(
    inspector(page).getByRole('heading', { name: th('workspace:wrapup.title') }),
  ).toBeVisible();
  await expect(current(page).getByRole('timer')).toHaveText(
    new RegExp(`${escapeRegExp(durationLabel)} 01:3\\d`),
  );
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-th-wrapup');

  await inspector(page)
    .getByRole('tab', { name: th('workspace:layout.inspector.tabs.events') })
    .click();
  await expect(
    inspector(page)
      .getByRole('listitem')
      .filter({ hasText: th('workspace:layout.event.ended') }),
  ).toBeVisible();
  await work(page)
    .getByRole('tab', { name: th('workspace:layout.list.closed', { count: 0 }) })
    .click();
  await expect(work(page)).toContainText(th('workspace:layout.list.closedEmpty'));
});

test('EN → text in every panel changes with the language without a reload', async ({ page }) => {
  await open(page, call({}), 'BUSY');
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(work(page).getByRole('heading', { name: 'My work' })).toBeVisible();
  await expect(current(page)).toContainText('Inbound · Customer Service · Call controls in dphone');
  await expect(current(page).getByRole('timer')).toHaveText(/Call time \d\d:\d\d/);
  await inspector(page).getByRole('tab', { name: 'Readiness' }).click();
  await expect(
    readiness(page).getByRole('heading', { name: 'Prepare audio device' }),
  ).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
  await expectNoSeriousAxe(page);
  await evidence(page, 'workspace-en-call');
});

test('close/open the work panel from the tool bar, and resize the list with the keyboard', async ({
  page,
}) => {
  await open(page, call({}), 'BUSY');
  const tools = page.getByRole('toolbar', { name: th('workspace:layout.utility') });
  await tools.getByRole('button', { name: th('workspace:layout.inspector.close') }).click();
  await expect(inspector(page)).toHaveCount(0);
  await tools.getByRole('button', { name: th('workspace:layout.inspector.tabs.events') }).click();
  await expect(
    inspector(page).getByRole('tab', { name: th('workspace:layout.inspector.tabs.events') }),
  ).toHaveAttribute('aria-selected', 'true');

  const separator = page.getByRole('separator', { name: th('workspace:layout.resize.list') });
  const before = (await work(page).boundingBox())!.width;
  await separator.focus();
  await page.keyboard.press('ArrowRight');
  await expect(separator).toHaveAttribute('aria-valuenow', '276');
  expect((await work(page).boundingBox())!.width).toBeGreaterThan(before);
  await separator.dblclick();
  await expect(separator).toHaveAttribute('aria-valuenow', '260');
});

test('screens narrower than 1200px → panels stack top to bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 900 });
  await open(page, call({}), 'BUSY');
  const [left, middle, right] = await Promise.all(
    [work(page), current(page), inspector(page)].map((region) => region.boundingBox()),
  );
  expect(middle!.x).toBe(left!.x);
  expect(right!.x).toBe(left!.x);
  expect(left!.y).toBeLessThan(middle!.y);
  expect(middle!.y).toBeLessThan(right!.y);
  await expect(page.getByRole('separator')).toHaveCount(0);
});
