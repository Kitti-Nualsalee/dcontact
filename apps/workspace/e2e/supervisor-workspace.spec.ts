import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { th } from './catalog';
import { escapeRegExp, thRegExp } from './locale-match';

test('a Supervisor sees Team pulse, and a mutation succeeds only after an authoritative snapshot', async ({
  page,
}) => {
  let agentState: 'AVAILABLE' | 'BREAK' = 'AVAILABLE';
  let queueActive = false;
  let agentCommand: Record<string, unknown> | undefined;
  let queueCommand: Record<string, unknown> | undefined;
  await page.route('**/api/v1/workspace/supervisor/snapshot', async (route) => {
    expect(route.request().headers().authorization).toBe('Bearer e2e-access-token');
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sequence: 41,
        agents: [
          {
            id: 'agent-1',
            displayName: 'Somchai Jaidee',
            extension: '1000',
            teamId: 'team-a',
            state: 'BUSY',
          },
          {
            id: 'agent-2',
            displayName: 'Suda Ruadreo',
            extension: '1001',
            teamId: 'team-a',
            state: agentState,
          },
        ],
        queues: [
          { id: 'queue-1', name: 'Customer Service', teamId: 'team-a', isActive: queueActive },
        ],
        interactions: [
          { id: 'interaction-active', state: 'ACTIVE', agentId: 'agent-1', queueId: 'queue-1' },
          { id: 'interaction-wrapup', state: 'WRAPUP', agentId: 'agent-1', queueId: 'queue-1' },
        ],
        audit: [],
      }),
    });
  });
  await page.route('**/api/v1/workspace/supervisor/agents/agent-2/state', async (route) => {
    agentCommand = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    agentState = 'BREAK';
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ agentId: 'agent-2', state: 'BREAK', reason: 'Scheduled break' }),
    });
  });
  await page.route('**/api/v1/workspace/supervisor/queues/queue-1/availability', async (route) => {
    queueCommand = route.request().postDataJSON() as Record<string, unknown>;
    await new Promise((resolve) => setTimeout(resolve, 100));
    queueActive = true;
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ id: 'queue-1', isActive: true }),
    });
  });

  await page.goto('/?view=supervisor');

  await expect(page.getByRole('heading', { name: 'Supervisor Workspace' })).toBeVisible();
  const risks = page
    .getByRole('list', { name: th('supervisor:risk.listLabel') })
    .getByRole('listitem');
  await expect(risks.first()).toContainText(th('supervisor:risk.queueInactive'));
  await expect(risks.first()).toContainText('Customer Service');
  await expect(page.getByText('Somchai Jaidee')).toBeVisible();
  await expect(page.getByText('Suda Ruadreo')).toBeVisible();
  await expect(page.getByText(th('supervisor:status.sequence', { sequence: 41 }))).toBeVisible();
  await expect(
    page.getByRole('article').filter({ hasText: 'Live interactions' }).getByRole('strong'),
  ).toHaveText('2');

  await page
    .getByRole('button', { name: th('supervisor:agents.changeFor', { name: 'Suda Ruadreo' }) })
    .click();
  // #604: React Aria Select — open with the button then choose from the listbox
  await page.getByRole('button', { name: thRegExp('supervisor:confirm.newState') }).click();
  await page.getByRole('option', { name: th('supervisor:agentState.BREAK') }).click();
  await page.getByLabel(th('supervisor:confirm.reason')).fill('Scheduled break');
  await page.getByRole('button', { name: th('supervisor:confirm.agentSubmit') }).click();
  await expect(page.getByText(th('supervisor:mutation.pending'))).toBeVisible();
  await expect(page.getByText(th('supervisor:mutation.confirmed'))).toBeVisible();
  await expect(
    page
      .getByRole('listitem')
      .filter({ hasText: 'Suda Ruadreo' })
      .getByText(th('supervisor:agentState.BREAK')),
  ).toBeVisible();
  expect(agentCommand).toMatchObject({ state: 'BREAK', reason: 'Scheduled break' });
  expect(agentCommand?.commandId).toEqual(expect.any(String));

  await page
    .getByRole('button', { name: th('supervisor:queues.openFor', { name: 'Customer Service' }) })
    .click();
  await page.getByLabel(th('supervisor:confirm.reason')).fill('Open to take more calls');
  await page.getByRole('button', { name: th('supervisor:confirm.openQueueSubmit') }).click();
  await expect(page.getByText(th('supervisor:mutation.pending'))).toBeVisible();
  await expect(page.getByText(th('supervisor:mutation.confirmed'))).toBeVisible();
  expect(queueCommand).toMatchObject({ isActive: true, reason: 'Open to take more calls' });
  expect(queueCommand?.commandId).toEqual(expect.any(String));
});

test('a narrow-screen Supervisor is read-only and has no mutation controls', async ({ page }) => {
  await page.setViewportSize({ width: 600, height: 900 });
  await page.route('**/api/v1/workspace/supervisor/snapshot', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sequence: 1, agents: [], queues: [], interactions: [], audit: [] }),
    }),
  );

  await page.goto('/?view=supervisor');

  await expect(page.getByText(th('supervisor:status.narrowReadonly'))).toBeVisible();
  await expect(
    page.getByRole('button', {
      name: new RegExp(
        [
          th('supervisor:agents.change'),
          th('supervisor:queues.open'),
          th('supervisor:queues.close'),
        ]
          .map(escapeRegExp)
          .join('|'),
      ),
    }),
  ).toHaveCount(0);
});

/**
 * #604: Supervisor in the new shell — a single rail, axe, keyboard of the confirm dialog, and language switch without reload
 */
const snapshot = {
  sequence: 7,
  agents: [
    {
      id: 'agent-2',
      displayName: 'Suda Ruadreo',
      extension: '1001',
      teamId: 'team-a',
      state: 'AVAILABLE',
    },
  ],
  queues: [{ id: 'queue-1', name: 'Customer Service', teamId: 'team-a', isActive: true }],
  interactions: [],
  audit: [],
};

async function openInShell(page: Page, shellV2 = true) {
  await page.route('**/api/v1/me/navigation', (route) =>
    route.fulfill({
      status: 200,
      json: {
        groups: [{ id: 'live', labelKey: 'navigation.groups.live' }],
        apps: [
          {
            id: 'agent-workspace',
            groupId: 'live',
            labelKey: 'navigation.apps.agentWorkspace',
            hostApp: 'workspace',
            path: '/',
          },
          {
            id: 'supervisor-workspace',
            groupId: 'live',
            labelKey: 'navigation.apps.supervisorWorkspace',
            hostApp: 'workspace',
            path: '/?view=supervisor',
          },
        ],
        pins: {
          appIds: ['agent-workspace', 'supervisor-workspace'],
          source: 'SYSTEM',
          revision: 0,
        },
        limits: { maxPins: 15 },
        features: { shellV2 },
      },
    }),
  );
  await page.route('**/api/v1/workspace/supervisor/snapshot', (route) =>
    route.fulfill({ status: 200, json: snapshot }),
  );
  await page.goto('/?view=supervisor&tenant=demo');
  await expect(page.getByRole('heading', { name: 'Supervisor Workspace' })).toBeVisible();
}

async function seriousViolations(page: Page) {
  const result = await new AxeBuilder({ page }).analyze();
  return result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target).join(', ')}`);
}

test('#604 flag on: a single shell rail, no old rail/top bar/sign-out button', async ({ page }) => {
  await openInShell(page);
  await expect(page.getByRole('navigation', { name: th('ui:shell.mainNav') })).toBeVisible();
  await expect(
    page.getByRole('complementary', { name: th('supervisor:legacy.railLabel') }),
  ).toHaveCount(0);
  await expect(page.getByText('Supervisor live control')).toHaveCount(0);
  await expect(page.getByRole('button', { name: th('supervisor:status.signOut') })).toHaveCount(0);
  await expect(page.getByText(th('supervisor:status.sequence', { sequence: 7 }))).toBeVisible();
});

test('#604 flag off: keep the old rail and top bar', async ({ page }) => {
  await openInShell(page, false);
  await expect(page.getByRole('navigation', { name: th('ui:shell.mainNav') })).toHaveCount(0);
  await expect(
    page.getByRole('complementary', { name: th('supervisor:legacy.railLabel') }),
  ).toBeVisible();
  await expect(page.getByText('Supervisor live control')).toBeVisible();
});

for (const locale of ['th-TH', 'en-GB'] as const) {
  test.describe(`axe (${locale})`, () => {
    test.use({ locale });
    test(`#604 axe 0 serious/critical for the whole page and with the confirm dialog open (${locale})`, async ({
      page,
    }) => {
      await openInShell(page);
      expect(await seriousViolations(page)).toEqual([]);
      await page.getByRole('button', { name: /Suda Ruadreo/ }).click();
      await expect(page.getByRole('alertdialog')).toBeVisible();
      expect(await seriousViolations(page)).toEqual([]);
    });
  });
}

test('#604 keyboard: Esc closes the dialog, focus returns to the button that opened it, and no command is sent', async ({
  page,
}) => {
  let commands = 0;
  await page.route('**/api/v1/workspace/supervisor/queues/**', (route) => {
    commands += 1;
    return route.fulfill({ status: 200, json: {} });
  });
  await openInShell(page);
  const trigger = page.getByRole('button', {
    name: th('supervisor:queues.closeFor', { name: 'Customer Service' }),
  });
  await trigger.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('alertdialog', {
    name: th('supervisor:confirm.closeQueueTitle', { name: 'Customer Service' }),
  });
  await expect(dialog).toBeVisible();
  await expect(
    dialog.getByRole('button', { name: th('supervisor:confirm.closeQueueSubmit') }),
  ).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
  expect(commands).toBe(0);
});

test('#604 switching TH/EN in the shell does not reload and the Supervisor text changes accordingly', async ({
  page,
}) => {
  await openInShell(page);
  const before = await page.evaluate(() => performance.timeOrigin);
  await page.getByRole('button', { name: 'English' }).click();
  await expect(page.getByText('Agents in scope')).toBeVisible();
  await expect(page.getByText('Available', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: th('ui:shell.languageNames.th') }).click();
  await expect(page.getByText(th('supervisor:pulse.agents'))).toBeVisible();
  expect(await page.evaluate(() => performance.timeOrigin)).toBe(before);
});

test('#684 a Supervisor updates state from another session without a reload or opening an agent lease', async ({
  page,
}) => {
  await page.clock.install();
  let state = 'AVAILABLE';
  const leaseRequests: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/me/work-session')) leaseRequests.push(request.url());
  });
  await page.route('**/api/v1/workspace/supervisor/snapshot', (route) =>
    route.fulfill({
      json: {
        sequence: 1,
        agents: [
          {
            id: 'agent-1',
            displayName: 'Agent from other session',
            extension: '1000',
            teamId: 'team-a',
            state,
          },
        ],
        queues: [],
        interactions: [],
        audit: [],
      },
    }),
  );
  await page.goto('/?view=supervisor');
  const row = page.getByRole('listitem').filter({ hasText: 'Agent from other session' });
  await expect(row).toContainText(th('supervisor:agentState.AVAILABLE'));
  state = 'BREAK';
  await page.clock.fastForward(5_100);
  await expect(row).toContainText(th('supervisor:agentState.BREAK'));
  expect(leaseRequests).toEqual([]);
});
